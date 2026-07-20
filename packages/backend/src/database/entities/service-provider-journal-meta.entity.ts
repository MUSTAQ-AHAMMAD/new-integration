import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { bigintTransformer, booleanTransformer } from '../transformers';

@Entity({ name: 'ServiceProviderJournalMeta' })
@Unique(['serviceProvider', 'region', 'creditDebit', 'isCash'])
@Index(['region'])
@Index(['serviceProvider'])
export class ServiceProviderJournalMeta {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'number', transformer: bigintTransformer })
  ledgerId!: bigint;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  taxGroupId!: bigint | null;

  @Column({ type: 'number', transformer: bigintTransformer })
  chartOfAccountsId!: bigint;

  @Column({ type: 'varchar2', length: 255 })
  serviceProvider!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  creditDebit!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  costIssue!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  costRma!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  company!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  account!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  department!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  productCategory!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  interCompany!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  futUsed!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  extraSegment1!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  extraSegment2!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  extraSegment3!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  jeCategory!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  jeSource!: string | null;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isCash!: boolean;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  summaryFlag!: boolean;

  @Column({ type: 'number', default: 0 })
  fixedFreightCharge!: number;

  @Column({ type: 'number', default: 0 })
  bankChargeRate!: number;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
