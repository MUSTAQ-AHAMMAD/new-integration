import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { Decimal } from 'decimal.js';
import { generateId } from '../id.util';
import { booleanTransformer, decimalTransformer } from '../transformers';

@Entity({ name: 'OpeningBalance' })
@Unique(['branchCode', 'accountType', 'accountCode', 'balanceDate'])
@Index(['branchCode'])
@Index(['balanceDate'])
@Index(['isReconciled'])
export class OpeningBalance {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  branchCode!: string;

  @Column({ type: 'varchar2', length: 255 })
  accountType!: string;

  @Column({ type: 'varchar2', length: 255 })
  accountCode!: string;

  @Column({ type: 'timestamp' })
  balanceDate!: Date;

  @Column({
    type: 'number',
    precision: 15,
    scale: 2,
    transformer: decimalTransformer,
  })
  balanceAmount!: Decimal;

  @Column({ type: 'varchar2', length: 8, default: 'AED' })
  currency!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  reference!: string | null;

  @Column({ type: 'clob', nullable: true })
  notes!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  reconciledWith!: string | null;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isReconciled!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  reconciledAt!: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;
}
