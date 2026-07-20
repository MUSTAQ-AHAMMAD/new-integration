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
import { booleanTransformer, jsonTransformer } from '../transformers';
import { BackupVendHqLineItem } from './backup-vend-hq-line-item.entity';
import { BackupVendHqPayment } from './backup-vend-hq-payment.entity';

@Entity({ name: 'BackupVendHqSale' })
@Unique(['invoiceNumber', 'region'])
@Index(['region'])
@Index(['invoiceNumber'])
@Index(['saleNumber'])
@Index(['saleDate'])
@Index(['fusionSynced'])
export class BackupVendHqSale {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  invoiceNumber!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  saleNumber!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  outletName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  outletId!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  registerName!: string | null;

  @Column({ type: 'timestamp' })
  saleDate!: Date;

  @Column({ type: 'number', nullable: true })
  totalPrice!: number | null;

  @Column({ type: 'number', nullable: true })
  totalTax!: number | null;

  @Column({ type: 'number', nullable: true })
  totalLoyalty!: number | null;

  @Column({ type: 'number', nullable: true })
  totalPriceInclTax!: number | null;

  @Column({ type: 'number', nullable: true })
  version!: number | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  customerType!: string | null;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  rawJson!: unknown | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  fusionSynced!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  fusionSyncAt!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  fusionSyncError!: string | null;

  @OneToMany(() => BackupVendHqLineItem, (li) => li.sale)
  backupLineItems!: BackupVendHqLineItem[];

  @OneToMany(() => BackupVendHqPayment, (p) => p.sale)
  backupPayments!: BackupVendHqPayment[];
}
