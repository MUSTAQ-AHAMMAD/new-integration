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

@Entity({ name: 'FusionCredential' })
@Index(['active'])
export class FusionCredential {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Index({ unique: true })
  @Column({ type: 'varchar2', length: 255 })
  hostName!: string;

  @Column({ type: 'varchar2', length: 255 })
  server!: string;

  @Column({ type: 'varchar2', length: 255 })
  username!: string;

  @Column({ type: 'varchar2', length: 2000 })
  password!: string;

  @Column({ type: 'number', precision: 1, default: 1, transformer: booleanTransformer })
  active!: boolean;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
