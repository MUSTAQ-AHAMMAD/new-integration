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

@Entity({ name: 'VendHqItemMeta' })
@Unique(['itemId', 'region'])
@Index(['itemId'])
@Index(['sku'])
@Index(['region'])
@Index(['active'])
export class VendHqItemMeta {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'number', nullable: true })
  requestId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  status!: string | null;

  @Column({ type: 'clob', nullable: true })
  message!: string | null;

  @Column({ type: 'varchar2', length: 255 })
  itemId!: string;

  @Column({ type: 'number', nullable: true })
  sourceId!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  uomCode!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  handle!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  itemType!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  uomName!: string | null;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  active!: boolean;

  @Column({ type: 'varchar2', length: 255 })
  name!: string;

  @Column({ type: 'clob', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  sku!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  brandId!: string | null;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  trackInventory!: boolean;

  @Column({ type: 'number', nullable: true })
  retailPrice!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  taxId!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  requestDate!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastUpdateDate!: Date | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
