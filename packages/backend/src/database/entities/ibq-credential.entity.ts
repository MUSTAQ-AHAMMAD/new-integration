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

@Entity({ name: 'IbqCredential' })
@Index(['region'])
@Index(['active'])
export class IbqCredential {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 2000 })
  baseUrl!: string;

  @Column({ type: 'varchar2', length: 2000 })
  apiKey!: string;

  @Column({ type: 'number', nullable: true })
  companyId!: number | null;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  active!: boolean;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  rejectUnauthorizedSsl!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastSyncAt!: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
