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
import { generateId } from '../id.util';
import { jsonTransformer } from '../transformers';
import { BackupOdooOrderLine } from './backup-odoo-order-line.entity';
import { BackupOdooOrderPayment } from './backup-odoo-order-payment.entity';

@Entity({ name: 'BackupOdooOrder' })
// orderId is already covered by its unique index below — a second index on the
// same column collides on Oracle (identical generated name).
@Index(['dateOrder'])
@Index(['state'])
@Index(['region'])
export class BackupOdooOrder {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Index({ unique: true })
  @Column({ type: 'number' })
  orderId!: number;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  orderName!: string | null;

  @Column({ type: 'number', nullable: true })
  branchId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  branchName!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  dateOrder!: Date | null;

  @Column({ type: 'number', nullable: true })
  amountTotal!: number | null;

  @Column({ type: 'number', nullable: true })
  amountUntaxed!: number | null;

  @Column({ type: 'number', nullable: true })
  amountTax!: number | null;

  @Column({ type: 'number', nullable: true })
  amountDiscount!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  state!: string | null;

  @Column({ type: 'number', nullable: true })
  partnerId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  partnerName!: string | null;

  @Column({ type: 'number', nullable: true })
  warehouseId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  warehouseName!: string | null;

  @Column({ type: 'number', nullable: true })
  posConfigId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  posConfigName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  customerType!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  timezone!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  region!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  resolvedBranchCode!: string | null;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  rawJson!: unknown | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;

  @OneToMany(() => BackupOdooOrderLine, (l) => l.order)
  orderLines!: BackupOdooOrderLine[];

  @OneToMany(() => BackupOdooOrderPayment, (p) => p.order)
  orderPayments!: BackupOdooOrderPayment[];
}
