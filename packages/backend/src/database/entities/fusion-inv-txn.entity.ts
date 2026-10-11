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
export class FusionInvTxn {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'number', nullable: true })
  requestId!: number | null;

  /**
   * SUCCESS | ERROR | NEGATIVE_INVENTORY (Oracle refused: subinventory would
   * go negative — held for reprocess) | SUPERSEDED (replaced by another row).
   */
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

  /** Oracle TransactionTypeName sent ("Vend Sales Issue" / "Vend RMA"). */
  @Column({ type: 'varchar2', length: 100, nullable: true })
  txnType!: string | null;

  /**
   * Why the row is held (status NEGATIVE_INVENTORY / ERROR) — Oracle's own
   * reason, short enough for the admin grid. Cleared once the row posts.
   */
  @Column({ type: 'varchar2', length: 1000, nullable: true })
  holdReason!: string | null;

  /** Exact inventoryStagedTransactions JSON last sent, replayed on reprocess. */
  @Column({ type: 'clob', nullable: true })
  requestPayload!: string | null;

  /** How many times the row has been re-sent from the admin panel. */
  @Column({ type: 'number', nullable: true })
  retryCount!: number | null;

  @Column({ type: 'timestamp', nullable: true })
  lastRetryAt!: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
