import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AlertsService } from '../alerts/alerts.service';
import { PaymentMethodMapping } from '../database/entities/payment-method-mapping.entity';
import { AlertSeverity, AlertType } from '../database/enums';

@Injectable()
export class PaymentMappingService {
  private readonly logger = new Logger(PaymentMappingService.name);

  constructor(
    @InjectRepository(PaymentMethodMapping)
    private readonly mappings: Repository<PaymentMethodMapping>,
    private readonly alertsService: AlertsService,
  ) {}

  async resolvePaymentMethod(sourceSystem: string, sourcePaymentName: string) {
    const mapping = await this.mappings.findOne({
      where: { sourceSystem, sourcePaymentName },
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

      // Upsert a PENDING_MAPPING placeholder so the pair is tracked exactly once.
      const existing = await this.mappings.findOne({
        where: { sourceSystem, sourcePaymentName },
      });
      if (existing) {
        existing.requiresApproval = true;
        await this.mappings.save(existing);
      } else {
        await this.mappings.save(
          this.mappings.create({
            sourceSystem,
            sourcePaymentName,
            oracleReceiptMethodId: 0n,
            oracleReceiptMethodName: 'PENDING_MAPPING',
            isActive: false,
            requiresApproval: true,
          }),
        );
      }

      // Return null so the caller can gracefully queue the order rather than
      // halting the entire integration run.
      return null;
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
    return this.mappings.find({
      where: sourceSystem ? { sourceSystem } : undefined,
      order: { sourcePaymentName: 'ASC' },
    });
  }

  async approvePendingMapping(id: string, approvedBy: string) {
    await this.mappings.update(id, {
      requiresApproval: false,
      isActive: true,
      approvedBy,
      approvedAt: new Date(),
    });
    return this.mappings.findOne({ where: { id } });
  }

  async createMapping(data: {
    sourceSystem: string;
    sourcePaymentName: string;
    oracleReceiptMethodId: number;
    oracleReceiptMethodName: string;
    oracleBankAccountId?: number;
  }) {
    return this.mappings.save(
      this.mappings.create({
        sourceSystem: data.sourceSystem,
        sourcePaymentName: data.sourcePaymentName,
        oracleReceiptMethodName: data.oracleReceiptMethodName,
        isActive: true,
        oracleReceiptMethodId: BigInt(data.oracleReceiptMethodId),
        oracleBankAccountId:
          data.oracleBankAccountId != null
            ? BigInt(data.oracleBankAccountId)
            : null,
      }),
    );
  }
}
