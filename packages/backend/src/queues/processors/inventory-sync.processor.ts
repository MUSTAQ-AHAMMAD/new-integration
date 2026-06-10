import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { AlertSeverity, AlertType, SyncStatus } from '@prisma/client';
import { Job } from 'bull';
import { AlertsService } from '../../alerts/alerts.service';
import { GatewayService } from '../../gateway/gateway.service';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUE_NAMES } from '../queues.module';

@Processor(QUEUE_NAMES.INVENTORY_SYNC)
export class InventorySyncProcessor {
  private readonly logger = new Logger(InventorySyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alertsService: AlertsService,
    private readonly gateway: GatewayService,
  ) {}

  @Process({ name: 'sync', concurrency: 5 })
  async handleInventorySync(job: Job<{ trackerId: string }>) {
    this.logger.log(`Processing inventory sync: ${job.data.trackerId}`);
    const tracker = await this.prisma.inventorySyncTracker.findUnique({
      where: { id: job.data.trackerId },
    });

    if (!tracker) {
      return;
    }

    if (tracker.isNegativeInventory && !tracker.negativeInventoryAlertSent) {
      await this.alertsService.createAlert({
        alertType: AlertType.NEGATIVE_INVENTORY,
        severity: AlertSeverity.WARNING,
        title: 'Negative inventory warning',
        message: `Negative inventory detected for ${tracker.productSku} in branch ${tracker.branchCode}. Sync continued.`,
        relatedEntityId: tracker.id,
        relatedEntityType: 'INVENTORY_SYNC_TRACKER',
      });
    }

    await this.prisma.inventorySyncTracker.update({
      where: { id: tracker.id },
      data: {
        syncStatus: SyncStatus.SYNCED,
        syncedAt: new Date(),
        negativeInventoryAlertSent:
          tracker.isNegativeInventory || tracker.negativeInventoryAlertSent,
      },
    });

    this.gateway.emitAlert({
      type: tracker.isNegativeInventory
        ? 'NEGATIVE_INVENTORY'
        : 'INVENTORY_SYNC',
      severity: tracker.isNegativeInventory ? 'WARNING' : 'INFO',
      message: `Inventory sync completed for ${tracker.productSku}`,
    });
  }
}
