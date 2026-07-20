import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { generateId } from '../id.util';

@Entity({ name: 'BackupVendHqPromotion' })
@Index(['region'])
@Index(['invoiceNumber'])
export class BackupVendHqPromotion {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 255 })
  invoiceNumber!: string;

  @Column({ type: 'number', nullable: true })
  lineNumber!: number | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  name!: string | null;

  @Column({ type: 'number', nullable: true })
  amount!: number | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'timestamp' })
  saleDate!: Date;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;
}
