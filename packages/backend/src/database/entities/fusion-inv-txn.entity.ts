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

@Entity({ name: 'FusionInvTxn' })
@Index(['status'])
@Index(['region'])
@Index(['itemNumber'])
@Index(['sourceLineRef'])
@Index(['txnInterfaceId'])
export class FusionInvTxn {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'number', nullable: true })
  requestId!: number | null;

  @Column({ type: 'varchar2', length: 255, default: 'PENDING' })
  status!: string;

  @Column({ type: 'clob', nullable: true })
  message!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  requestDate!: Date | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  organizationName!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  itemNumber!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  txnSourceName!: string | null;

  /**
   * Per-line idempotency key: `<salesOrder>#<salesOrderLine>`. Uniquely
   * identifies the source POS line so a line's inventory is pushed to Oracle
   * exactly once (never twice) and never aggregated across lines — a re-run
   * skips only the lines already recorded SUCCESS here.
   */
  @Column({ type: 'varchar2', length: 300, nullable: true })
  sourceLineRef!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  subInventory!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  txnUom!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  txnDate!: Date | null;

  @Column({ type: 'number', nullable: true })
  txnQty!: number | null;

  @Column({ type: 'varchar2', length: 255 })
  region!: string;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  integMode!: string | null;

  /**
   * The TransactionInterfaceId we sent to Oracle's staging interface.
   *
   * Oracle processes that interface asynchronously, so accepting the POST
   * proves only that the row was queued — a negative-balance rejection lands on
   * the interface row minutes later and never comes back on the original call.
   * Keeping the id is what lets the verifier go back and ask what became of it.
   */
  @Column({ type: 'number', nullable: true })
  txnInterfaceId!: number | null;

  /** When Oracle's own answer was read back (SUCCESS or ERROR confirmed). */
  @Column({ type: 'timestamp', nullable: true })
  verifiedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
