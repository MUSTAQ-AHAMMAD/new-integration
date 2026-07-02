import { numberToBigInt } from '../common/utils/bigint-utils';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AlertSeverity,
  AlertType,
  ValidationStatus,
  StoreConfiguration,
} from '@prisma/client';
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

  // In-memory cache for store configurations
  private readonly configCache = new Map<
    string,
    {
      config: StoreConfiguration;
      timestamp: number;
    }
  >();

  // Cache TTL: 5 minutes
  private readonly CACHE_TTL = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alertsService: AlertsService,
  ) {}

  /**
   * Get configuration from cache if available and fresh
   */
  private getCachedConfig(branchCode: string): StoreConfiguration | null {
    const cached = this.configCache.get(branchCode);
    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > this.CACHE_TTL) {
      this.configCache.delete(branchCode);
      return null;
    }

    return cached.config;
  }

  /**
   * Store configuration in cache
   */
  private cacheConfig(branchCode: string, config: StoreConfiguration): void {
    this.configCache.set(branchCode, {
      config,
      timestamp: Date.now(),
    });
  }

  /**
   * Clear cache for a specific branch or all branches
   */
  clearCache(branchCode?: string): void {
    if (branchCode) {
      this.configCache.delete(branchCode);
    } else {
      this.configCache.clear();
    }
  }

  /**
   * Get or create store configuration with caching and auto-creation
   * This method NEVER throws - it always returns a config (created or fallback)
   */
  async getOrCreateStoreConfig(
    branchCode: string,
  ): Promise<StoreConfiguration> {
    this.logger.log(`Getting store config for branch: ${branchCode}`);

    // 1. Try cache first
    const cached = this.getCachedConfig(branchCode);
    if (cached) {
      this.logger.debug(`Cache hit for branch ${branchCode}`);
      return cached;
    }

    // 2. Try to get from database
    let config = await this.prisma.storeConfiguration.findUnique({
      where: { branchCode },
    });

    // 3. If not found, try to create default config
    if (!config) {
      this.logger.warn(
        `Store config not found for branch ${branchCode}, creating default...`,
      );
      try {
        config = await this.createDefaultConfig(branchCode);
        this.logger.log(`✅ Created default config for branch ${branchCode}`);
      } catch (error) {
        this.logger.error(
          `Failed to create default config for branch ${branchCode}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // 4. If creation fails, use fallback config (in-memory only, not persisted)
        this.logger.warn(`Using fallback config for branch ${branchCode}`);
        return this.getFallbackConfig(branchCode);
      }
    }

    // 5. Cache and return
    this.cacheConfig(branchCode, config);
    return config;
  }

  /**
   * Create default store configuration for a branch
   */
  async createDefaultConfig(branchCode: string): Promise<StoreConfiguration> {
    this.logger.log(`Creating default configuration for branch: ${branchCode}`);

    // Try to get branch info from backup tables
    const branchId = parseInt(branchCode, 10);
    if (isNaN(branchId)) {
      throw new Error(`Invalid branch code: ${branchCode}`);
    }

    // Get branch info from Odoo backup
    const odooOrder = await this.prisma.backupOdooOrder.findFirst({
      where: { branchId },
      select: { branchName: true, region: true },
    });

    // Get branch info from IBQ backup
    const ibqOrder = await this.prisma.backupIbqOrder.findFirst({
      where: { branchId },
      select: { branchName: true, region: true },
    });

    const branchName =
      odooOrder?.branchName || ibqOrder?.branchName || `Branch-${branchCode}`;
    const region = odooOrder?.region || ibqOrder?.region || 'AE';

    // Try to get Oracle config from FusionSalesMetadata
    const fusionMetadata = await this.prisma.fusionSalesMetadata.findFirst({
      where: { region },
    });

    if (!fusionMetadata) {
      this.logger.warn(
        `No FusionSalesMetadata found for region ${region}, using defaults`,
      );
    }

    // Try to get bank/cash account IDs from FusionBusinessUnitMap or other sources
    const businessUnitMap = await this.prisma.fusionBusinessUnitMap.findFirst({
      where: { region },
    });

    // Create the configuration
    const config = await this.prisma.storeConfiguration.create({
      data: {
        branchCode,
        branchName,
        odooBranchId: numberToBigInt(branchId),
        oracleOperatingUnitId: fusionMetadata?.billToAccount || BigInt(0),
        oracleBusinessUnit: fusionMetadata?.businessUnit || businessUnitMap?.businessUnitName || 'DEFAULT_BU',
        billToSiteName: fusionMetadata?.billToName || `BILL_TO_${region}`,
        billToLocation: fusionMetadata?.siteNumber || undefined,
        bankAccountName: `BANK_${region}`,
        cashAccountName: `CASH_${region}`,
        // Try to populate account IDs if available
        bankAccountId: fusionMetadata?.distributionAccId ? Number(fusionMetadata.distributionAccId) : undefined,
        cashAccountId: undefined, // Will need to be populated manually or from other source
        paymentTermsName: 'IMMEDIATE',
        taxClassificationCode: undefined,
        transactionSource: fusionMetadata?.txnSource || 'Manual',
        transactionType: fusionMetadata?.txnType || 'PASA CONSULTING SALE',
        invoiceCurrencyCode: 'AED',
        region,
        isActive: true,
        validationStatus: ValidationStatus.PARTIAL,
        validationErrors: ['Auto-created config - requires manual validation of bank/cash account IDs'],
        createdBy: 'SYSTEM_AUTO_CREATE',
      },
    });

    // Fire alert for manual review
    await this.alertsService.createAlert({
      alertType: AlertType.STORE_CONFIG_INVALID,
      severity: AlertSeverity.WARNING,
      title: 'Store configuration auto-created',
      message: `Store configuration for branch ${branchCode} (${branchName}) was automatically created. Please review and update bank/cash account names and validate the configuration.`,
      relatedEntityId: branchCode,
      relatedEntityType: 'STORE_CONFIGURATION',
    });

    return config;
  }

  /**
   * Get fallback configuration (used when DB creation fails)
   * This config is NOT persisted - it's in-memory only
   */
  getFallbackConfig(branchCode: string): StoreConfiguration {
    const branchId = parseInt(branchCode, 10);
    const now = new Date();

    return {
      id: `FALLBACK_${branchCode}`,
      branchCode,
      branchName: `FALLBACK-${branchCode}`,
      odooBranchId: numberToBigInt(isNaN(branchId) ? 0 : branchId),
      oracleOperatingUnitId: numberToBigInt(0),
      oracleBusinessUnit: 'FALLBACK_BU',
      billToSiteName: 'FALLBACK_SITE',
      billToLocation: null,
      bankAccountName: 'FALLBACK_BANK',
      cashAccountName: 'FALLBACK_CASH',
      paymentTermsName: 'IMMEDIATE',
      taxClassificationCode: null,
      transactionSource: 'Manual',
      transactionType: 'PASA CONSULTING SALE',
      invoiceCurrencyCode: 'AED',
      region: 'AE',
      bankAccountId: null,
      cashAccountId: null,
      serviceProviderJournalMapping: null,
      txnQuantityDecimals: null,
      isActive: true,
      allowNegativeInventory: true,
      autoCreateMissingPaymentMethods: false,
      lastValidatedAt: null,
      validationStatus: ValidationStatus.INVALID,
      validationErrors: ['Fallback configuration - database creation failed'],
      version: 1,
      createdBy: 'SYSTEM_FALLBACK',
      createdAt: now,
      updatedAt: now,
    };
  }

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
      odooBranchId:
        odooBranchId != null ? BigInt(odooBranchId) : numberToBigInt(0),
      oracleOperatingUnitId:
        oracleOperatingUnitId != null
          ? BigInt(oracleOperatingUnitId)
          : numberToBigInt(0),
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
            odooBranchId: numberToBigInt(branch.branchId),
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
