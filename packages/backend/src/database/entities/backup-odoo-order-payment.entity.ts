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
import { BackupOdooOrder } from './backup-odoo-order.entity';

@Entity({ name: 'BackupOdooOrderPayment' })
@Index(['orderId'])
@Index(['parentOrderId'])
export class BackupOdooOrderPayment {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'number' })
  orderId!: number;

  @Column({ type: 'number', nullable: true })
  paymentId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  paymentName!: string | null;

  @Column({ type: 'number', nullable: true })
  amount!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  currency!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  paymentDate!: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @Column({ type: 'varchar2', length: 36, nullable: true })
  parentOrderId!: string | null;

  @ManyToOne(() => BackupOdooOrder, (o) => o.orderPayments, { nullable: true })
  @JoinColumn({ name: 'parentOrderId' })
  order!: BackupOdooOrder | null;
}
