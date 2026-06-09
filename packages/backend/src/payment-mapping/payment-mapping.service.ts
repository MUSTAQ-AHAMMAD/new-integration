import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AlertSeverity, AlertType } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentMappingService {
  private readonly logger = new Logger(PaymentMappingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alertsService: AlertsService,
  ) {}

  async resolvePaymentMethod(sourceSystem: string, sourcePaymentName: string) {
    const mapping = await this.prisma.paymentMethodMapping.findUnique({
      where: {
        sourceSystem_sourcePaymentName: { sourceSystem, sourcePaymentName },
      },
    });

    if (!mapping) {
      await this.alertsService.createAlert({
        alertType: AlertType.PAYMENT_METHOD_DISCOVERED,
        severity: AlertSeverity.ERROR,
        title: 'Unmapped Payment Method Discovered',
        message: `Payment method "${sourcePaymentName}" from ${sourceSystem} has no Oracle mapping. Transaction queued pending mapping approval.`,
        relatedEntityId: sourcePaymentName,
        relatedEntityType: 'PAYMENT_METHOD',
      });

      await this.prisma.paymentMethodMapping.upsert({
        where: {
          sourceSystem_sourcePaymentName: { sourceSystem, sourcePaymentName },
        },
        create: {
          sourceSystem,
          sourcePaymentName,
          oracleReceiptMethodId: 0,
          oracleReceiptMethodName: 'PENDING_MAPPING',
          isActive: false,
          requiresApproval: true,
        },
        update: { requiresApproval: true },
      });

      throw new NotFoundException(
        `Payment method "${sourcePaymentName}" is not mapped to Oracle. Admin notified.`,
      );
    }

    if (!mapping.isActive) {
      this.logger.warn(
        `Inactive payment mapping used for ${sourcePaymentName}; returning mapping for fallback handling`,
      );
      return mapping;
    }

    if (mapping.requiresApproval && !mapping.approvedAt) {
      this.logger.warn(
        `Payment method ${sourcePaymentName} still requires approval; returning mapping as fallback`,
      );
      return mapping;
    }

    return mapping;
  }

  async listMappings(sourceSystem?: string) {
    return this.prisma.paymentMethodMapping.findMany({
      where: sourceSystem ? { sourceSystem } : undefined,
      orderBy: { sourcePaymentName: 'asc' },
    });
  }

  async approvePendingMapping(id: string, approvedBy: string) {
    return this.prisma.paymentMethodMapping.update({
      where: { id },
      data: {
        requiresApproval: false,
        isActive: true,
        approvedBy,
        approvedAt: new Date(),
      },
    });
  }

  async createMapping(data: {
    sourceSystem: string;
    sourcePaymentName: string;
    oracleReceiptMethodId: number;
    oracleReceiptMethodName: string;
    oracleBankAccountId?: number;
  }) {
    return this.prisma.paymentMethodMapping.create({
      data: { ...data, isActive: true },
    });
  }
}
