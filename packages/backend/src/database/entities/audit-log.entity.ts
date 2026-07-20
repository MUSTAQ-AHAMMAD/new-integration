import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { jsonTransformer } from '../transformers';
import { AuditOperation, AuditStatus } from '../enums';

@Entity({ name: 'AuditLog' })
@Index(['externalId'])
@Index(['status'])
@Index(['syncDate'])
@Index(['createdAt'])
@Index(['oracleResponseId'])
export class AuditLog {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Index({ unique: true })
  @Column({ type: 'varchar2', length: 255 })
  idempotencyKey!: string;

  @Column({ type: 'varchar2', length: 255 })
  externalId!: string;

  @Column({ type: 'varchar2', length: 255 })
  externalSystem!: string;

  @Column({ type: 'varchar2', length: 255 })
  targetSystem!: string;

  @Column({ type: 'varchar2', length: 40 })
  operation!: AuditOperation;

  @Column({ type: 'varchar2', length: 40 })
  status!: AuditStatus;

  @Column({ type: 'clob', transformer: jsonTransformer })
  requestPayload!: unknown;

  @Column({ type: 'clob', nullable: true, transformer: jsonTransformer })
  responsePayload!: unknown | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  oracleResponseId!: string | null;

  @Column({ type: 'clob', nullable: true })
  errorMessage!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  errorCode!: string | null;

  @Column({ type: 'number' })
  processingDurationMs!: number;

  @Column({ type: 'number', default: 1 })
  attempts!: number;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @Column({ type: 'timestamp', name: 'sync_date' })
  syncDate!: Date;
}
