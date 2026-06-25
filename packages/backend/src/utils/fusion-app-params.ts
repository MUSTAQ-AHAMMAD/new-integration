/**
 * Oracle Fusion application domain and URL-builder utilities.
 *
 * TypeScript equivalent of the Java FusionAppDomain enum and
 * FusionAppParams class used to construct Oracle Fusion Cloud URLs
 * from a hostname + server (region) pair stored in FusionCredential.
 *
 * URL anatomy:
 *   https://{hostname}.fa.{server}.oraclecloud.com/{area}/{path}
 *
 * Examples:
 *   SOAP base : https://company.fa.us6.oraclecloud.com
 *   SOAP path : /fscmService/RecInvoiceService
 *   REST base : https://company.fa.us6.oraclecloud.com/fscmRestApi/resources/11.13.18.05
 */

/** Oracle Fusion application domain identifiers. */
export enum FusionAppDomain {
  /** Supply-Chain Management domain (items, inventory). */
  SCM = 'scm',
  /** Financials domain (receivables, invoices, receipts, journals). */
  FIN = 'fin',
}

/** Default REST API version used across Oracle Fusion Cloud endpoints. */
export const FUSION_REST_API_VERSION = '11.13.18.05';

/**
 * Immutable value-object that captures the two coordinates needed to
 * build any Oracle Fusion Cloud URL: `hostname` and `server` (region).
 *
 * All URL-builder methods return fully-qualified strings; callers append
 * service- or resource-specific paths.
 */
export class FusionAppParams {
  constructor(
    /** Oracle Cloud hostname prefix, e.g. "mycompany". */
    public readonly hostname: string,
    /**
     * Oracle Cloud server/region identifier, e.g. "us6" or "fa".
     * Combined with hostname to produce "{hostname}.fa.{server}.oraclecloud.com".
     */
    public readonly server: string,
  ) {}

  /**
   * Returns the root base URL for this Oracle Fusion instance.
   *
   * @example "https://mycompany.fa.us6.oraclecloud.com"
   */
  buildBaseUrl(): string {
    return `https://${this.hostname}.fa.${this.server}.oraclecloud.com`;
  }

  /**
   * Returns the SOAP base URL (identical to the root base URL).
   * Individual SOAP service paths (e.g. `/fscmService/RecInvoiceService`)
   * are appended by the caller.
   *
   * @example "https://mycompany.fa.us6.oraclecloud.com"
   */
  buildSoapBaseUrl(): string {
    return this.buildBaseUrl();
  }

  /**
   * Returns the full path to a specific SOAP service endpoint.
   *
   * @param serviceName - Oracle service name, e.g. "RecInvoiceService".
   * @example "https://mycompany.fa.us6.oraclecloud.com/fscmService/RecInvoiceService"
   */
  buildSoapUrl(serviceName: string): string {
    return `${this.buildBaseUrl()}/fscmService/${serviceName}`;
  }

  /**
   * Returns the REST base URL for the given API version.
   *
   * @param version - REST API version string (defaults to {@link FUSION_REST_API_VERSION}).
   * @example "https://mycompany.fa.us6.oraclecloud.com/fscmRestApi/resources/11.13.18.05"
   */
  buildRestBaseUrl(version: string = FUSION_REST_API_VERSION): string {
    return `${this.buildBaseUrl()}/fscmRestApi/resources/${version}`;
  }

  /**
   * Returns the full REST URL for a specific resource.
   *
   * @param resource - Resource path, e.g. "customerProfiles".
   * @param version  - REST API version (defaults to {@link FUSION_REST_API_VERSION}).
   * @example "https://mycompany.fa.us6.oraclecloud.com/fscmRestApi/resources/11.13.18.05/customerProfiles"
   */
  buildRestUrl(
    resource: string,
    version: string = FUSION_REST_API_VERSION,
  ): string {
    return `${this.buildRestBaseUrl(version)}/${resource}`;
  }

  /**
   * Convenience factory — builds a `FusionAppParams` from a `FusionCredential`
   * DB record (or any object exposing `hostName` / `server`).
   */
  static fromCredential(cred: {
    hostName: string;
    server: string;
  }): FusionAppParams {
    return new FusionAppParams(cred.hostName, cred.server);
  }
}
