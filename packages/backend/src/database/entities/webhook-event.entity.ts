import {
  BeforeInsert,
  Column,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { jsonTransformer } from '../transformers';
import { SyncStatus } from '../enums';

@Entity({ name: 'WebhookEvent' })
@Index(['eventType'])
@Index(['processingStatus'])
@Index(['receivedAt'])
export class WebhookEvent {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  eventType!: string;

  @Column({ type: 'varchar2', length: 255, default: 'ODOO' })
  sourceSystem!: string;

  @Column({ type: 'clob', transformer: jsonTransformer })
  payload!: unknown;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  receivedAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  processedAt!: Date | null;

  @Column({ type: 'varchar2', length: 40, default: SyncStatus.PENDING })
  processingStatus!: SyncStatus;

  @Column({ type: 'clob', nullable: true })
  processingError!: string | null;
}
