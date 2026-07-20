import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { bigintTransformer, booleanTransformer, jsonTransformer } from '../transformers';
import { ValidationStatus } from '../enums';

@Entity({ name: 'StoreConfiguration' })
@Index(['validationStatus'])
@Index(['isActive'])
@Index(['region'])
@Index(['odooBranchId'])
export class StoreConfiguration {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Index({ unique: true })
  @Column({ type: 'varchar2', length: 255 })
  branchCode!: string;

  @Column({ type: 'varchar2', length: 255 })
  branchName!: string;

  @Column({ type: 'number', transformer: bigintTransformer })
  odooBranchId!: bigint;

  @Column({ type: 'number', transformer: bigintTransformer })
  oracleOperatingUnitId!: bigint;

  @Column({ type: 'varchar2', length: 255 })
  oracleBusinessUnit!: string;

  @Column({ type: 'varchar2', length: 255 })
  billToSiteName!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  billToLocation!: string | null;

  @Column({ type: 'varchar2', length: 255 })
  bankAccountName!: string;

  @Column({ type: 'varchar2', length: 255 })
  cashAccountName!: string;

  @Column({ type: 'varchar2', length: 255 })
  paymentTermsName!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  taxClassificationCode!: string | null;

  @Column({ type: 'varchar2', length: 255, default: 'Manual' })
  transactionSource!: string;

  @Column({ type: 'varchar2', length: 255, default: 'PASA CONSULTING SALE' })
  transactionType!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  creditMemoTransactionType!: string | null;

  @Column({ type: 'varchar2', length: 8, default: 'AED' })
  invoiceCurrencyCode!: string;

  @Column({ type: 'varchar2', length: 16, nullable: true })
  region!: string | null;

  @Column({ type: 'number', nullable: true })
  bankAccountId!: number | null;

  @Column({ type: 'number', nullable: true })
  cashAccountId!: number | null;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  serviceProviderJournalMapping!: unknown | null;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  txnQuantityDecimals!: unknown | null;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  isActive!: boolean;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  allowNegativeInventory!: boolean;

  // Column name shortened to fit Oracle 12.1's 30-byte identifier limit
  // (property name kept for code compatibility).
  @Column({
    name: 'autoCreateMissingPayMethods',
    type: 'number',
    precision: 1,
    default: 0,
    transformer: booleanTransformer,
  })
  autoCreateMissingPaymentMethods!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastValidatedAt!: Date | null;

  @Column({ type: 'varchar2', length: 40, default: ValidationStatus.PENDING })
  validationStatus!: ValidationStatus;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  validationErrors!: unknown | null;

  @Column({ type: 'number', default: 1 })
  version!: number;

  @Column({ type: 'varchar2', length: 255 })
  createdBy!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
