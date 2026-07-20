import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { SaleStatus } from '../enums';

@Entity({ name: 'SaleSyncStatus' })
@Index(['status'])
@Index(['saleDate'])
@Index(['outletId'])
export class SaleSyncStatus {
  @PrimaryColumn({ type: 'varchar2', length: 255 })
  saleId!: string;

  @PrimaryColumn({ type: 'varchar2', length: 255 })
  outletId!: string;

  @PrimaryColumn({ type: 'timestamp' })
  saleDate!: Date;

  @Column({ type: 'varchar2', length: 40 })
  status!: SaleStatus;

  @Column({ type: 'number', default: 0 })
  syncAttempts!: number;

  @Column({ type: 'timestamp', nullable: true })
  lastSyncAt!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  oracleInvoiceId!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
