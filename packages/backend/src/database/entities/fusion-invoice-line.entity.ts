import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { FusionInvoiceHeader } from './fusion-invoice-header.entity';

@Entity({ name: 'FusionInvoiceLine' })
@Index(['status'])
@Index(['region'])
@Index(['invoiceNumber'])
export class FusionInvoiceLine {
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
  invoiceNumber!: string | null;

  @Column({ type: 'number', nullable: true })
  lineNumber!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  itemNumber!: string | null;

  @Column({ type: 'clob', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  uom!: string | null;

  @Column({ type: 'number', nullable: true })
  quantity!: number | null;

  @Column({ type: 'varchar2', length: 8, default: 'AED' })
  currencyCode!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  taxCode!: string | null;

  @Column({ type: 'number', default: 1 })
  version!: number;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  salesOrder!: string | null;

  @Column({ type: 'number', nullable: true })
  salesOrderLine!: number | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'varchar2', length: 36, nullable: true })
  headerId!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;

  @ManyToOne(() => FusionInvoiceHeader, (header) => header.invoiceLines, {
    nullable: true,
  })
  @JoinColumn({ name: 'headerId' })
  header!: FusionInvoiceHeader | null;
}
