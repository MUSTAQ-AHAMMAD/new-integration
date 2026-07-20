import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { jsonTransformer } from '../transformers';
import { JobType, JobStatus } from '../enums';
import { BatchJobItem } from './batch-job-item.entity';

@Entity({ name: 'BatchJob' })
@Index(['status'])
@Index(['batchId'])
@Index(['createdAt'])
export class BatchJob {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 40 })
  jobType!: JobType;

  @Column({ type: 'varchar2', length: 255 })
  batchId!: string;

  @Column({ type: 'varchar2', length: 40 })
  status!: JobStatus;

  @Column({ type: 'number' })
  totalRecords!: number;

  @Column({ type: 'number', default: 0 })
  processedRecords!: number;

  @Column({ type: 'number', default: 0 })
  successCount!: number;

  @Column({ type: 'number', default: 0 })
  failedCount!: number;

  @Column({ type: 'number', default: 0 })
  lastCheckpoint!: number;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  checkpointData!: unknown | null;

  @Column({ type: 'timestamp', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  estimatedCompletion!: Date | null;

  @Column({ type: 'clob', transformer: jsonTransformer })
  parameters!: unknown;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  errorSummary!: unknown | null;

  @Column({ type: 'varchar2', length: 255 })
  createdBy!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @OneToMany(() => BatchJobItem, (i) => i.batchJob)
  batchItems!: BatchJobItem[];
}
