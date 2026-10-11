import {
  BeforeInsert,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { generateId } from '../id.util';
import { booleanTransformer } from '../transformers';

/**
 * Per-region schedule + cut-off for the automatic integration run, and the
 * scheduler's own health record (last tick, last run, consecutive failures),
 * so an operator can see at a glance whether automation is actually working.
 *
 * Times are the REGION's local wall clock (the timezone the daily invoice uses
 * for business days), not the server's.
 */
@Entity({ name: 'IntegrationSchedule' })
@Unique(['region'])
export class IntegrationSchedule {
  @PrimaryColumn({ type: 'varchar2', length: 36 })
  id!: string;

  @BeforeInsert()
  assignId(): void {
    if (!this.id) this.id = generateId();
  }

  @Column({ type: 'varchar2', length: 20 })
  region!: string;

  /** Local time the automatic run fires each day ("HH:mm"). */
  @Column({ type: 'varchar2', length: 5, default: '03:00' })
  runTime!: string;

  /**
   * Local cut-off ("HH:mm"): business day D is CLOSED — and only then posted —
   * once the clock passes this time on day D+1. Late sales keyed to D before
   * the cut-off are therefore always on D's single invoice.
   */
  @Column({ type: 'varchar2', length: 5, default: '02:00' })
  cutoffTime!: string;

  /** How many closed days each run (re)checks — catch-up + retry window. */
  @Column({ type: 'number', default: 2 })
  lookbackDays!: number;

  /** AUTOMATIC = only outlets with INTEG_MODE AUTOMATIC; ALL = manual too. */
  @Column({ type: 'varchar2', length: 20, default: 'AUTOMATIC' })
  outletMode!: string;

  @Column({
    type: 'number',
    precision: 1,
    default: 0,
    transformer: booleanTransformer,
  })
  postIfPullFails!: boolean;

  @Column({
    type: 'number',
    precision: 1,
    default: 1,
    transformer: booleanTransformer,
  })
  alertOnFailure!: boolean;

  /** Raise a "stalled" alert when no successful run for this many hours. */
  @Column({ type: 'number', default: 26 })
  staleAfterHours!: number;

  // ── Scheduler state (written by the automation, read-only in the UI) ──────

  /** Local date (YYYY-MM-DD) the scheduled run last fired — once per day. */
  @Column({ type: 'varchar2', length: 10, nullable: true })
  lastScheduledDate!: string | null;

  /** Last time the scheduler evaluated this region (heartbeat). */
  @Column({ type: 'timestamp', nullable: true })
  lastTickAt!: Date | null;

  @Column({ type: 'varchar2', length: 36, nullable: true })
  lastRunJobId!: string | null;

  @Column({ type: 'varchar2', length: 40, nullable: true })
  lastRunSource!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastRunStartedAt!: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  lastRunFinishedAt!: Date | null;

  /** COMPLETED | PARTIAL | FAILED | NOT_STARTED | RUNNING | NOTHING_TO_DO */
  @Column({ type: 'varchar2', length: 30, nullable: true })
  lastRunStatus!: string | null;

  /** "YYYY-MM-DD → YYYY-MM-DD" business days the last run covered. */
  @Column({ type: 'varchar2', length: 30, nullable: true })
  lastRunWindow!: string | null;

  @Column({ type: 'varchar2', length: 1000, nullable: true })
  lastRunSummary!: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastSuccessAt!: Date | null;

  @Column({ type: 'number', default: 0 })
  consecutiveFailures!: number;

  @Column({ type: 'clob', nullable: true })
  lastError!: string | null;

  @Column({ type: 'varchar2', length: 255, nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
