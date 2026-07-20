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

@Entity({ name: 'OpencartSite' })
@Index(['branchCode'])
@Index(['isActive'])
export class OpencartSite {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Index({ unique: true })
  @Column({ type: 'varchar2', length: 255 })
  siteCode!: string;

  @Column({ type: 'varchar2', length: 255 })
  siteName!: string;

  @Column({ type: 'varchar2', length: 2000 })
  baseUrl!: string;

  @Column({ type: 'varchar2', length: 2000 })
  apiKey!: string;

  @Column({ type: 'varchar2', length: 255 })
  branchCode!: string;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  isActive!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastSyncedAt!: Date | null;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  syncSettings!: unknown | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
