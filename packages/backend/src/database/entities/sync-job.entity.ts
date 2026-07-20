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
import { jsonTransformer } from '../transformers';
import { JobType, ScopeType, JobStatus } from '../enums';

@Entity({ name: 'SyncJob' })
@Index(['status'])
@Index(['jobType'])
@Index(['createdAt'])
export class SyncJob {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 40 })
  jobType!: JobType;

  @Column({ type: 'varchar2', length: 40 })
  scopeType!: ScopeType;

  @Column({ type: 'clob', transformer: jsonTransformer })
  scopeValue!: unknown;

  @Column({ type: 'varchar2', length: 40, default: JobStatus.PENDING })
  status!: JobStatus;

  @Column({ type: 'number', default: 0 })
  totalRecords!: number;

  @Column({ type: 'number', default: 0 })
  processedRecords!: number;

  @Column({ type: 'number', default: 0 })
  successCount!: number;

  @Column({ type: 'number', default: 0 })
  failedCount!: number;

  @Column({ type: 'number', default: 0 })
  skippedCount!: number;

  @Column({ type: 'number', default: 0 })
  retryCount!: number;

  @Column({ type: 'number', default: 3 })
  maxRetries!: number;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'varchar2', length: 255, default: 'SYSTEM' })
  createdBy!: string;

  @Column({ type: 'clob', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  errorDetails!: unknown | null;
}
