import { Injectable, Logger } from '@nestjs/common';
import { AlertSeverity, AlertType, ValidationStatus } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';

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
    private readonly prisma: PrismaService,
    private readonly alertsService: AlertsService,
  ) {}

  async validateOrder(
    odooOrderId: string,
    branchCode: string,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const order = await this.prisma.orderSyncQueue.findUnique({
      where: { odooOrderId_branchCode: { odooOrderId, branchCode } },
    });

    if (!order) {
      errors.push(`Order ${odooOrderId} not found in sync queue`);
      return { isValid: false, errors, warnings, holdForNegativeInventory: false };
    }

    if (!order.isPaid) {
      errors.push('Order is not paid/posted - draft orders must not be synced');
    }

    if (order.isCancelled) {
      errors.push('Order is cancelled');
    }

    const storeConfig = await this.prisma.storeConfiguration.findUnique({
      where: { branchCode },
    });

    if (!storeConfig) {
      errors.push(`No store configuration found for branch: ${branchCode}`);
    } else if (!storeConfig.isActive) {
      errors.push(`Store ${branchCode} is inactive`);
    } else if (storeConfig.validationStatus === ValidationStatus.INVALID) {
      errors.push(`Store ${branchCode} has invalid configuration`);
    } else if (storeConfig.validationStatus === ValidationStatus.PARTIAL) {
      warnings.push(
        `Store ${branchCode} has partial configuration; sync will continue with caution`,
      );
    }

    // Negative inventory: fire a structured alert with SKU details and hold the order.
    if (order.negativeInventoryFlag) {
      const skuList = Array.isArray(order.negativeInventoryItems)
        ? (order.negativeInventoryItems as Array<{ sku: string; quantity: number }>)
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

    return { isValid: errors.length === 0, errors, warnings, holdForNegativeInventory: false };
  }
}
