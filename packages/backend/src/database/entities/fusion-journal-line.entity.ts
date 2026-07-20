import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { bigintTransformer } from '../transformers';
import { FusionJournalHeader } from './fusion-journal-header.entity';

@Entity({ name: 'FusionJournalLine' })
@Index(['status'])
@Index(['region'])
@Index(['jeHeaderId'])
export class FusionJournalLine {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'number', nullable: true })
  requestId!: number | null;

  @Column({ type: 'varchar2', length: 255, default: 'PENDING' })
  status!: string;

  @Column({ type: 'clob', nullable: true })
  message!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  requestDate!: Date | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'number', nullable: true })
  jeHeaderId!: number | null;

  @Column({ type: 'number', nullable: true })
  jeLineNum!: number | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  ledgerId!: bigint | null;

  @Column({ type: 'number', nullable: true })
  groupId!: number | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  chartOfAccountsId!: bigint | null;

  @Column({ type: 'number', nullable: true })
  enteredCrAmount!: number | null;

  @Column({ type: 'number', nullable: true })
  accountedCr!: number | null;

  @Column({ type: 'number', nullable: true })
  enteredDrAmount!: number | null;

  @Column({ type: 'number', nullable: true })
  accountedDr!: number | null;

  @Column({ type: 'number', nullable: true })
  currencyConversionRate!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  periodName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  accountingPeriodName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  userJeSourceName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  userJeCategoryName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  segment1!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  segment2!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  segment3!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  segment4!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  segment5!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  segment6!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  segment7!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  segment8!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  segment9!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  segment10!: string | null;

  @Column({ type: 'varchar2', length: 8, default: 'AED' })
  currencyCode!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  taxCode!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  recordType!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  accountingDate!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  transactionDate!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  salesOrder!: string | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  txnNumber!: bigint | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  customerType!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  cashCredit!: string | null;

  @Column({ type: 'varchar2', length: 36, nullable: true })
  headerId!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;

  @ManyToOne(() => FusionJournalHeader, (header) => header.journalLines, {
    nullable: true,
  })
  @JoinColumn({ name: 'headerId' })
  header!: FusionJournalHeader | null;
}
