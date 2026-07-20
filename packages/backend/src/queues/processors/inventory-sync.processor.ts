import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from 'bull';
import { AlertsService } from '../../alerts/alerts.service';
import { GatewayService } from '../../gateway/gateway.service';
import { InventorySyncTracker } from '../../database/entities/inventory-sync-tracker.entity';
import { AlertSeverity, AlertType, SyncStatus } from '../../database/enums';
import { QUEUE_NAMES } from '../queues.constants';

@Processor(QUEUE_NAMES.INVENTORY_SYNC)
export class InventorySyncProcessor {
  private readonly logger = new Logger(InventorySyncProcessor.name);

  constructor(
    @InjectRepository(InventorySyncTracker)
    private readonly trackers: Repository<InventorySyncTracker>,
    private readonly alertsService: AlertsService,
    private readonly gateway: GatewayService,
  ) {}

  @Process({ name: 'sync', concurrency: 5 })
  async handleInventorySync(job: Job<{ trackerId: string }>) {
    this.logger.log(`Processing inventory sync: ${job.data.trackerId}`);
    const tracker = await this.trackers.findOne({
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

    await this.trackers.update(tracker.id, {
      syncStatus: SyncStatus.SYNCED,
      syncedAt: new Date(),
      negativeInventoryAlertSent:
        tracker.isNegativeInventory || tracker.negativeInventoryAlertSent,
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
