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
import { booleanTransformer } from '../transformers';

@Entity({ name: 'ServiceProviderJournalMapping' })
@Unique(['branchCode', 'serviceProvider'])
@Index(['branchCode'])
@Index(['serviceProvider'])
export class ServiceProviderJournalMapping {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  branchCode!: string;

  @Column({ type: 'varchar2', length: 255 })
  serviceProvider!: string;

  @Column({ type: 'varchar2', length: 255 })
  glAccountDebit!: string;

  @Column({ type: 'varchar2', length: 255 })
  glAccountCredit!: string;

  @Column({ type: 'clob', nullable: true })
  description!: string | null;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
