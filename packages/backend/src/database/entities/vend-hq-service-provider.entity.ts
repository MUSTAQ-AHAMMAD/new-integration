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

@Entity({ name: 'VendHqServiceProvider' })
// A provider exists per region, sometimes with several VendHQ customers
// (e.g. cash and non-cash HUNGERSTATION).
@Index(['serviceProvider', 'region', 'vendHqCustomerId'], { unique: true })
@Index(['region'])
// No separate serviceProvider index: the composite unique index above leads
// with it (a second index on the same column collides on Oracle).
export class VendHqServiceProvider {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'varchar2', length: 255 })
  serviceProvider!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  vendHqCustomerId!: string | null;

  @Column({ type: 'number', precision: 1, default: 0, transformer: booleanTransformer })
  isCash!: boolean;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
