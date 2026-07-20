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
import { NotificationRole } from '../enums';

@Entity({ name: 'NotificationRecipient' })
@Index(['role'])
@Index(['isActive'])
export class NotificationRecipient {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Index({ unique: true })
  @Column({ type: 'varchar2', length: 255 })
  email!: string;

  @Column({ type: 'varchar2', length: 255 })
  name!: string;

  @Column({ type: 'varchar2', length: 40 })
  role!: NotificationRole;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  receiveErrorAlerts!: boolean;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  receiveDailyReports!: boolean;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  receiveInventoryAlerts!: boolean;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  receivePaymentAlerts!: boolean;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  receiveConfigAlerts!: boolean;

  @Column({ type: 'number', default: 1 })
  escalationLevel!: number;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  backupRecipientId!: string | null;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  isActive!: boolean;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;
}
