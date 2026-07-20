import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AlertSeverity, AlertType, ValidationStatus } from '../database/enums';
import { AlertsService } from '../alerts/alerts.service';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { StoreConfigService } from '../store-config/store-config.service';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  /** True when the order is otherwise valid but must be held due to negative inventory. */
  holdForNegativeInventory: boolean;
}

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(
    @InjectRepository(OrderSyncQueue)
    private readonly orders: Repository<OrderSyncQueue>,
    private readonly alertsService: AlertsService,
    private readonly storeConfigService: StoreConfigService,
  ) {}

  async validateOrder(
    odooOrderId: string,
    branchCode: string,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const order = await this.orders.findOne({
      where: { odooOrderId, branchCode },
    });

    if (!order) {
      errors.push(`Order ${odooOrderId} not found in sync queue`);
      return {
        isValid: false,
        errors,
        warnings,
        holdForNegativeInventory: false,
      };
    }

    if (!order.isPaid) {
      errors.push('Order is not paid/posted - draft orders must not be synced');
    }

    if (order.isCancelled) {
      errors.push('Order is cancelled');
    }

    // ── Store Configuration Validation with Auto-Creation ──────────────────
    this.logger.log(
      `[${odooOrderId}] Validating store configuration for branch: ${branchCode}`,
    );

    let storeConfig;
    try {
      // Use auto-creation method - this NEVER throws
      storeConfig =
        await this.storeConfigService.getOrCreateStoreConfig(branchCode);

      if (!storeConfig) {
        // This should never happen, but handle defensively
        this.logger.error(
          `[${odooOrderId}] Store config is null after getOrCreateStoreConfig`,
        );
        errors.push(
          `Failed to get or create store configuration for branch: ${branchCode}`,
        );
      } else {
        this.logger.log(
          `[${odooOrderId}] ✅ Store config obtained for branch ${branchCode} (status: ${storeConfig.validationStatus})`,
        );

        // Check configuration status
        if (!storeConfig.isActive) {
          errors.push(`Store ${branchCode} is inactive`);
        } else if (storeConfig.validationStatus === ValidationStatus.INVALID) {
          // For INVALID configs, add as error (still blocks)
          errors.push(
            `Store ${branchCode} has invalid configuration: ${JSON.stringify(storeConfig.validationErrors)}`,
          );
        } else if (
          storeConfig.validationStatus === ValidationStatus.PARTIAL ||
          storeConfig.validationStatus === ValidationStatus.PENDING
        ) {
          // For PARTIAL/PENDING configs (e.g., auto-created), add as warning (does NOT block)
          warnings.push(
            `Store ${branchCode} has ${storeConfig.validationStatus.toLowerCase()} configuration; sync will continue with caution. Please review and validate the configuration.`,
          );
        }
      }
    } catch (error) {
      // Catch any unexpected errors
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[${odooOrderId}] Error getting store config: ${errorMsg}`,
      );
      warnings.push(
        `Could not verify store configuration for branch ${branchCode}: ${errorMsg}. Continuing with sync.`,
      );
    }

    // Negative inventory: fire a structured alert with SKU details and hold the order.
    if (order.negativeInventoryFlag) {
      const skuList = Array.isArray(order.negativeInventoryItems)
        ? (
            order.negativeInventoryItems as Array<{
              sku: string;
              quantity: number;
            }>
          )
            .map((i) => `${i.sku} (qty: ${i.quantity})`)
            .join(', ')
        : 'unknown SKUs';

      await this.alertsService.createAlert({
        alertType: AlertType.NEGATIVE_INVENTORY,
        severity: AlertSeverity.WARNING,
        title: `Negative inventory detected — branch ${branchCode}`,
        message:
          `Order ${order.odooOrderNumber ?? odooOrderId} contains items with negative ` +
          `inventory in branch ${branchCode}: ${skuList}. ` +
          `Order held until Finance corrects stock. Use the retry-negative-inventory ` +
          `endpoint to re-process once resolved.`,
        relatedEntityId: order.id,
        relatedEntityType: 'ORDER_SYNC_QUEUE',
      });

      if (warnings.length > 0) {
        this.logger.warn(
          `Validation warnings for ${odooOrderId}: ${warnings.join('; ')}`,
        );
      }

      return {
        isValid: errors.length === 0,
        errors,
        warnings,
        holdForNegativeInventory: errors.length === 0,
      };
    }

    if (warnings.length > 0) {
      this.logger.warn(
        `Validation warnings for ${odooOrderId}: ${warnings.join('; ')}`,
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      holdForNegativeInventory: false,
    };
  }
}
