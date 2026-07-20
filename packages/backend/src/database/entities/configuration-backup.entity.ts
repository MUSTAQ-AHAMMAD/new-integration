import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { jsonTransformer } from '../transformers';

@Entity({ name: 'ConfigurationBackup' })
@Index(['createdAt'])
export class ConfigurationBackup {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  backupReason!: string;

  @Column({ type: 'clob', transformer: jsonTransformer })
  backupData!: unknown;

  @Column({ type: 'clob', transformer: jsonTransformer })
  affectedBranches!: unknown;

  @Column({ type: 'number' })
  recordCount!: number;

  @Column({ type: 'varchar2', length: 255, default: 'SYSTEM' })
  createdBy!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;
}
