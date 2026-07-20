import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { booleanTransformer, jsonTransformer } from '../transformers';
import { ErrorType } from '../enums';
import { OrderSyncQueue } from './order-sync-queue.entity';

@Entity({ name: 'FailedTransaction' })
@Index(['errorType'])
@Index(['isResolved'])
@Index(['nextRetryAt'])
@Index(['createdAt'])
export class FailedTransaction {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 36, nullable: true })
  orderSyncQueueId!: string | null;

  @Column({ type: 'clob', transformer: jsonTransformer })
  originalPayload!: unknown;

  @Column({ type: 'varchar2', length: 40 })
  errorType!: ErrorType;

  @Column({ type: 'varchar2', length: 4000 })
  errorMessage!: string;

  @Column({ type: 'clob', nullable: true })
  errorStack!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  errorCode!: string | null;

  @Column({ type: 'number', default: 0 })
  retryCount!: number;

  @Column({ type: 'number', default: 3 })
  maxRetries!: number;

  @Column({ type: 'timestamp', nullable: true })
  nextRetryAt!: Date | null;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isResolved!: boolean;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  resolvedBy!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'varchar2', length: 2000, nullable: true })
  resolutionNote!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @ManyToOne(() => OrderSyncQueue, (o) => o.failedTransactions, { nullable: true })
  @JoinColumn({ name: 'orderSyncQueueId' })
  orderSyncQueue!: OrderSyncQueue | null;
}
