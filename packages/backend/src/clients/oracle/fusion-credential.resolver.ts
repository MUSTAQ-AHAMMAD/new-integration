/**
 * FusionCredentialResolver — resolves Oracle Fusion Cloud connection settings
 * from the `FusionCredential` database table, with env-var fallback.
 *
 * This service is the TypeScript equivalent of the Java pattern where
 * FusionAppDomain + FusionAppParams are combined with the persisted
 * FusionCredential record to produce fully-qualified Oracle Cloud URLs and
 * Basic-Auth headers.
 *
 * Resolution order (per call):
 *   1. Look up the active FusionCredential row in the database.
 *   2. If found, use FusionAppParams to build the base URLs and derive
 *      Basic-Auth credentials from the stored username/password.
 *   3. If not found (no row / none active), fall back to environment
 *      variables: ORACLE_SOAP_BASE_URL / ORACLE_REST_BASE_URL /
 *      ORACLE_USERNAME / ORACLE_PASSWORD.
 *   4. Return null when neither source provides a non-empty base URL.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { FusionAppParams } from '../../utils/fusion-app-params';
import { Credential } from '../auth/credential';

/** Fully-resolved Oracle connection settings. */
export interface OracleConnectionSettings {
  /** Base URL for Oracle Fusion SOAP calls (no trailing slash). */
  soapBaseUrl: string;
  /** Base URL for Oracle Fusion REST calls including the API-version segment. */
  restBaseUrl: string;
  /** Plain-text Oracle username (used by callers that need raw credentials). */
  username: string;
  /** Plain-text Oracle password. */
  password: string;
  /** Ready-to-use Basic-Auth Authorization header value. */
  authorizationHeader: string;
  /** Source from which settings were resolved. */
  source: 'database' | 'environment';
}

@Injectable()
export class FusionCredentialResolver {
  private readonly logger = new Logger(FusionCredentialResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Resolves Oracle Fusion connection settings.
   *
   * Returns `null` when neither the database nor environment variables contain
   * a non-empty base URL; callers should skip Oracle API calls in that case.
   */
  async resolveOracleConnectionSettings(): Promise<OracleConnectionSettings | null> {
    // ── 1. Try database first ────────────────────────────────────────────────
    const dbCredential = await this.loadDbCredential();
    if (dbCredential) {
      const params = FusionAppParams.fromCredential(dbCredential);
      const credential = new Credential(
        dbCredential.username,
        dbCredential.password,
      );
      this.logger.debug(
        `Oracle credentials resolved from database: hostname=${dbCredential.hostName} server=${dbCredential.server}`,
      );
      return {
        soapBaseUrl: params.buildSoapBaseUrl(),
        restBaseUrl: params.buildRestBaseUrl(),
        username: dbCredential.username,
        password: dbCredential.password,
        authorizationHeader: credential.toAuthHeader(),
        source: 'database',
      };
    }

    // ── 2. Fall back to environment variables ────────────────────────────────
    const soapBaseUrl = this.configService.get<string>(
      'ORACLE_SOAP_BASE_URL',
      '',
    );
    const restBaseUrl = this.configService.get<string>(
      'ORACLE_REST_BASE_URL',
      '',
    );
    const username = this.configService.get<string>('ORACLE_USERNAME', '');
    const password = this.configService.get<string>('ORACLE_PASSWORD', '');

    if (!soapBaseUrl && !restBaseUrl) {
      this.logger.warn(
        'No Oracle credentials found in database or environment variables',
      );
      return null;
    }

    const credential = new Credential(username, password);
    this.logger.debug('Oracle credentials resolved from environment variables');
    return {
      soapBaseUrl,
      restBaseUrl,
      username,
      password,
      authorizationHeader: credential.toAuthHeader(),
      source: 'environment',
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async loadDbCredential(): Promise<{
    hostName: string;
    server: string;
    username: string;
    password: string;
  } | null> {
    try {
      return await this.prisma.fusionCredential.findFirst({
        where: { active: true },
        select: {
          hostName: true,
          server: true,
          username: true,
          password: true,
        },
      });
    } catch (err) {
      // DB might not be available during startup — degrade gracefully.
      this.logger.warn(
        `Failed to load FusionCredential from database: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
