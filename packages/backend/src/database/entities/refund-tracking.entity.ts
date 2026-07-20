import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Decimal } from 'decimal.js';
import { generateId } from '../id.util';
import { booleanTransformer, decimalTransformer } from '../transformers';
import { SyncStatus } from '../enums';

@Entity({ name: 'RefundTracking' })
@Index(['originalOrderId'])
@Index(['originalInvoiceNumber'])
@Index(['creditMemoStatus'])
@Index(['isReconciled'])
export class RefundTracking {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  originalOrderId!: string;

  @Column({ type: 'varchar2', length: 255 })
  originalOrderNumber!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  originalInvoiceNumber!: string | null;

  @Index({ unique: true })
  @Column({ type: 'varchar2', length: 255 })
  refundOrderId!: string;

  @Column({ type: 'varchar2', length: 255 })
  refundOrderNumber!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  branchCode!: string | null;

  @Column({
    type: 'number',
    precision: 15,
    scale: 2,
    transformer: decimalTransformer,
  })
  refundAmount!: Decimal;

  @Column({ type: 'varchar2', length: 2000 })
  refundReason!: string;

  @Column({ type: 'timestamp' })
  refundDate!: Date;

  // Nullable on Oracle: the '' sentinel the code writes becomes NULL (Oracle
  // treats empty string as NULL), so a NOT NULL column would reject it.
  @Column({ type: 'varchar2', length: 255, nullable: true })
  oracleCreditMemoNumber!: string | null;

  @Column({ type: 'varchar2', length: 40, default: SyncStatus.PENDING })
  creditMemoStatus!: SyncStatus;

  @Column({ type: 'timestamp', nullable: true })
  syncedAt!: Date | null;

  @Column({ type: 'varchar2', length: 2000, nullable: true })
  failureReason!: string | null;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isReconciled!: boolean;

  @Column({ type: 'varchar2', length: 2000, nullable: true })
  reconcileNote!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  reconciledAt!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  reconciledBy!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
