import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'super-secret-password';

function makeService(
  email = ADMIN_EMAIL,
  password = ADMIN_PASSWORD,
): AuthService {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'ADMIN_EMAIL') return email;
      if (key === 'ADMIN_PASSWORD') return password;
      return undefined;
    }),
  } as unknown as ConfigService;

  const jwt = {
    sign: jest.fn().mockReturnValue('signed-jwt-token'),
  } as unknown as JwtService;

  return new AuthService(jwt, config);
}

describe('AuthService', () => {
  describe('login — success', () => {
    it('returns an accessToken when credentials are correct', () => {
      const service = makeService();
      const result = service.login(ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(result).toHaveProperty('accessToken', 'signed-jwt-token');
    });

    it('calls jwt.sign with the correct payload', () => {
      const config = {
        get: jest.fn((key: string) => {
          if (key === 'ADMIN_EMAIL') return ADMIN_EMAIL;
          if (key === 'ADMIN_PASSWORD') return ADMIN_PASSWORD;
          return undefined;
        }),
      } as unknown as ConfigService;
      const jwtSpy = { sign: jest.fn().mockReturnValue('tok') };
      const service = new AuthService(jwtSpy as unknown as JwtService, config);

      service.login(ADMIN_EMAIL, ADMIN_PASSWORD);

      expect(jwtSpy.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'admin',
          email: ADMIN_EMAIL,
          role: 'ADMIN',
        }),
      );
    });
  });

  describe('login — wrong credentials', () => {
    it('throws UnauthorizedException for wrong password', () => {
      const service = makeService();
      expect(() => service.login(ADMIN_EMAIL, 'wrong-password')).toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException for wrong email', () => {
      const service = makeService();
      expect(() => service.login('other@example.com', ADMIN_PASSWORD)).toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when both fields are wrong', () => {
      const service = makeService();
      expect(() => service.login('x@x.com', 'wrong')).toThrow(
        UnauthorizedException,
      );
    });

    it('does not reveal which field was wrong (same error message)', () => {
      const service = makeService();
      let wrongEmailMsg = '';
      let wrongPasswordMsg = '';
      try {
        service.login('bad@example.com', ADMIN_PASSWORD);
      } catch (e) {
        wrongEmailMsg = (e as UnauthorizedException).message;
      }
      try {
        service.login(ADMIN_EMAIL, 'bad-password');
      } catch (e) {
        wrongPasswordMsg = (e as UnauthorizedException).message;
      }
      expect(wrongEmailMsg).toBe(wrongPasswordMsg);
    });

    it('is not vulnerable to === short-circuit on different-length passwords', () => {
      // Timing-safe check: a very short wrong password should still throw,
      // not accidentally match via buffer-length bypass
      const service = makeService();
      expect(() => service.login(ADMIN_EMAIL, 'x')).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('login — missing configuration', () => {
    it('throws UnauthorizedException when ADMIN_EMAIL is not set', () => {
      const config = {
        get: jest.fn().mockReturnValue(undefined),
      } as unknown as ConfigService;
      const service = new AuthService(
        { sign: jest.fn() } as unknown as JwtService,
        config,
      );
      expect(() => service.login(ADMIN_EMAIL, ADMIN_PASSWORD)).toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when ADMIN_PASSWORD is not set', () => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'ADMIN_EMAIL' ? ADMIN_EMAIL : undefined,
        ),
      } as unknown as ConfigService;
      const service = new AuthService(
        { sign: jest.fn() } as unknown as JwtService,
        config,
      );
      expect(() => service.login(ADMIN_EMAIL, ADMIN_PASSWORD)).toThrow(
        UnauthorizedException,
      );
    });

    it('error message mentions "not configured" when env vars are missing', () => {
      const config = {
        get: jest.fn().mockReturnValue(undefined),
      } as unknown as ConfigService;
      const service = new AuthService(
        { sign: jest.fn() } as unknown as JwtService,
        config,
      );
      try {
        service.login(ADMIN_EMAIL, ADMIN_PASSWORD);
      } catch (e) {
        expect((e as UnauthorizedException).message).toContain(
          'not configured',
        );
      }
    });
  });
});
