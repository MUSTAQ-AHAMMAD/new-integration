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

@Entity({ name: 'FusionInventoryAudit' })
@Index(['vendhqSaleId'])
@Index(['productId'])
@Index(['branchCode'])
export class FusionInventoryAudit {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  vendhqSaleId!: string;

  @Column({ type: 'varchar2', length: 255 })
  productId!: string;

  @Column({ type: 'varchar2', length: 255 })
  branchCode!: string;

  @Column({
    type: 'number',
    precision: 15,
    scale: 3,
    transformer: decimalTransformer,
  })
  quantityChange!: Decimal;

  @Column({ type: 'varchar2', length: 255 })
  transactionType!: string;

  @Column({ type: 'varchar2', length: 255 })
  oracleTxnId!: string;

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
