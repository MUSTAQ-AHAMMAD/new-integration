import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { AppUser } from '../database/entities/app-user.entity';
import { AREAS, isKnownArea, resolveAreas } from '../auth/areas';
import type { UserRole } from '../auth/roles.decorator';
import {
  generateTemporaryPassword,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from '../auth/password.util';

const ROLES: UserRole[] = ['ADMIN', 'OPERATOR', 'VIEWER'];

export interface UserView {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  /** null = inherits the role defaults. */
  areaOverrides: string[] | null;
  /** What the account can actually see, after role + override are combined. */
  effectiveAreas: string[];
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  email: string;
  name?: string | null;
  password?: string;
  role: string;
  isActive?: boolean;
  areaOverrides?: string[] | null;
}

export interface UpdateUserInput {
  name?: string | null;
  role?: string;
  isActive?: boolean;
  areaOverrides?: string[] | null;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(AppUser)
    private readonly users: Repository<AppUser>,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────

  async list(): Promise<UserView[]> {
    const rows = await this.users.find({ order: { email: 'ASC' } });
    return rows.map((u) => this.toView(u));
  }

  async findById(id: string): Promise<AppUser> {
    const user = await this.users.findOne({ where: { id } });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  findByEmail(email: string): Promise<AppUser | null> {
    return this.users.findOne({ where: { email: normalizeEmail(email) } });
  }

  countActiveAdmins(excludeId?: string): Promise<number> {
    return this.users.count({
      where: {
        role: 'ADMIN',
        isActive: true,
        ...(excludeId ? { id: Not(excludeId) } : {}),
      },
    });
  }

  /** The catalogue the admin UI renders as tick-boxes. */
  areaCatalog() {
    return AREAS;
  }

  toView(user: AppUser): UserView {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      areaOverrides: user.areaOverrides ?? null,
      effectiveAreas: resolveAreas(user.role, user.areaOverrides),
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
      createdBy: user.createdBy,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  // ── Writes ───────────────────────────────────────────────────────

  async create(
    input: CreateUserInput,
    actor: string,
  ): Promise<{ user: UserView; temporaryPassword?: string }> {
    const email = normalizeEmail(input.email);
    if (!email.includes('@')) {
      throw new BadRequestException('A valid email address is required');
    }
    if (await this.findByEmail(email)) {
      throw new ConflictException(`A user with email ${email} already exists`);
    }
    this.assertRole(input.role);
    const overrides = this.normalizeOverrides(input.areaOverrides);

    // No password supplied → issue a temporary one and force a change on first
    // login, so an admin can create the account without inventing (and then
    // having to transmit) a permanent secret.
    const generated = input.password ? undefined : generateTemporaryPassword();
    const password = input.password ?? generated!;
    const weak = validatePasswordStrength(password);
    if (weak) throw new BadRequestException(weak);

    const saved = await this.users.save(
      this.users.create({
        email,
        name: input.name?.trim() || null,
        passwordHash: await hashPassword(password),
        role: input.role,
        isActive: input.isActive ?? true,
        areaOverrides: overrides,
        mustChangePassword: generated != null,
        createdBy: actor,
      }),
    );
    this.logger.log(`User ${email} (${input.role}) created by ${actor}`);
    return { user: this.toView(saved), temporaryPassword: generated };
  }

  async update(
    id: string,
    input: UpdateUserInput,
    actorId: string,
  ): Promise<UserView> {
    const user = await this.findById(id);

    if (input.role !== undefined) {
      this.assertRole(input.role);
      // Demoting the last admin would leave the dashboard unadministrable, and
      // the only way back would be a database edit.
      if (user.role === 'ADMIN' && input.role !== 'ADMIN') {
        await this.assertNotLastAdmin(user.id, 'change the role of');
      }
      user.role = input.role;
    }

    if (input.isActive !== undefined) {
      if (user.id === actorId && input.isActive === false) {
        throw new BadRequestException('You cannot deactivate your own account');
      }
      if (user.role === 'ADMIN' && input.isActive === false) {
        await this.assertNotLastAdmin(user.id, 'deactivate');
      }
      user.isActive = input.isActive;
    }

    if (input.name !== undefined) user.name = input.name?.trim() || null;
    if (input.areaOverrides !== undefined) {
      user.areaOverrides = this.normalizeOverrides(input.areaOverrides);
    }

    const saved = await this.users.save(user);
    this.logger.log(`User ${saved.email} updated by ${actorId}`);
    return this.toView(saved);
  }

  async remove(id: string, actorId: string): Promise<{ deleted: true }> {
    const user = await this.findById(id);
    if (user.id === actorId) {
      throw new BadRequestException('You cannot delete your own account');
    }
    if (user.role === 'ADMIN') {
      await this.assertNotLastAdmin(user.id, 'delete');
    }
    await this.users.delete({ id });
    this.logger.log(`User ${user.email} deleted by ${actorId}`);
    return { deleted: true };
  }

  /** Admin-issued reset. Returns the new password so it can be handed over once. */
  async resetPassword(
    id: string,
    newPassword: string | undefined,
    actorId: string,
  ): Promise<{ temporaryPassword: string }> {
    const user = await this.findById(id);
    const password = newPassword ?? generateTemporaryPassword();
    const weak = validatePasswordStrength(password);
    if (weak) throw new BadRequestException(weak);

    user.passwordHash = await hashPassword(password);
    user.mustChangePassword = true;
    await this.users.save(user);
    this.logger.log(`Password for ${user.email} reset by ${actorId}`);
    return { temporaryPassword: password };
  }

  /** Self-service change; requires the current password. */
  async changeOwnPassword(
    id: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: true }> {
    const user = await this.findById(id);
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new BadRequestException('Current password is incorrect');
    }
    const weak = validatePasswordStrength(newPassword);
    if (weak) throw new BadRequestException(weak);
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new BadRequestException(
        'New password must differ from the current one',
      );
    }

    user.passwordHash = await hashPassword(newPassword);
    user.mustChangePassword = false;
    await this.users.save(user);
    return { changed: true };
  }

  async recordLogin(id: string): Promise<void> {
    await this.users.update({ id }, { lastLoginAt: new Date() });
  }

  /**
   * Promotes the ADMIN_EMAIL/ADMIN_PASSWORD pair into a real row the first time
   * it is used, so the bootstrap admin shows up in user management like anyone
   * else instead of being an invisible account nobody can manage.
   */
  async ensureBootstrapAdmin(
    email: string,
    password: string,
  ): Promise<AppUser> {
    const normalized = normalizeEmail(email);
    const existing = await this.findByEmail(normalized);
    if (existing) return existing;

    const saved = await this.users.save(
      this.users.create({
        email: normalized,
        name: 'Bootstrap Admin',
        passwordHash: await hashPassword(password),
        role: 'ADMIN',
        isActive: true,
        areaOverrides: null,
        mustChangePassword: false,
        createdBy: 'system:bootstrap',
      }),
    );
    this.logger.log(
      `Bootstrap admin ${normalized} provisioned from ADMIN_EMAIL/ADMIN_PASSWORD`,
    );
    return saved;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private assertRole(role: string): void {
    if (!ROLES.includes(role as UserRole)) {
      throw new BadRequestException(
        `Invalid role "${role}". Expected one of: ${ROLES.join(', ')}`,
      );
    }
  }

  private normalizeOverrides(
    overrides: string[] | null | undefined,
  ): string[] | null {
    if (overrides === undefined || overrides === null) return null;
    const unknown = overrides.filter((k) => !isKnownArea(k));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Unknown area key(s): ${unknown.join(', ')}`,
      );
    }
    // An empty selection means "inherit the role" rather than "see nothing" —
    // an account with zero areas can log in but land on a blank shell, which
    // reads as a broken dashboard rather than a deliberate restriction.
    const unique = [...new Set(overrides)];
    return unique.length === 0 ? null : unique;
  }

  private async assertNotLastAdmin(id: string, verb: string): Promise<void> {
    if ((await this.countActiveAdmins(id)) === 0) {
      throw new BadRequestException(
        `Cannot ${verb} the last active administrator`,
      );
    }
  }
}
