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

@Entity({ name: 'FusionReceiptMethod' })
@Unique(['receiptMethodName', 'region'])
@Index(['region'])
@Index(['receiptMethodName'])
export class FusionReceiptMethod {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'number', transformer: bigintTransformer })
  receiptMethodId!: bigint;

  @Column({ type: 'varchar2', length: 255 })
  receiptMethodName!: string;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  receiptIsCash!: boolean;

  @Column({ type: 'number', default: 0 })
  receiptBankCharge!: number;

  @Column({ type: 'number', default: 0 })
  receiptMethodTax!: number;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
