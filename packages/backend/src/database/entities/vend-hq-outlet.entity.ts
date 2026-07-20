import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { bigintTransformer } from '../transformers';
import { VendHqRegister } from './vend-hq-register.entity';

@Entity({ name: 'VendHqOutlet' })
@Unique(['outletId', 'region'])
@Index(['region'])
export class VendHqOutlet {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  outletId!: string;

  @Column({ type: 'varchar2', length: 255 })
  outletName!: string;

  @Column({ type: 'varchar2', length: 255, default: 'AED' })
  currency!: string;

  @Column({ type: 'number', default: 1, transformer: bigintTransformer })
  version!: bigint;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;

  @OneToMany(() => VendHqRegister, (r) => r.outlet)
  registers!: VendHqRegister[];
}
