import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { booleanTransformer } from '../transformers';
import { AlertType, AlertSeverity } from '../enums';

@Entity({ name: 'AlertLog' })
@Index(['alertType'])
@Index(['severity'])
@Index(['isResolved'])
@Index(['createdAt'])
export class AlertLog {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 40 })
  alertType!: AlertType;

  @Column({ type: 'varchar2', length: 40 })
  severity!: AlertSeverity;

  @Column({ type: 'varchar2', length: 255 })
  title!: string;

  @Column({ type: 'clob' })
  message!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  relatedEntityId!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  relatedEntityType!: string | null;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isResolved!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  resolvedBy!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;
}
