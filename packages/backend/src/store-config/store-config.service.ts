import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AlertSeverity, AlertType, ValidationStatus } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';

interface BranchInfo {
  branchId: number;
  branchName: string | null;
  region: string | null;
  orderCount: number;
}

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
    const { branchCode, odooBranchId, oracleOperatingUnitId, ...rest } = data;
    const prismaData = {
      ...rest,
      odooBranchId: odooBranchId != null ? BigInt(odooBranchId) : BigInt(0),
      oracleOperatingUnitId: oracleOperatingUnitId != null ? BigInt(oracleOperatingUnitId) : BigInt(0),
    };
    return this.prisma.storeConfiguration.upsert({
      where: { branchCode },
      create: { branchCode, ...prismaData },
      update: { ...prismaData, version: { increment: 1 } },
    });
  }

  /**
   * Option B: Populate StoreConfiguration for All Branches
   *
   * Creates StoreConfiguration records for all unique branches found in
   * BackupOdooOrder and BackupIbqOrder tables. Maps to FusionSalesMetadata
   * by region to populate Oracle configuration fields.
   *
   * @returns Summary of created/skipped configurations
   */
  async populateAllBranches(): Promise<{
    totalBranches: number;
    created: number;
    skipped: number;
    errors: string[];
  }> {
    this.logger.log('Starting StoreConfiguration population for all branches');

    const errors: string[] = [];

    // ── Step 1: Get unique branches from BackupOdooOrder ────────────────────
    const odooBranches = await this.prisma.$queryRaw<BranchInfo[]>`
      SELECT 
        "branchId"::int as "branchId",
        MAX("branchName") as "branchName",
        MAX(region) as region,
        COUNT(*)::int as "orderCount"
      FROM "BackupOdooOrder"
      WHERE "branchId" IS NOT NULL
      GROUP BY "branchId"
      ORDER BY "orderCount" DESC, "branchId"
    `;

    this.logger.log(
      `Found ${odooBranches.length} unique branches in BackupOdooOrder`,
    );

    // ── Step 2: Get unique branches from BackupIbqOrder ─────────────────────
    const ibqBranches = await this.prisma.$queryRaw<BranchInfo[]>`
      SELECT 
        "branchId"::int as "branchId",
        MAX("branchName") as "branchName",
        MAX(region) as region,
        COUNT(*)::int as "orderCount"
      FROM "BackupIbqOrder"
      WHERE "branchId" IS NOT NULL
      GROUP BY "branchId"
      ORDER BY "orderCount" DESC, "branchId"
    `;

    this.logger.log(
      `Found ${ibqBranches.length} unique branches in BackupIbqOrder`,
    );

    // ── Step 3: Merge and deduplicate branches ──────────────────────────────
    const branchMap = new Map<number, BranchInfo>();

    for (const branch of [...odooBranches, ...ibqBranches]) {
      const existing = branchMap.get(branch.branchId);
      if (!existing) {
        branchMap.set(branch.branchId, branch);
      } else {
        // Merge: prefer non-null values, sum order counts
        branchMap.set(branch.branchId, {
          branchId: branch.branchId,
          branchName: existing.branchName || branch.branchName,
          region: existing.region || branch.region,
          orderCount: existing.orderCount + branch.orderCount,
        });
      }
    }

    const allBranches = Array.from(branchMap.values()).sort(
      (a, b) => b.orderCount - a.orderCount,
    );

    this.logger.log(`Total unique branches: ${allBranches.length}`);

    // ── Step 4: Get FusionSalesMetadata records ─────────────────────────────
    const fusionMetadata = await this.prisma.fusionSalesMetadata.findMany({
      orderBy: { billToName: 'asc' },
    });

    if (fusionMetadata.length === 0) {
      const error =
        'No FusionSalesMetadata records found. ' +
        'You must populate FusionSalesMetadata first.';
      this.logger.error(error);
      throw new Error(error);
    }

    this.logger.log(
      `Found ${fusionMetadata.length} FusionSalesMetadata records`,
    );

    // ── Step 5: Create StoreConfiguration for each branch ───────────────────
    let created = 0;
    let skipped = 0;

    for (const branch of allBranches) {
      const branchCode = String(branch.branchId);

      try {
        // Check if config already exists
        const existing = await this.prisma.storeConfiguration.findUnique({
          where: { branchCode },
        });

        if (existing) {
          this.logger.debug(
            `Branch ${branchCode} already has configuration, skipping`,
          );
          skipped++;
          continue;
        }

        // Find matching FusionSalesMetadata by region
        const metadata =
          fusionMetadata.find(
            (m) => branch.region && m.region === branch.region,
          ) ||
          fusionMetadata.find((m) => m.region === 'AE') || // Default to AE
          fusionMetadata[0]; // Last resort

        if (!metadata) {
          const error = `No suitable FusionSalesMetadata found for branch ${branchCode}`;
          errors.push(error);
          this.logger.warn(error);
          skipped++;
          continue;
        }

        // Create StoreConfiguration
        await this.prisma.storeConfiguration.create({
          data: {
            branchCode,
            branchName: branch.branchName || `Branch ${branchCode}`,
            odooBranchId: BigInt(branch.branchId),
            oracleOperatingUnitId: metadata.billToAccount,
            oracleBusinessUnit: metadata.businessUnit,
            billToSiteName: metadata.billToName,
            billToLocation: metadata.siteNumber || undefined,
            bankAccountName: `BANK_${metadata.region}`,
            cashAccountName: `CASH_${metadata.region}`,
            paymentTermsName: 'IMMEDIATE',
            taxClassificationCode: undefined,
            transactionSource: metadata.txnSource,
            transactionType: metadata.txnType,
            invoiceCurrencyCode: 'AED',
            region: branch.region || metadata.region,
            isActive: true,
            validationStatus: ValidationStatus.PENDING,
            createdBy: 'SYSTEM_POPULATE_API',
          },
        });

        this.logger.log(
          `Created StoreConfiguration for branch ${branchCode} (${branch.branchName || 'N/A'})`,
        );
        created++;
      } catch (err) {
        const errorMsg = `Failed to create config for branch ${branchCode}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(errorMsg);
        this.logger.error(errorMsg);
        skipped++;
      }
    }

    this.logger.log(
      `Completed: ${created} created, ${skipped} skipped out of ${allBranches.length} branches`,
    );

    return {
      totalBranches: allBranches.length,
      created,
      skipped,
      errors,
    };
  }
}
