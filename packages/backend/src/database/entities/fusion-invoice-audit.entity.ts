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
import { AuditStatus } from '../enums';

@Entity({ name: 'FusionInvoiceAudit' })
@Index(['vendhqSaleId'])
@Index(['oracleInvoiceId'])
@Index(['invoiceDate'])
@Index(['status'])
export class FusionInvoiceAudit {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  vendhqSaleId!: string;

  @Column({ type: 'varchar2', length: 255 })
  vendhqSaleNumber!: string;

  @Column({ type: 'varchar2', length: 255 })
  oracleInvoiceId!: string;

  @Column({ type: 'varchar2', length: 255 })
  invoiceNumber!: string;

  @Column({
    type: 'number',
    precision: 15,
    scale: 2,
    transformer: decimalTransformer,
  })
  invoiceAmount!: Decimal;

  @Column({ type: 'timestamp' })
  invoiceDate!: Date;

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
