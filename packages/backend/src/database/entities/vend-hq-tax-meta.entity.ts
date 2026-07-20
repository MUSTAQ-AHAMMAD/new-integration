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
import { bigintTransformer } from '../transformers';

@Entity({ name: 'VendHqTaxMeta' })
@Unique(['taxId', 'region'])
@Index(['region'])
export class VendHqTaxMeta {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  taxId!: string;

  @Column({ type: 'varchar2', length: 255 })
  taxName!: string;

  @Column({ type: 'number', default: 1, transformer: bigintTransformer })
  version!: bigint;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  fusionName!: string | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
