import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { hashPassword } from './password.util';
import { AppUser } from '../database/entities/app-user.entity';

const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'super-secret-password';

interface Harness {
  service: AuthService;
  jwt: { sign: jest.Mock };
  users: {
    findByEmail: jest.Mock;
    recordLogin: jest.Mock;
    ensureBootstrapAdmin: jest.Mock;
    changeOwnPassword: jest.Mock;
  };
}

function makeService(
  opts: {
    email?: string | undefined;
    password?: string | undefined;
    dbUser?: Partial<AppUser> | null;
    lookupThrows?: boolean;
  } = {},
): Harness {
  // `in` rather than a default value: the tests pass `undefined` deliberately
  // to model an unset env var, and a destructuring default would silently
  // restore it.
  const email = 'email' in opts ? opts.email : ADMIN_EMAIL;
  const password = 'password' in opts ? opts.password : ADMIN_PASSWORD;

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'ADMIN_EMAIL') return email;
      if (key === 'ADMIN_PASSWORD') return password;
      return undefined;
    }),
  } as unknown as ConfigService;

  const jwt = { sign: jest.fn().mockReturnValue('signed-jwt-token') };

  const users = {
    findByEmail: jest.fn(() =>
      opts.lookupThrows
        ? Promise.reject(new Error('ORA-00942: table does not exist'))
        : Promise.resolve(opts.dbUser ?? null),
    ),
    recordLogin: jest.fn().mockResolvedValue(undefined),
    ensureBootstrapAdmin: jest
      .fn()
      .mockResolvedValue({ id: 'bootstrap-id', email: ADMIN_EMAIL }),
    changeOwnPassword: jest.fn().mockResolvedValue({ changed: true }),
  };

  return {
    service: new AuthService(
      jwt as unknown as JwtService,
      config,
      users as unknown as UsersService,
    ),
    jwt,
    users,
  };
}

async function makeDbUser(
  overrides: Partial<AppUser> & { plainPassword?: string } = {},
): Promise<Partial<AppUser>> {
  const { plainPassword = 'db-user-password-1', ...rest } = overrides;
  return {
    id: 'user-1',
    email: 'operator@example.com',
    name: 'Ops',
    passwordHash: await hashPassword(plainPassword),
    role: 'OPERATOR',
    isActive: true,
    areaOverrides: null,
    mustChangePassword: false,
    ...rest,
  };
}

describe('AuthService', () => {
  describe('login — database accounts', () => {
    it('signs a token for a valid account and records the login', async () => {
      const dbUser = await makeDbUser();
      const { service, users } = makeService({ dbUser });

      const result = await service.login(
        'operator@example.com',
        'db-user-password-1',
      );

      expect(result.accessToken).toBe('signed-jwt-token');
      expect(result.user.role).toBe('OPERATOR');
      expect(users.recordLogin).toHaveBeenCalledWith('user-1');
    });

    it('puts the resolved areas in the token so the guard needs no DB read', async () => {
      const dbUser = await makeDbUser({ areaOverrides: ['reports', 'audit'] });
      const { service, jwt } = makeService({ dbUser });

      await service.login('operator@example.com', 'db-user-password-1');

      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-1',
          role: 'OPERATOR',
          areas: ['reports', 'audit'],
        }),
      );
    });

    it('rejects a wrong password without falling through to the env admin', async () => {
      const dbUser = await makeDbUser({ email: ADMIN_EMAIL });
      const { service } = makeService({ dbUser });

      await expect(service.login(ADMIN_EMAIL, ADMIN_PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a deactivated account with a distinguishable message', async () => {
      const dbUser = await makeDbUser({ isActive: false });
      const { service } = makeService({ dbUser });

      await expect(
        service.login('operator@example.com', 'db-user-password-1'),
      ).rejects.toThrow(/deactivated/i);
    });

    it('still signs in when the last-login write fails', async () => {
      const dbUser = await makeDbUser();
      const { service, users } = makeService({ dbUser });
      users.recordLogin.mockRejectedValueOnce(new Error('DB write failed'));

      await expect(
        service.login('operator@example.com', 'db-user-password-1'),
      ).resolves.toHaveProperty('accessToken', 'signed-jwt-token');
    });
  });

  describe('login — bootstrap admin fallback', () => {
    it('returns an accessToken when env credentials are correct', async () => {
      const { service } = makeService();
      const result = await service.login(ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(result).toHaveProperty('accessToken', 'signed-jwt-token');
    });

    it('materialises the env admin into AppUser on first use', async () => {
      const { service, users } = makeService();
      await service.login(ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(users.ensureBootstrapAdmin).toHaveBeenCalledWith(
        ADMIN_EMAIL,
        ADMIN_PASSWORD,
      );
    });

    it('signs the admin in even when the AppUser table is missing', async () => {
      const { service, users } = makeService({ lookupThrows: true });
      users.ensureBootstrapAdmin.mockRejectedValueOnce(
        new Error('ORA-00942: table does not exist'),
      );

      const result = await service.login(ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(result.accessToken).toBe('signed-jwt-token');
      expect(result.user.role).toBe('ADMIN');
    });

    it('grants an admin every area by default', async () => {
      const { service } = makeService();
      const result = await service.login(ADMIN_EMAIL, ADMIN_PASSWORD);
      expect(result.user.areas).toContain('admin.users');
      expect(result.user.areas).toContain('reconciliation');
    });
  });

  describe('login — wrong credentials', () => {
    it('throws UnauthorizedException for wrong password', async () => {
      const { service } = makeService();
      await expect(
        service.login(ADMIN_EMAIL, 'wrong-password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException for wrong email', async () => {
      const { service } = makeService();
      await expect(
        service.login('other@example.com', ADMIN_PASSWORD),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('does not reveal which field was wrong (same error message)', async () => {
      const { service } = makeService();
      let wrongEmailMsg = '';
      let wrongPasswordMsg = '';
      try {
        await service.login('bad@example.com', ADMIN_PASSWORD);
      } catch (e) {
        wrongEmailMsg = (e as UnauthorizedException).message;
      }
      try {
        await service.login(ADMIN_EMAIL, 'bad-password');
      } catch (e) {
        wrongPasswordMsg = (e as UnauthorizedException).message;
      }
      expect(wrongEmailMsg).toBe(wrongPasswordMsg);
    });

    it('is not vulnerable to === short-circuit on different-length passwords', async () => {
      const { service } = makeService();
      await expect(service.login(ADMIN_EMAIL, 'x')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('login — missing configuration', () => {
    it('throws UnauthorizedException when ADMIN_EMAIL is not set', async () => {
      const { service } = makeService({ email: undefined });
      await expect(service.login(ADMIN_EMAIL, ADMIN_PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when ADMIN_PASSWORD is not set', async () => {
      const { service } = makeService({ password: undefined });
      await expect(service.login(ADMIN_EMAIL, ADMIN_PASSWORD)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('error message mentions "not configured" when env vars are missing', async () => {
      const { service } = makeService({
        email: undefined,
        password: undefined,
      });
      await expect(service.login(ADMIN_EMAIL, ADMIN_PASSWORD)).rejects.toThrow(
        /not configured/,
      );
    });
  });

  describe('me', () => {
    it('reflects a permission change made since the token was issued', async () => {
      const dbUser = await makeDbUser({ areaOverrides: ['health'] });
      const { service } = makeService({ dbUser });

      const profile = await service.me({
        sub: 'user-1',
        email: 'operator@example.com',
        role: 'OPERATOR',
        areas: ['reports', 'audit'],
      });

      expect(profile.areas).toEqual(['health']);
    });

    it('falls back to role defaults for a token with no matching row', async () => {
      const { service } = makeService({ dbUser: null });

      const profile = await service.me({
        sub: 'admin',
        email: 'ghost@example.com',
        role: 'VIEWER',
      });

      expect(profile.areas).toContain('dashboard');
      expect(profile.areas).not.toContain('admin.users');
    });

    it('rejects a token whose account was deactivated', async () => {
      const dbUser = await makeDbUser({ isActive: false });
      const { service } = makeService({ dbUser });

      await expect(
        service.me({
          sub: 'user-1',
          email: 'operator@example.com',
          role: 'OPERATOR',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
