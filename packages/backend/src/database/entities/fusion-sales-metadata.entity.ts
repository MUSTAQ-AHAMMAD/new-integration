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

@Entity({ name: 'FusionSalesMetadata' })
// Java key: (SUBINVENTORY, CUSTOMER_TYPE, REGION). Keying on billToName
// collapsed the per-branch service-provider rows (every branch shares e.g.
// billToName 'Hungerstation' but has its own site number).
@Unique(['subinventory', 'region', 'customerType'])
@Index(['region'])
@Index(['customerType'])
export class FusionSalesMetadata {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  billToName!: string;

  @Column({ type: 'number', transformer: bigintTransformer })
  billToAccount!: bigint;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  siteNumber!: string | null;

  @Column({ type: 'varchar2', length: 255 })
  businessUnit!: string;

  @Column({ type: 'varchar2', length: 255 })
  txnSource!: string;

  @Column({ type: 'varchar2', length: 255 })
  txnType!: string;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  rateIsCorporate!: boolean;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  recActivityNameBank!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  subinventory!: string | null;

  @Column({ type: 'varchar2', length: 255 })
  integrationSource!: string;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  distributionAccId!: bigint | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  recActivityNameCash!: string | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'varchar2', length: 255 })
  customerType!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  costCenterCode!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
