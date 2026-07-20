import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { generateId } from '../id.util';
import { jsonTransformer } from '../transformers';
import { BackupIbqOrderLine } from './backup-ibq-order-line.entity';
import { BackupIbqOrderPayment } from './backup-ibq-order-payment.entity';

@Entity({ name: 'BackupIbqOrder' })
@Unique(['orderId', 'region'])
@Index(['region'])
@Index(['orderId'])
@Index(['dateOrder'])
@Index(['state'])
export class BackupIbqOrder {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'number' })
  orderId!: number;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  orderName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  posReference!: string | null;

  @Column({ type: 'number', nullable: true })
  companyId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  companyName!: string | null;

  @Column({ type: 'number', nullable: true })
  branchId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  branchName!: string | null;

  @Column({ type: 'number', nullable: true })
  posConfigId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  posConfigName!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  dateOrder!: Date | null;

  @Column({ type: 'number', nullable: true })
  amountTotal!: number | null;

  @Column({ type: 'number', nullable: true })
  amountTax!: number | null;

  @Column({ type: 'number', nullable: true })
  amountPaid!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  state!: string | null;

  @Column({ type: 'number', nullable: true })
  partnerId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  partnerName!: string | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  rawJson!: unknown | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @OneToMany(() => BackupIbqOrderLine, (l) => l.order)
  orderLines!: BackupIbqOrderLine[];

  @OneToMany(() => BackupIbqOrderPayment, (p) => p.order)
  orderPayments!: BackupIbqOrderPayment[];
}
