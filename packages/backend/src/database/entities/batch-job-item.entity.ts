import {
  BeforeInsert,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { JobStatus } from '../enums';
import { BatchJob } from './batch-job.entity';

@Entity({ name: 'BatchJobItem' })
@Index(['batchJobId'])
@Index(['status'])
@Index(['externalId'])
export class BatchJobItem {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 36 })
  batchJobId!: string;

  @Column({ type: 'varchar2', length: 255 })
  externalId!: string;

  @Column({ type: 'number' })
  sequence!: number;

  @Column({ type: 'varchar2', length: 40 })
  status!: JobStatus;

  @Column({ type: 'clob', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  processedAt!: Date | null;

  @ManyToOne(() => BatchJob, (b) => b.batchItems, { nullable: true })
  @JoinColumn({ name: 'batchJobId' })
  batchJob!: BatchJob | null;
}
