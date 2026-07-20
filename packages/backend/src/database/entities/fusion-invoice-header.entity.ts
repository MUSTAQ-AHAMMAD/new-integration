import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Decimal } from 'decimal.js';
import { generateId } from '../id.util';
import { bigintTransformer, decimalTransformer } from '../transformers';
import { FusionInvoiceLine } from './fusion-invoice-line.entity';

@Entity({ name: 'FusionInvoiceHeader' })
@Index(['status'])
@Index(['region'])
@Index(['requestId'])
export class FusionInvoiceHeader {
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

  @Column({ type: 'varchar2', length: 255, nullable: true })
  billToCustName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  billToLocation!: string | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  billToAccNumber!: bigint | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  businessUnit!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  paymentTermsName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  txnSource!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  txnType!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  txnDate!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  glDate!: Date | null;

  @Column({ type: 'varchar2', length: 8, default: 'AED' })
  currencyCode!: string;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  txnNumber!: bigint | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  customerTxnId!: bigint | null;

  @Column({
    type: 'number',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: decimalTransformer,
  })
  totalAmount!: Decimal | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;

  @OneToMany(() => FusionInvoiceLine, (line) => line.header)
  invoiceLines!: FusionInvoiceLine[];
}
