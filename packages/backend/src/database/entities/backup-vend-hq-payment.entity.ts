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

@Entity({ name: 'BackupVendHqPayment' })
@Index(['region'])
@Index(['invoiceNumber'])
@Index(['saleDate'])
@Index(['saleId'])
export class BackupVendHqPayment {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  invoiceNumber!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  outletName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  registerName!: string | null;

  @Column({ type: 'number', nullable: true })
  amount!: number | null;

  @Column({ type: 'varchar2', length: 255, default: 'AED' })
  currency!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  paymentType!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  paymentMethod!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  paymentDate!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'timestamp' })
  saleDate!: Date;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @Column({ type: 'varchar2', length: 36, nullable: true })
  saleId!: string | null;

  @ManyToOne(() => BackupVendHqSale, (s) => s.backupPayments, { nullable: true })
  @JoinColumn({ name: 'saleId' })
  sale!: BackupVendHqSale | null;
}
