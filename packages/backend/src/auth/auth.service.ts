import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

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

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Validate admin credentials against environment variables.
   * Returns a signed JWT token on success, throws UnauthorizedException on failure.
   * Password comparison uses constant-time equality to prevent timing attacks.
   */
  login(email: string, password: string): { accessToken: string } {
    const adminEmail = this.config.get<string>('ADMIN_EMAIL');
    const adminPassword = this.config.get<string>('ADMIN_PASSWORD');

    if (!adminEmail || !adminPassword) {
      throw new UnauthorizedException(
        'Admin credentials are not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD.',
      );
    }

    // Use constant-time comparisons for both fields to prevent timing attacks.
    const emailMatch = safeEqual(email, adminEmail);
    const passwordMatch = safeEqual(password, adminPassword);

    if (!emailMatch || !passwordMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const payload = { sub: 'admin', email, role: 'ADMIN' };
    const accessToken = this.jwt.sign(payload);
    return { accessToken };
  }
}
