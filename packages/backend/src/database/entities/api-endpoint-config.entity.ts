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

@Entity({ name: 'ApiEndpointConfig' })
@Index(['service'])
@Index(['isActive'])
@Index(['region'])
export class ApiEndpointConfig {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  service!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar2', length: 255 })
  name!: string;

  @Column({ type: 'varchar2', length: 2000 })
  path!: string;

  @Column({ type: 'varchar2', length: 255, default: 'GET' })
  method!: string;

  @Column({ type: 'clob', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  apiVersion!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  region!: string | null;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
