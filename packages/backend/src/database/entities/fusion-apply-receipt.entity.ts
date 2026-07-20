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
import { decimalTransformer } from '../transformers';

@Entity({ name: 'FusionApplyReceipt' })
@Index(['status'])
@Index(['region'])
@Index(['receiptNumber'])
export class FusionApplyReceipt {
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

  @Column({ type: 'timestamp', nullable: true })
  accountingDate!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  applicationDate!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  txnNumber!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  receiptNumber!: string | null;

  @Column({
    type: 'number',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: decimalTransformer,
  })
  amountApplied!: Decimal | null;

  @Column({ type: 'varchar2', length: 8, default: 'AED' })
  currencyCode!: string;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  integMode!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  txnSource!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
