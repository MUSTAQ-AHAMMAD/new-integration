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
import { bigintTransformer, decimalTransformer } from '../transformers';

@Entity({ name: 'FusionStandardReceipt' })
@Index(['status'])
@Index(['region'])
@Index(['receiptNumber'])
export class FusionStandardReceipt {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'number', nullable: true })
  requestId!: number | null;

  @Column({ type: 'varchar2', length: 255, default: 'PENDING' })
  status!: string;

  @Column({ type: 'clob', nullable: true })
  message!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  requestDate!: Date | null;

  @Column({ type: 'varchar2', length: 8, default: 'AED' })
  currencyCode!: string;

  @Column({ type: 'timestamp', nullable: true })
  receiptDate!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  glDate!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  exchangeDate!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  exchangeRateType!: string | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  receiptMethodId!: bigint | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  receiptNumber!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  remittanceBankAccId!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  depositDate!: Date | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  customerId!: bigint | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  accountValue!: string | null;

  @Column({ type: 'number', nullable: true, transformer: decimalTransformer })
  receiptAmount!: Decimal | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  orgId!: bigint | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  integMode!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
