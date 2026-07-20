import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Decimal } from 'decimal.js';
import { generateId } from '../id.util';
import { booleanTransformer, decimalTransformer, jsonTransformer } from '../transformers';
import { SyncStatus } from '../enums';
import { FailedTransaction } from './failed-transaction.entity';

@Entity({ name: 'OrderSyncQueue' })
@Unique(['odooOrderId', 'branchCode'])
@Index(['status'])
@Index(['branchCode'])
@Index(['orderDate'])
@Index(['orderDateUtc'])
@Index(['isPaid'])
@Index(['isRefund'])
export class OrderSyncQueue {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  odooOrderId!: string;

  @Column({ type: 'varchar2', length: 255 })
  odooOrderNumber!: string;

  @Column({ type: 'varchar2', length: 255 })
  branchCode!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  branchName!: string | null;

  @Column({ type: 'timestamp' })
  orderDate!: Date;

  @Column({ type: 'timestamp' })
  orderDateUtc!: Date;

  @Column({ type: 'varchar2', length: 64 })
  originalTimezone!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  customerName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  customerEmail!: string | null;

  @Column({
    type: 'number',
    precision: 15,
    scale: 2,
    transformer: decimalTransformer,
  })
  totalAmount!: Decimal;

  @Column({ type: 'varchar2', length: 8, default: 'AED' })
  currency!: string;

  @Column({ type: 'varchar2', length: 40, default: SyncStatus.PENDING })
  status!: SyncStatus;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  validationErrors!: unknown | null;

  @Column({ type: 'number', default: 0 })
  syncAttempts!: number;

  @Column({ type: 'timestamp', nullable: true })
  lastSyncAt!: Date | null;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isPaid!: boolean;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isCancelled!: boolean;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isRefund!: boolean;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  refundReferenceId!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  oracleInvoiceNumber!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  oracleCreditMemoNumber!: string | null;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  negativeInventoryFlag!: boolean;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  negativeInventoryItems!: unknown | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;

  @OneToMany(() => FailedTransaction, (ft) => ft.orderSyncQueue)
  failedTransactions!: FailedTransaction[];
}
