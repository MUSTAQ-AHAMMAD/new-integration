import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { booleanTransformer, jsonTransformer } from '../transformers';

/**
 * A dashboard login. Replaces the single ADMIN_EMAIL/ADMIN_PASSWORD env pair
 * with real, per-person accounts so access can be granted and revoked without
 * a redeploy.
 *
 * `areaOverrides` is the visibility control: `null` means "inherit whatever the
 * role grants" (the common case), while an array pins the exact set of areas
 * this person may see. Storing the override separately from the role keeps the
 * role meaningful — demoting someone to VIEWER still narrows them even if an
 * override was set earlier and later cleared.
 */
@Entity({ name: 'AppUser' })
@Index(['role'])
@Index(['isActive'])
export class AppUser {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  /** Always stored lower-cased and trimmed — email is an identifier, not a secret. */
  @Index({ unique: true })
  @Column({ type: 'varchar2', length: 255 })
  email!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  name!: string | null;

  /** scrypt digest, self-describing: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`. */
  @Column({ type: 'varchar2', length: 512 })
  passwordHash!: string;

  /** 'ADMIN' | 'OPERATOR' | 'VIEWER' — see UserRole in auth/roles.decorator. */
  @Column({ type: 'varchar2', length: 40, default: 'VIEWER' })
  role!: string;

  @Column({
    type: 'number',
    precision: 1,
    default: 1,
    transformer: booleanTransformer,
  })
  isActive!: boolean;

  /** Explicit area-key list, or null to inherit the role defaults. */
  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  areaOverrides!: string[] | null;

  @Column({
    type: 'number',
    precision: 1,
    default: 0,
    transformer: booleanTransformer,
  })
  mustChangePassword!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
