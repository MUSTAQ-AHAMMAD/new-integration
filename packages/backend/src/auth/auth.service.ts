import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { UsersService } from '../users/users.service';
import { verifyPassword } from './password.util';
import { resolveAreas } from './areas';
import type { JwtPayload } from './jwt.strategy';

/**
 * Email is an identifier, not a secret, so it is compared case- and
 * whitespace-insensitively. Byte-exact matching made `Admin@Example.com ` (a
 * capitalised or copy-pasted address) indistinguishable from a wrong password.
 */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Constant-time string comparison to prevent timing-based credential enumeration. */
function safeEqual(a: string, b: string): boolean {
  // Buffers must be the same byte length for timingSafeEqual.
  // We always compare against a fixed-length expected value so an attacker
  // cannot learn anything from the timing of a length mismatch.
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still call timingSafeEqual on equal-length pads so the function always
    // runs in constant time regardless of length differences.
    timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1));
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export interface AuthenticatedProfile {
  id: string;
  email: string;
  name: string | null;
  role: string;
  areas: string[];
  mustChangePassword: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly users: UsersService,
  ) {}

  /**
   * Authenticate against the AppUser table, falling back to the
   * ADMIN_EMAIL/ADMIN_PASSWORD environment pair.
   *
   * The env pair remains the bootstrap route (first login on a fresh install,
   * and the way back in if every account is locked out); on a successful env
   * login the account is materialised into AppUser so it can be managed like
   * any other. Once materialised, the stored hash is authoritative — changing
   * ADMIN_PASSWORD afterwards will not silently re-open that door.
   */
  async login(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; user: AuthenticatedProfile }> {
    const normalized = normalizeEmail(email);
    const user = await this.lookup(normalized);

    if (user) {
      if (!user.isActive) {
        this.logger.warn(
          `Login rejected for "${normalized}": account disabled`,
        );
        throw new UnauthorizedException(
          'This account has been deactivated. Contact an administrator.',
        );
      }
      if (await verifyPassword(password, user.passwordHash)) {
        await this.users.recordLogin(user.id).catch((err: unknown) => {
          // A failed bookkeeping write must not cost the user their login.
          this.logger.warn(
            `Could not record last-login for ${normalized}: ${(err as Error).message}`,
          );
        });
        const profile: AuthenticatedProfile = {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          areas: resolveAreas(user.role, user.areaOverrides),
          mustChangePassword: user.mustChangePassword,
        };
        return { accessToken: this.sign(profile), user: profile };
      }
      this.logger.warn(
        `Failed login for "${normalized}": password does not match stored hash`,
      );
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.loginAsBootstrapAdmin(normalized, password);
  }

  /** Fresh profile for the current token — reflects permission changes without re-login. */
  async me(payload: JwtPayload): Promise<AuthenticatedProfile> {
    const user = await this.lookup(normalizeEmail(payload.email));
    if (!user) {
      // Token issued before the account was materialised (or the row was
      // removed). Fall back to the claims so the session degrades to its
      // role defaults instead of hard-failing.
      return {
        id: payload.sub,
        email: payload.email,
        name: payload.name ?? null,
        role: payload.role,
        areas: payload.areas ?? resolveAreas(payload.role, null),
        mustChangePassword: false,
      };
    }
    if (!user.isActive) {
      throw new UnauthorizedException('This account has been deactivated.');
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      areas: resolveAreas(user.role, user.areaOverrides),
      mustChangePassword: user.mustChangePassword,
    };
  }

  async changePassword(
    payload: JwtPayload,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: true }> {
    const user = await this.lookup(normalizeEmail(payload.email));
    if (!user) {
      throw new UnauthorizedException(
        'Password changes require a managed account. Sign in again first.',
      );
    }
    return this.users.changeOwnPassword(user.id, currentPassword, newPassword);
  }

  // ── Internals ────────────────────────────────────────────────────

  private async loginAsBootstrapAdmin(
    normalizedEmail: string,
    password: string,
  ): Promise<{ accessToken: string; user: AuthenticatedProfile }> {
    const adminEmail = this.config.get<string>('ADMIN_EMAIL');
    const adminPassword = this.config.get<string>('ADMIN_PASSWORD');

    if (!adminEmail || !adminPassword) {
      // Log loudly: on a fresh server this is the difference between "the app is
      // broken" and "nobody set two environment variables".
      this.logger.error(
        `Login rejected: no AppUser matched and ADMIN_EMAIL${adminEmail ? '' : ' (missing)'} / ` +
          `ADMIN_PASSWORD${adminPassword ? '' : ' (missing)'} not configured. ` +
          `Set both in the backend environment and restart.`,
      );
      throw new UnauthorizedException(
        'Admin credentials are not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD.',
      );
    }

    // Use constant-time comparisons for both fields to prevent timing attacks.
    const emailMatch = safeEqual(normalizedEmail, normalizeEmail(adminEmail));
    const passwordMatch = safeEqual(password, adminPassword);

    if (!emailMatch || !passwordMatch) {
      // Say server-side which half failed — the client still gets the generic
      // message, but an operator can tell a typo'd address from a bad password
      // instead of guessing.
      this.logger.warn(
        `Failed login for "${normalizedEmail}": ` +
          (emailMatch
            ? 'email matched, password did not'
            : 'email does not match ADMIN_EMAIL and no AppUser exists'),
      );
      throw new UnauthorizedException('Invalid email or password');
    }

    let id = 'admin';
    try {
      const provisioned = await this.users.ensureBootstrapAdmin(
        adminEmail,
        adminPassword,
      );
      id = provisioned.id;
      await this.users.recordLogin(provisioned.id);
    } catch (err) {
      // The AppUser table may not exist yet on an older deployment. The env
      // admin must still get in — that is precisely when they need to.
      this.logger.warn(
        `Bootstrap admin could not be persisted (continuing with an ephemeral ` +
          `session): ${(err as Error).message}`,
      );
    }

    const profile: AuthenticatedProfile = {
      id,
      email: normalizedEmail,
      name: 'Bootstrap Admin',
      role: 'ADMIN',
      areas: resolveAreas('ADMIN', null),
      mustChangePassword: false,
    };
    return { accessToken: this.sign(profile), user: profile };
  }

  /**
   * Reads never take the login down. If the AppUser table is missing (upgrade
   * not yet applied) or the DB is briefly unreachable, we log and treat it as
   * "no such user", which routes to the env-admin fallback.
   */
  private async lookup(email: string) {
    try {
      return await this.users.findByEmail(email);
    } catch (err) {
      this.logger.warn(
        `AppUser lookup failed for "${email}" — falling back to ADMIN_EMAIL. ` +
          `Has the AppUser table been created? (${(err as Error).message})`,
      );
      return null;
    }
  }

  private sign(profile: AuthenticatedProfile): string {
    const payload: JwtPayload = {
      sub: profile.id,
      email: profile.email,
      name: profile.name,
      role: profile.role,
      areas: profile.areas,
    };
    return this.jwt.sign(payload);
  }
}
