import { Injectable } from '@nestjs/common';
import { JobStatus, SyncStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview() {
    const [
      totalOrders,
      syncedOrders,
      failedOrders,
      pendingOrders,
      processingOrders,
    ] = await Promise.all([
      this.prisma.orderSyncQueue.count(),
      this.prisma.orderSyncQueue.count({
        where: { status: SyncStatus.SYNCED },
      }),
      this.prisma.orderSyncQueue.count({
        where: { status: SyncStatus.FAILED },
      }),
      this.prisma.orderSyncQueue.count({
        where: { status: SyncStatus.PENDING },
      }),
      this.prisma.orderSyncQueue.count({
        where: { status: SyncStatus.PROCESSING },
      }),
    ]);

    const [unresolvedAlerts, activeJobs, storeCount] = await Promise.all([
      this.prisma.alertLog.count({ where: { isResolved: false } }),
      this.prisma.syncJob.count({
        where: { status: { in: [JobStatus.PENDING, JobStatus.PROCESSING] } },
      }),
      this.prisma.storeConfiguration.count({ where: { isActive: true } }),
    ]);

    const syncRate =
      totalOrders > 0 ? Math.round((syncedOrders / totalOrders) * 100) : 0;

    return {
      totalOrders,
      syncedOrders,
      failedOrders,
      pendingOrders,
      processingOrders,
      syncRate,
      unresolvedAlerts,
      activeJobs,
      storeCount,
    };
  }

  async getSyncTrend(days = 7) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    return this.prisma.orderSyncQueue.groupBy({
      by: ['status'],
      where: { createdAt: { gte: startDate } },
      _count: { id: true },
    });
  }

  async getFailedTransactions(limit = 20) {
    return this.prisma.failedTransaction.findMany({
      where: { isResolved: false },
      include: {
        orderSyncQueue: { select: { odooOrderNumber: true, branchCode: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getOrdersByBranch() {
    return this.prisma.orderSyncQueue.groupBy({
      by: ['branchCode', 'status'],
      _count: { id: true },
      orderBy: [{ branchCode: 'asc' }, { status: 'asc' }],
    });
  }

  async getRecentActivity(limit = 50) {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getHealthStatus() {
    return this.prisma.integrationHealthCheck.findMany({
      orderBy: [{ serviceName: 'asc' }, { createdAt: 'desc' }],
      distinct: ['serviceName'],
    });
  }

  async getNegativeInventory(limit = 20) {
    return this.prisma.inventorySyncTracker.findMany({
      where: { isNegativeInventory: true, negativeInventoryAlertSent: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
