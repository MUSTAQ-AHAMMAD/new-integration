import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { UsersService } from './users.service';
import { AppUser } from '../database/entities/app-user.entity';
import { hashPassword, verifyPassword } from '../auth/password.util';

jest.setTimeout(30000);

interface RepoMock {
  find: jest.Mock;
  findOne: jest.Mock;
  count: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
}

function makeRepo(rows: Partial<AppUser>[] = []): RepoMock {
  const store = [...rows];
  return {
    find: jest.fn().mockResolvedValue(store),
    findOne: jest.fn(({ where }: { where: Partial<AppUser> }) =>
      Promise.resolve(
        store.find((u) =>
          Object.entries(where).every(
            ([k, v]) => (u as Record<string, unknown>)[k] === v,
          ),
        ) ?? null,
      ),
    ),
    count: jest.fn().mockResolvedValue(1),
    create: jest.fn((v: Partial<AppUser>) => ({ id: 'generated-id', ...v })),
    save: jest.fn((v: Partial<AppUser>) =>
      Promise.resolve({
        createdAt: new Date(),
        updatedAt: new Date(),
        ...v,
      }),
    ),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
}

function makeService(rows: Partial<AppUser>[] = []) {
  const repo = makeRepo(rows);
  return {
    repo,
    service: new UsersService(repo as unknown as Repository<AppUser>),
  };
}

const baseUser: Partial<AppUser> = {
  id: 'user-1',
  email: 'ops@example.com',
  name: 'Ops',
  role: 'OPERATOR',
  isActive: true,
  areaOverrides: null,
  mustChangePassword: false,
  lastLoginAt: null,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('UsersService.create', () => {
  it('lower-cases the email so logins are not case-sensitive', async () => {
    const { service, repo } = makeService();
    await service.create(
      { email: '  Ops@Example.COM ', role: 'VIEWER' },
      'admin@example.com',
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ops@example.com' }),
    );
  });

  it('issues a temporary password and forces a change when none is given', async () => {
    const { service } = makeService();
    const result = await service.create(
      { email: 'new@example.com', role: 'VIEWER' },
      'admin@example.com',
    );
    expect(result.temporaryPassword).toBeDefined();
    expect(result.user.mustChangePassword).toBe(true);
  });

  it('does not force a change when the admin supplied the password', async () => {
    const { service } = makeService();
    const result = await service.create(
      { email: 'new@example.com', role: 'VIEWER', password: 'chosen-pass-1' },
      'admin@example.com',
    );
    expect(result.temporaryPassword).toBeUndefined();
    expect(result.user.mustChangePassword).toBe(false);
  });

  it('stores a hash, never the password itself', async () => {
    const { service, repo } = makeService();
    await service.create(
      { email: 'new@example.com', role: 'VIEWER', password: 'chosen-pass-1' },
      'admin@example.com',
    );
    const created = repo.create.mock.calls[0][0] as AppUser;
    expect(created.passwordHash).not.toContain('chosen-pass-1');
    await expect(
      verifyPassword('chosen-pass-1', created.passwordHash),
    ).resolves.toBe(true);
  });

  it('rejects a duplicate email', async () => {
    const { service } = makeService([baseUser]);
    await expect(
      service.create({ email: 'ops@example.com', role: 'VIEWER' }, 'admin'),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects an unknown role', async () => {
    const { service } = makeService();
    await expect(
      service.create({ email: 'new@example.com', role: 'ROOT' }, 'admin'),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a weak password', async () => {
    const { service } = makeService();
    await expect(
      service.create(
        { email: 'new@example.com', role: 'VIEWER', password: 'short' },
        'admin',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects an unknown area key rather than silently dropping it', async () => {
    const { service } = makeService();
    await expect(
      service.create(
        {
          email: 'new@example.com',
          role: 'VIEWER',
          areaOverrides: ['reports', 'made-up'],
        },
        'admin',
      ),
    ).rejects.toThrow(/Unknown area/);
  });
});

describe('UsersService.update', () => {
  it('reports the effective areas after an override', async () => {
    const { service } = makeService([baseUser]);
    const updated = await service.update(
      'user-1',
      { areaOverrides: ['reports'] },
      'admin-id',
    );
    expect(updated.effectiveAreas).toEqual(['reports']);
  });

  it('clears an override back to the role defaults with null', async () => {
    const { service } = makeService([
      { ...baseUser, areaOverrides: ['reports'] },
    ]);
    const updated = await service.update(
      'user-1',
      { areaOverrides: null },
      'admin-id',
    );
    expect(updated.areaOverrides).toBeNull();
    expect(updated.effectiveAreas.length).toBeGreaterThan(1);
  });

  it('refuses to let an admin deactivate themselves', async () => {
    const { service } = makeService([{ ...baseUser, role: 'ADMIN' }]);
    await expect(
      service.update('user-1', { isActive: false }, 'user-1'),
    ).rejects.toThrow(/your own account/);
  });

  it('refuses to demote the last active admin', async () => {
    const { service, repo } = makeService([{ ...baseUser, role: 'ADMIN' }]);
    repo.count.mockResolvedValue(0);
    await expect(
      service.update('user-1', { role: 'VIEWER' }, 'someone-else'),
    ).rejects.toThrow(/last active administrator/);
  });

  it('allows demoting an admin while another admin remains', async () => {
    const { service, repo } = makeService([{ ...baseUser, role: 'ADMIN' }]);
    repo.count.mockResolvedValue(1);
    await expect(
      service.update('user-1', { role: 'VIEWER' }, 'someone-else'),
    ).resolves.toMatchObject({ role: 'VIEWER' });
  });

  it('404s for an unknown id', async () => {
    const { service } = makeService();
    await expect(
      service.update('nope', { name: 'x' }, 'admin'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('UsersService.remove', () => {
  it('refuses to delete your own account', async () => {
    const { service } = makeService([baseUser]);
    await expect(service.remove('user-1', 'user-1')).rejects.toThrow(
      /your own account/,
    );
  });

  it('refuses to delete the last admin', async () => {
    const { service, repo } = makeService([{ ...baseUser, role: 'ADMIN' }]);
    repo.count.mockResolvedValue(0);
    await expect(service.remove('user-1', 'other')).rejects.toThrow(
      /last active administrator/,
    );
  });

  it('deletes an ordinary account', async () => {
    const { service, repo } = makeService([baseUser]);
    await expect(service.remove('user-1', 'admin-id')).resolves.toEqual({
      deleted: true,
    });
    expect(repo.delete).toHaveBeenCalledWith({ id: 'user-1' });
  });
});

describe('UsersService password flows', () => {
  it('forces a change after an admin reset', async () => {
    const { service, repo } = makeService([baseUser]);
    const { temporaryPassword } = await service.resetPassword(
      'user-1',
      undefined,
      'admin-id',
    );
    expect(temporaryPassword).toBeTruthy();
    const saved = repo.save.mock.calls[0][0] as AppUser;
    expect(saved.mustChangePassword).toBe(true);
  });

  it('changes a password when the current one is right', async () => {
    const user = {
      ...baseUser,
      passwordHash: await hashPassword('old-pass-1'),
    };
    const { service, repo } = makeService([user]);

    await expect(
      service.changeOwnPassword('user-1', 'old-pass-1', 'new-pass-2'),
    ).resolves.toEqual({ changed: true });

    const saved = repo.save.mock.calls[0][0] as AppUser;
    expect(saved.mustChangePassword).toBe(false);
    await expect(
      verifyPassword('new-pass-2', saved.passwordHash),
    ).resolves.toBe(true);
  });

  it('rejects a change when the current password is wrong', async () => {
    const user = {
      ...baseUser,
      passwordHash: await hashPassword('old-pass-1'),
    };
    const { service } = makeService([user]);
    await expect(
      service.changeOwnPassword('user-1', 'guessed', 'new-pass-2'),
    ).rejects.toThrow(/Current password is incorrect/);
  });

  it('rejects reusing the current password', async () => {
    const user = {
      ...baseUser,
      passwordHash: await hashPassword('old-pass-1'),
    };
    const { service } = makeService([user]);
    await expect(
      service.changeOwnPassword('user-1', 'old-pass-1', 'old-pass-1'),
    ).rejects.toThrow(/must differ/);
  });
});

describe('UsersService.ensureBootstrapAdmin', () => {
  it('creates the row on first use', async () => {
    const { service, repo } = makeService();
    await service.ensureBootstrapAdmin('Admin@Example.com', 'env-password-1');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'admin@example.com', role: 'ADMIN' }),
    );
  });

  it('reuses the existing row instead of resetting its password', async () => {
    const existing = { ...baseUser, email: 'admin@example.com', role: 'ADMIN' };
    const { service, repo } = makeService([existing]);
    const result = await service.ensureBootstrapAdmin(
      'admin@example.com',
      'env-password-1',
    );
    expect(result).toBe(existing);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
