import { Injectable, Logger } from '@nestjs/common';
import { ValidationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  constructor(private readonly prisma: PrismaService) {}

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
      return { isValid: false, errors, warnings };
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

    if (order.negativeInventoryFlag) {
      warnings.push(
        'Order contains items with negative inventory - will sync but inventory team notified',
      );
    }

    if (warnings.length > 0) {
      this.logger.warn(
        `Validation warnings for ${odooOrderId}: ${warnings.join('; ')}`,
      );
    }

    return { isValid: errors.length === 0, errors, warnings };
  }
}
