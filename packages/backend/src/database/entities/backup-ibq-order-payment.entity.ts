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
import { BackupIbqOrder } from './backup-ibq-order.entity';

@Entity({ name: 'BackupIbqOrderPayment' })
@Index(['region'])
@Index(['orderId'])
@Index(['parentOrderId'])
export class BackupIbqOrderPayment {
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

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @Column({ type: 'varchar2', length: 36, nullable: true })
  parentOrderId!: string | null;

  @ManyToOne(() => BackupIbqOrder, (o) => o.orderPayments, { nullable: true })
  @JoinColumn({ name: 'parentOrderId' })
  order!: BackupIbqOrder | null;
}
