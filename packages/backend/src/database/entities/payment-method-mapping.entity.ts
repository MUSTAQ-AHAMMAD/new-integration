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

@Entity({ name: 'PaymentMethodMapping' })
@Unique(['sourceSystem', 'sourcePaymentName'])
@Index(['sourcePaymentName'])
@Index(['isActive'])
@Index(['requiresApproval'])
export class PaymentMethodMapping {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  sourceSystem!: string;

  @Column({ type: 'varchar2', length: 255 })
  sourcePaymentName!: string;

  @Column({ type: 'number', transformer: bigintTransformer })
  oracleReceiptMethodId!: bigint;

  @Column({ type: 'varchar2', length: 255 })
  oracleReceiptMethodName!: string;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  oracleBankAccountId!: bigint | null;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  isActive!: boolean;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  requiresApproval!: boolean;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  approvedBy!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'clob', nullable: true })
  rejectionReason!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
