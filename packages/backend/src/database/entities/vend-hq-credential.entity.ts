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
import { booleanTransformer } from '../transformers';

@Entity({ name: 'VendHqCredential' })
@Index(['region'])
@Index(['active'])
export class VendHqCredential {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Index({ unique: true })
  @Column({ type: 'varchar2', length: 255 })
  domainName!: string;

  @Column({ type: 'varchar2', length: 2000 })
  personalToken!: string;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  active!: boolean;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  fusionOrgCode!: string | null;

  @Column({ type: 'number', default: 0 })
  timezoneOffset!: number;

  @Column({ type: 'varchar2', length: 255, default: 'AED' })
  currency!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  fusionTaxCode!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  businessStartDate!: Date | null;

  @Column({ type: 'number', default: 0 })
  lastSyncVersion!: number;

  @Column({ type: 'timestamp', nullable: true })
  lastSyncAt!: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
