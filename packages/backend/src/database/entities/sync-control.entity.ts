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

@Entity({ name: 'SyncControl' })
@Unique(['serviceName', 'region'])
@Index(['enabled'])
@Index(['serviceName'])
@Index(['region'])
export class SyncControl {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  serviceName!: string;

  @Column({ type: 'varchar2', length: 255 })
  displayName!: string;

  @Column({ type: 'clob', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  region!: string | null;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  enabled!: boolean;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isRunning!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastRunAt!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  lastStatus!: string | null;

  @Column({ type: 'number', default: 0 })
  runCount!: number;

  @Column({ type: 'number', default: 0 })
  errorCount!: number;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
