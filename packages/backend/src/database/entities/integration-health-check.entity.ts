import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { ServiceName, HealthStatus } from '../enums';

@Entity({ name: 'IntegrationHealthCheck' })
@Index(['serviceName'])
@Index(['status'])
@Index(['createdAt'])
export class IntegrationHealthCheck {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 40 })
  serviceName!: ServiceName;

  @Column({ type: 'varchar2', length: 40 })
  status!: HealthStatus;

  @Column({ type: 'number' })
  responseTimeMs!: number;

  @Column({ type: 'timestamp' })
  lastSuccessAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastFailureAt!: Date | null;

  @Column({ type: 'clob', nullable: true })
  failureReason!: string | null;

  @Column({ type: 'number', default: 0 })
  consecutiveFailures!: number;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;
}
