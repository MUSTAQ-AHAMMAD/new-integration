import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Validate admin credentials against environment variables.
   * Returns a signed JWT token on success, throws UnauthorizedException on failure.
   */
  login(email: string, password: string): { accessToken: string } {
    const adminEmail = this.config.get<string>('ADMIN_EMAIL');
    const adminPassword = this.config.get<string>('ADMIN_PASSWORD');

    if (!adminEmail || !adminPassword) {
      throw new UnauthorizedException(
        'Admin credentials are not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD.',
      );
    }

    if (email !== adminEmail || password !== adminPassword) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const payload = { sub: 'admin', email, role: 'ADMIN' };
    const accessToken = this.jwt.sign(payload);
    return { accessToken };
  }
}
