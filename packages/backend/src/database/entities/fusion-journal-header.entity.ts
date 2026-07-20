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
import { bigintTransformer, booleanTransformer } from '../transformers';
import { FusionJournalLine } from './fusion-journal-line.entity';

@Entity({ name: 'FusionJournalHeader' })
@Index(['status'])
@Index(['region'])
@Index(['ledgerId'])
export class FusionJournalHeader {
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

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  ledgerId!: bigint | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  batchName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  batchDescription!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  accountingPeriodName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  userSourceName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  userCategoryName!: string | null;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  errorToSuspenseFlag!: boolean;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  summaryFlag!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  accountingDate!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  importDescriptiveFlexField!: string | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  txnNumber!: bigint | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  integMode!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  customerType!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  cashCredit!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;

  @OneToMany(() => FusionJournalLine, (line) => line.header)
  journalLines!: FusionJournalLine[];
}
