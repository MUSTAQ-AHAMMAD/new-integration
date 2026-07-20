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

@Entity({ name: 'BackupOdooOrderLine' })
@Index(['orderId'])
@Index(['parentOrderId'])
export class BackupOdooOrderLine {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'number' })
  orderId!: number;

  @Column({ type: 'number', nullable: true })
  lineId!: number | null;

  @Column({ type: 'number', nullable: true })
  productId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  productName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  lineName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  productCode!: string | null;

  @Column({ type: 'number', nullable: true })
  qty!: number | null;

  @Column({ type: 'number', nullable: true })
  priceUnit!: number | null;

  @Column({ type: 'number', nullable: true })
  priceSubtotal!: number | null;

  @Column({ type: 'number', nullable: true })
  priceSubtotalIncl!: number | null;

  @Column({ type: 'number', nullable: true })
  discount!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  taxName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  taxIds!: string | null;

  @Column({ type: 'number', nullable: true })
  baseUomId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  baseUomName!: string | null;

  @Column({ type: 'number', nullable: true })
  productUomId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  productUomName!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @Column({ type: 'varchar2', length: 36, nullable: true })
  parentOrderId!: string | null;

  @ManyToOne(() => BackupOdooOrder, (o) => o.orderLines, { nullable: true })
  @JoinColumn({ name: 'parentOrderId' })
  order!: BackupOdooOrder | null;
}
