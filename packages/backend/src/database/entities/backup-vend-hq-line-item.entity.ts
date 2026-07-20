import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { BackupVendHqSale } from './backup-vend-hq-sale.entity';

@Entity({ name: 'BackupVendHqLineItem' })
@Index(['region'])
@Index(['invoiceNumber'])
@Index(['saleDate'])
@Index(['saleId'])
export class BackupVendHqLineItem {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  invoiceNumber!: string;

  @Column({ type: 'number', nullable: true })
  lineNumber!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  itemNumber!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  itemName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  productId!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  productName!: string | null;

  @Column({ type: 'number', nullable: true })
  quantity!: number | null;

  @Column({ type: 'number', nullable: true })
  loyaltyValue!: number | null;

  @Column({ type: 'number', nullable: true })
  totalPrice!: number | null;

  @Column({ type: 'number', nullable: true })
  totalTax!: number | null;

  @Column({ type: 'number', nullable: true })
  totalDiscount!: number | null;

  @Column({ type: 'number', nullable: true })
  totalLoyalty!: number | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'timestamp' })
  saleDate!: Date;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  taxName!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @Column({ type: 'varchar2', length: 36, nullable: true })
  saleId!: string | null;

  @ManyToOne(() => BackupVendHqSale, (s) => s.backupLineItems, { nullable: true })
  @JoinColumn({ name: 'saleId' })
  sale!: BackupVendHqSale | null;
}
