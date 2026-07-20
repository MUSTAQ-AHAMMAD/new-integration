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

@Entity({ name: 'FusionBusinessUnitMap' })
@Unique(['businessUnitId', 'region'])
@Index(['region'])
export class FusionBusinessUnitMap {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'number', transformer: bigintTransformer })
  businessUnitId!: bigint;

  @Column({ type: 'varchar2', length: 255 })
  businessUnitName!: string;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
