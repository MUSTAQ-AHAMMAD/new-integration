import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AlertSeverity, AlertType, ValidationStatus } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StoreConfigService {
  private readonly logger = new Logger(StoreConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alertsService: AlertsService,
  ) {}

  async getRawConfig(branchCode: string) {
    const config = await this.prisma.storeConfiguration.findUnique({
      where: { branchCode },
    });

    if (!config) {
      throw new NotFoundException(
        `Store configuration not found for branch: ${branchCode}`,
      );
    }

    return config;
  }

  async getValidatedConfig(branchCode: string) {
    const config = await this.getRawConfig(branchCode);

    if (!config.isActive) {
      throw new Error(`Store ${branchCode} is inactive - skipping sync`);
    }

    if (config.validationStatus === ValidationStatus.INVALID) {
      throw new Error(
        `Store ${branchCode} has invalid configuration: ${JSON.stringify(config.validationErrors)}`,
      );
    }

    return config;
  }

  async deleteStore(branchCode: string): Promise<void> {
    const config = await this.prisma.storeConfiguration.findUnique({
      where: { branchCode },
    });

    if (!config) {
      throw new NotFoundException(
        `Store configuration not found for branch: ${branchCode}`,
      );
    }

    await this.prisma.storeConfiguration.delete({ where: { branchCode } });
    this.logger.log(`Store configuration deleted: ${branchCode}`);
  }

  async validateConfig(
    branchCode: string,
  ): Promise<{ isValid: boolean; errors: string[] }> {
    const config = await this.prisma.storeConfiguration.findUnique({
      where: { branchCode },
    });
    if (!config) return { isValid: false, errors: ['Store config not found'] };

    const errors: string[] = [];
    if (!config.billToSiteName) errors.push('billToSiteName is required');
    if (!config.bankAccountName) errors.push('bankAccountName is required');
    if (!config.cashAccountName) errors.push('cashAccountName is required');
    if (!config.paymentTermsName) errors.push('paymentTermsName is required');
    if (!config.oracleBusinessUnit)
      errors.push('oracleBusinessUnit is required');

    const status =
      errors.length === 0
        ? ValidationStatus.VALIDATED
        : ValidationStatus.INVALID;
    await this.prisma.storeConfiguration.update({
      where: { branchCode },
      data: {
        validationStatus: status,
        validationErrors: errors.length ? errors : undefined,
        lastValidatedAt: new Date(),
      },
    });

    if (errors.length) {
      await this.alertsService.createAlert({
        alertType: AlertType.STORE_CONFIG_INVALID,
        severity: AlertSeverity.ERROR,
        title: 'Store configuration invalid',
        message: `Store ${branchCode} validation failed: ${errors.join(', ')}`,
        relatedEntityId: branchCode,
        relatedEntityType: 'STORE_CONFIGURATION',
      });
    }

    return { isValid: errors.length === 0, errors };
  }

  async listStores(activeOnly = false) {
    return this.prisma.storeConfiguration.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { branchCode: 'asc' },
    });
  }

  async upsertStore(data: {
    branchCode: string;
    branchName: string;
    odooBranchId: number;
    oracleOperatingUnitId: number;
    oracleBusinessUnit: string;
    billToSiteName: string;
    billToLocation?: string;
    bankAccountName: string;
    cashAccountName: string;
    paymentTermsName: string;
    taxClassificationCode?: string;
    transactionSource?: string;
    transactionType?: string;
    invoiceCurrencyCode?: string;
    isActive?: boolean;
    createdBy: string;
  }) {
    const { branchCode, ...rest } = data;
    return this.prisma.storeConfiguration.upsert({
      where: { branchCode },
      create: { branchCode, ...rest },
      update: { ...rest, version: { increment: 1 } },
    });
  }
}
