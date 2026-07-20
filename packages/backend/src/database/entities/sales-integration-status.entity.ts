import {
  BeforeInsert,
  Column,
  Entity,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { generateId } from '../id.util';

@Entity({ name: 'SalesIntegrationStatus' })
@Unique(['region', 'integMode'])
@Index(['region'])
@Index(['status'])
export class SalesIntegrationStatus {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'varchar2', length: 255 })
  integMode!: string;

  @Column({ type: 'varchar2', length: 255 })
  status!: string;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
