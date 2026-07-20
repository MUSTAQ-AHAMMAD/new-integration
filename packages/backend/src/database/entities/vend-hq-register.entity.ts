import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { bigintTransformer } from '../transformers';
import { VendHqOutlet } from './vend-hq-outlet.entity';

@Entity({ name: 'VendHqRegister' })
@Unique(['registerId', 'region'])
@Index(['outletId'])
@Index(['region'])
export class VendHqRegister {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  registerId!: string;

  @Column({ type: 'varchar2', length: 255 })
  outletId!: string;

  @Column({ type: 'varchar2', length: 255 })
  registerName!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  cashAccount!: string | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  cashAccountId!: bigint | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  bankAccount!: string | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  bankAccountId!: bigint | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  giftAccount!: string | null;

  @Column({ type: 'number', nullable: true, transformer: bigintTransformer })
  giftAccountId!: bigint | null;

  @Column({ type: 'number', default: 1, transformer: bigintTransformer })
  version!: bigint;

  @Column({ type: 'timestamp', nullable: true })
  deletedAt!: Date | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'varchar2', length: 36, nullable: true })
  outletPk!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;

  @ManyToOne(() => VendHqOutlet, (o) => o.registers, { nullable: true })
  @JoinColumn({ name: 'outletPk' })
  outlet!: VendHqOutlet | null;
}
