import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
} from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueuesService } from '../queues/queues.service';
import { StalledOrdersService } from '../sync/stalled-orders.service';
import { SyncStatus } from '@prisma/client';

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  private readonly ordersTotal: Counter;
  private readonly ordersByStatus: Gauge;
  private readonly syncJobsTotal: Counter;
  private readonly syncJobDuration: Histogram;
  private readonly unresolvedAlerts: Gauge;
  private readonly activeStores: Gauge;
  private readonly failedTransactionsTotal: Gauge;

  // BullMQ queue metrics
  private readonly queueWaiting: Gauge;
  private readonly queueActive: Gauge;
  private readonly queueFailed: Gauge;
  private readonly queueCompleted: Gauge;

  // Stalled-order metric
  private readonly stalledOrdersTotal: Gauge;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queuesService: QueuesService,
    private readonly stalledOrdersService: StalledOrdersService,
  ) {
    this.registry.setDefaultLabels({ app: 'integration-middleware' });
    collectDefaultMetrics({ register: this.registry });

    this.ordersTotal = new Counter({
      name: 'integration_orders_total',
      help: 'Total number of orders processed',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.ordersByStatus = new Gauge({
      name: 'integration_orders_by_status',
      help: 'Current order count by status',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.syncJobsTotal = new Counter({
      name: 'integration_sync_jobs_total',
      help: 'Total sync jobs created',
      labelNames: ['job_type', 'status'],
      registers: [this.registry],
    });

    this.syncJobDuration = new Histogram({
      name: 'integration_sync_job_duration_seconds',
      help: 'Duration of sync jobs in seconds',
      labelNames: ['job_type'],
      buckets: [1, 5, 15, 30, 60, 120, 300, 600],
      registers: [this.registry],
    });

    this.unresolvedAlerts = new Gauge({
      name: 'integration_unresolved_alerts',
      help: 'Number of unresolved alerts',
      labelNames: ['severity'],
      registers: [this.registry],
    });

    this.activeStores = new Gauge({
      name: 'integration_active_stores',
      help: 'Number of active store configurations',
      registers: [this.registry],
    });

    this.failedTransactionsTotal = new Gauge({
      name: 'integration_failed_transactions_unresolved',
      help: 'Number of unresolved failed transactions',
      registers: [this.registry],
    });

    this.queueWaiting = new Gauge({
      name: 'integration_queue_waiting',
      help: 'Number of jobs waiting in a BullMQ queue',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.queueActive = new Gauge({
      name: 'integration_queue_active',
      help: 'Number of jobs actively being processed in a BullMQ queue',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.queueFailed = new Gauge({
      name: 'integration_queue_failed',
      help: 'Number of failed jobs retained in a BullMQ queue',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.queueCompleted = new Gauge({
      name: 'integration_queue_completed',
      help: 'Number of completed jobs retained in a BullMQ queue',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.stalledOrdersTotal = new Gauge({
      name: 'integration_stalled_orders_total',
      help: `Number of orders stuck in PENDING status for more than the stale threshold`,
      registers: [this.registry],
    });
  }

  onModuleInit() {
    // Gauges are refreshed on each scrape
  }

  async getMetrics(): Promise<string> {
    await this.refreshGauges();
    return this.registry.metrics();
  }

  private async refreshGauges() {
    await Promise.allSettled([
      this.refreshOrderStats(),
      this.refreshAlertStats(),
      this.refreshStoreStats(),
      this.refreshFailedTransactionStats(),
      this.refreshQueueStats(),
      this.refreshStalledOrderStats(),
    ]);
  }

  private async refreshOrderStats() {
    const statuses = Object.values(SyncStatus);
    const counts = await Promise.all(
      statuses.map((status) =>
        this.prisma.orderSyncQueue.count({ where: { status } }),
      ),
    );
    statuses.forEach((status, i) => {
      this.ordersByStatus.set({ status }, counts[i]);
    });
  }

  private async refreshAlertStats() {
    const severities = ['INFO', 'WARNING', 'ERROR', 'CRITICAL'] as const;
    const counts = await Promise.all(
      severities.map((severity) =>
        this.prisma.alertLog.count({ where: { severity, isResolved: false } }),
      ),
    );
    severities.forEach((severity, i) => {
      this.unresolvedAlerts.set({ severity }, counts[i]);
    });
  }

  private async refreshStoreStats() {
    const count = await this.prisma.storeConfiguration.count({
      where: { isActive: true },
    });
    this.activeStores.set(count);
  }

  private async refreshFailedTransactionStats() {
    const count = await this.prisma.failedTransaction.count({
      where: { isResolved: false },
    });
    this.failedTransactionsTotal.set(count);
  }

  private async refreshQueueStats() {
    const stats = await this.queuesService.getQueueStats();

    this.queueWaiting.set({ queue: 'order-sync' }, stats.orderSync.waiting);
    this.queueActive.set({ queue: 'order-sync' }, stats.orderSync.active);
    this.queueFailed.set({ queue: 'order-sync' }, stats.orderSync.failed);
    this.queueCompleted.set({ queue: 'order-sync' }, stats.orderSync.completed);

    this.queueWaiting.set({ queue: 'inventory-sync' }, stats.inventorySync.waiting);
    this.queueActive.set({ queue: 'inventory-sync' }, stats.inventorySync.active);
    this.queueFailed.set({ queue: 'inventory-sync' }, stats.inventorySync.failed);
    this.queueCompleted.set({ queue: 'inventory-sync' }, stats.inventorySync.completed);

    this.queueWaiting.set({ queue: 'retry' }, stats.retry.waiting);
    this.queueActive.set({ queue: 'retry' }, stats.retry.active);
    this.queueFailed.set({ queue: 'retry' }, stats.retry.failed);
    this.queueCompleted.set({ queue: 'retry' }, stats.retry.completed);

    this.queueWaiting.set({ queue: 'notifications' }, stats.notifications.waiting);
    this.queueActive.set({ queue: 'notifications' }, stats.notifications.active);
    this.queueFailed.set({ queue: 'notifications' }, stats.notifications.failed);
    this.queueCompleted.set({ queue: 'notifications' }, stats.notifications.completed);
  }

  private async refreshStalledOrderStats() {
    const count = await this.stalledOrdersService.getStalledCount();
    this.stalledOrdersTotal.set(count);
  }

  recordSyncJobCreated(jobType: string, status: string) {
    this.syncJobsTotal.inc({ job_type: jobType, status });
  }

  observeSyncJobDuration(jobType: string, durationSeconds: number) {
    this.syncJobDuration.observe({ job_type: jobType }, durationSeconds);
  }

  incrementOrdersTotal(status: string) {
    this.ordersTotal.inc({ status });
  }
}
