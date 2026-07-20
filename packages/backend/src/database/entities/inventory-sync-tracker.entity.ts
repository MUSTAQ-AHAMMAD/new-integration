import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { Decimal } from 'decimal.js';
import { generateId } from '../id.util';
import { booleanTransformer, decimalTransformer } from '../transformers';
import { InventoryTransactionType, SyncStatus } from '../enums';

@Entity({ name: 'InventorySyncTracker' })
@Unique(['productId', 'branchCode', 'transactionDate', 'transactionType'])
@Index(['productId'])
@Index(['branchCode'])
@Index(['isNegativeInventory'])
@Index(['syncStatus'])
@Index(['transactionDate'])
@Index(['reviewedAt'])
export class InventorySyncTracker {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  productId!: string;

  @Column({ type: 'varchar2', length: 255 })
  productSku!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  productName!: string | null;

  @Column({ type: 'varchar2', length: 255 })
  branchCode!: string;

  @Column({ type: 'timestamp' })
  transactionDate!: Date;

  @Column({ type: 'varchar2', length: 40 })
  transactionType!: InventoryTransactionType;

  @Column({
    type: 'number',
    precision: 15,
    scale: 3,
    transformer: decimalTransformer,
  })
  previousQuantity!: Decimal;

  @Column({
    type: 'number',
    precision: 15,
    scale: 3,
    transformer: decimalTransformer,
  })
  newQuantity!: Decimal;

  @Column({
    type: 'number',
    precision: 15,
    scale: 3,
    transformer: decimalTransformer,
  })
  quantityChange!: Decimal;

  @Column({ type: 'varchar2', length: 40, default: SyncStatus.PENDING })
  syncStatus!: SyncStatus;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isNegativeInventory!: boolean;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  negativeInventoryAlertSent!: boolean;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  orderReferenceId!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  oracleTransactionId!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  reviewedAt!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  reviewedBy!: string | null;

  @Column({ type: 'clob', nullable: true })
  reviewNote!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  syncedAt!: Date | null;
}
