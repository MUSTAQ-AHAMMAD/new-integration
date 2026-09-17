import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  /** Display name, when the account has one. */
  name?: string | null;
  /**
   * Dashboard areas this session may see. Optional because tokens minted
   * before area-based visibility existed have no such claim — consumers fall
   * back to the role defaults rather than treating that as "no access".
   */
  areas?: string[];
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      if (config.get<string>('NODE_ENV') === 'production') {
        throw new Error(
          'JWT_SECRET environment variable is required in production',
        );
      }
      new Logger(JwtStrategy.name).warn(
        'JWT_SECRET is not set — using insecure default. Set JWT_SECRET before deploying to production.',
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret ?? 'changeme',
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    return payload;
  }
}
