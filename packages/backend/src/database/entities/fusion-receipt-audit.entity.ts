import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { Decimal } from 'decimal.js';
import { generateId } from '../id.util';
import { decimalTransformer } from '../transformers';
import { AuditStatus, ReceiptType } from '../enums';

@Entity({ name: 'FusionReceiptAudit' })
@Index(['vendhqSaleId'])
@Index(['oracleReceiptId'])
@Index(['receiptType'])
export class FusionReceiptAudit {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  vendhqSaleId!: string;

  @Column({ type: 'varchar2', length: 255 })
  vendhqPaymentId!: string;

  @Column({ type: 'varchar2', length: 40 })
  receiptType!: ReceiptType;

  @Column({ type: 'varchar2', length: 255 })
  oracleReceiptId!: string;

  @Column({ type: 'varchar2', length: 255 })
  receiptNumber!: string;

  @Column({
    type: 'number',
    precision: 15,
    scale: 2,
    transformer: decimalTransformer,
  })
  receiptAmount!: Decimal;

  @Column({ type: 'varchar2', length: 255 })
  paymentMethod!: string;

  @Column({ type: 'clob' })
  requestPayload!: string;

  @Column({ type: 'clob', nullable: true })
  responsePayload!: string | null;

  @Column({ type: 'varchar2', length: 40 })
  status!: AuditStatus;

  @Column({ type: 'clob', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'number' })
  processingTimeMs!: number;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;
}
