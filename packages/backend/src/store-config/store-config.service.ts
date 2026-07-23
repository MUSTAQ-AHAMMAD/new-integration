import { numberToBigInt } from '../common/utils/bigint-utils';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, ObjectLiteral, Repository } from 'typeorm';
import { AlertsService } from '../alerts/alerts.service';
import { BackupIbqOrder } from '../database/entities/backup-ibq-order.entity';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { OutletIntegrationConfig } from '../database/entities/outlet-integration-config.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
import { AlertSeverity, AlertType, ValidationStatus } from '../database/enums';

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
    @InjectRepository(StoreConfiguration)
    private readonly stores: Repository<StoreConfiguration>,
    @InjectRepository(FusionSalesMetadata)
    private readonly salesMetadata: Repository<FusionSalesMetadata>,
    @InjectRepository(OutletIntegrationConfig)
    private readonly outletConfigs: Repository<OutletIntegrationConfig>,
    @InjectRepository(FusionBusinessUnitMap)
    private readonly businessUnitMaps: Repository<FusionBusinessUnitMap>,
    @InjectRepository(VendHqRegister)
    private readonly registers: Repository<VendHqRegister>,
    @InjectRepository(BackupOdooOrder)
    private readonly odooOrders: Repository<BackupOdooOrder>,
    @InjectRepository(BackupIbqOrder)
    private readonly ibqOrders: Repository<BackupIbqOrder>,
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

  /** Invoice currency per Oracle region. Falls back to AED for unknown regions. */
  private readonly CURRENCY_BY_REGION: Record<string, string> = {
    AE: 'AED',
    BH: 'BHD',
    KW: 'KWD',
    OM: 'OMR',
    SA: 'SAR',
    SN: 'SAR',
  };

  private currencyForRegion(region: string | null | undefined): string {
    return this.CURRENCY_BY_REGION[(region ?? '').toUpperCase()] ?? 'AED';
  }

  /** Normalise a store/mall name for matching (strip spacing/punctuation, upper-case). */
  private normalizeName(s: string | null | undefined): string {
    return (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Resolves the authoritative FusionSalesMetadata (NORMAL) record for a store,
   * matched by normalised branchName == billToName. The matched row's region is
   * authoritative — the order's own region field is unreliable (stores are
   * frequently mislabelled, e.g. a Kuwait mall tagged region SA). Matching by
   * name also picks THIS store's bill-to / business unit / txn source+type
   * instead of an arbitrary same-region row.
   *
   * Falls back to a region-only match (flagged) when the name isn't found, so
   * behaviour degrades gracefully rather than throwing.
   */
  private async resolveStoreMetadata(
    branchName: string | null | undefined,
    hintedRegion: string | null | undefined,
  ): Promise<{
    metadata: FusionSalesMetadata | null;
    region: string | null;
    nameMatched: boolean;
    regionSource:
      | 'OUTLET_CONFIG'
      | 'METADATA_NAME'
      | 'REGISTER_NAME'
      | 'ORDER_HINT'
      | 'NONE';
  }> {
    const target = this.normalizeName(branchName);

    // 1. OutletIntegrationConfig is the authoritative region source (mirrors the
    //    Java system, where the outlet row drives the whole integration). The
    //    order's own region field is unreliable (stores are frequently
    //    mislabelled, e.g. a Saudi mall tagged region BH).
    let outletRegion: string | null = null;
    if (target) {
      const outlets = await this.outletConfigs.find();
      const outlet = outlets.find(
        (o) => this.normalizeName(o.outletName) === target,
      );
      outletRegion = outlet?.region?.trim() || null;
    }

    // 2. Register name-match as a secondary region witness (registers are
    //    per-store, so a name hit pins the store to its real region).
    let registerRegion: string | null = null;
    if (target && !outletRegion) {
      const registers = await this.registers.find({
        where: { bankAccountId: Not(IsNull()), deletedAt: IsNull() },
      });
      const byName = registers.filter(
        (r) => this.normalizeName(r.registerName) === target,
      );
      if (byName.length > 0) {
        registerRegion =
          byName.find((r) => r.region === hintedRegion)?.region ??
          byName[0].region ??
          null;
      }
    }

    const preferredRegion =
      outletRegion ?? registerRegion ?? hintedRegion ?? null;

    const normals = await this.salesMetadata.find({
      where: { customerType: 'NORMAL' },
    });

    if (target) {
      // Java key first: SUBINVENTORY == outlet/branch name. billToName is only
      // the customer's display name ("AL Wehdah Mall" for branch WEHDA), so it
      // is merely the fallback for rows imported without a subinventory.
      const bySub = normals.filter(
        (m) => this.normalizeName(m.subinventory) === target,
      );
      const byName =
        bySub.length > 0
          ? bySub
          : normals.filter((m) => this.normalizeName(m.billToName) === target);
      if (byName.length > 0) {
        // Same store name may exist in multiple regions — prefer the
        // authoritative region, then the hinted one.
        const chosen =
          (preferredRegion
            ? byName.find((m) => m.region === preferredRegion)
            : undefined) ??
          (hintedRegion
            ? byName.find((m) => m.region === hintedRegion)
            : undefined) ??
          byName[0];
        return {
          metadata: chosen,
          region: outletRegion ?? chosen.region,
          nameMatched: true,
          regionSource: outletRegion ? 'OUTLET_CONFIG' : 'METADATA_NAME',
        };
      }
    }

    // No metadata name match — resolve region from the best witness we have and
    // fall back to a region-only metadata match (may be another store's row).
    const region = preferredRegion;
    const byRegion = region
      ? (normals.find((m) => m.region === region) ?? null)
      : null;
    return {
      metadata: byRegion,
      region,
      nameMatched: false,
      regionSource: outletRegion
        ? 'OUTLET_CONFIG'
        : registerRegion
          ? 'REGISTER_NAME'
          : hintedRegion
            ? 'ORDER_HINT'
            : 'NONE',
    };
  }

  /**
   * Resolves the store's OWN register (matched by normalised name) so bank/cash
   * accounts are per-store, exactly like the Java system where accounts hang off
   * the register, never off "any register in the region". Returns null when the
   * store has no name-matched register — callers must flag that for review
   * instead of silently borrowing another store's accounts.
   */
  private async resolveRegisterByName(
    branchName: string | null | undefined,
    region: string | null,
  ): Promise<VendHqRegister | null> {
    const target = this.normalizeName(branchName);
    if (!target) return null;
    const registers = await this.registers.find({
      where: {
        bankAccountId: Not(IsNull()),
        cashAccountId: Not(IsNull()),
        deletedAt: IsNull(),
      },
    });
    const byName = registers.filter(
      (r) => this.normalizeName(r.registerName) === target,
    );
    if (byName.length === 0) return null;
    return byName.find((r) => r.region === region) ?? byName[0];
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
    let config = await this.stores.findOne({
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
    const odooOrder = await this.odooOrders.findOne({
      where: { branchId },
      select: { branchName: true, region: true },
    });

    // Get branch info from IBQ backup
    const ibqOrder = await this.ibqOrders.findOne({
      where: { branchId },
      select: { branchName: true, region: true },
    });

    const branchName =
      odooOrder?.branchName || ibqOrder?.branchName || `Branch-${branchCode}`;
    const hintedRegion = odooOrder?.region || ibqOrder?.region || null;

    // Resolve the store's Oracle metadata by NAME (authoritative region), not by
    // the order's unreliable region field. This fixes both the region mislabel
    // and the "arbitrary same-region metadata" problem in one step.
    const {
      metadata: fusionMetadata,
      region: resolvedRegion,
      nameMatched,
      regionSource,
    } = await this.resolveStoreMetadata(branchName, hintedRegion);
    const region = resolvedRegion ?? hintedRegion ?? 'AE';

    if (!fusionMetadata) {
      this.logger.warn(
        `No FusionSalesMetadata found for branch ${branchCode} (name="${branchName}", region=${region}), using defaults`,
      );
    } else if (!nameMatched) {
      this.logger.warn(
        `FusionSalesMetadata for branch ${branchCode} (name="${branchName}") matched by region only, ` +
          `not by store name — bill-to/BU may be for a different store. Review this config.`,
      );
    }

    const businessUnitMap = await this.businessUnitMaps.findOne({
      where: { region },
    });

    // Bank/cash accounts hang off THIS store's register (matched by name), never
    // off an arbitrary same-region register — Java parity. Only when the store
    // has no register at all do we borrow a region row, and that is flagged.
    let register = await this.resolveRegisterByName(branchName, region);
    const registerNameMatched = register != null;
    if (!register) {
      register = await this.registers.findOne({
        where: {
          region,
          bankAccountId: Not(IsNull()),
          cashAccountId: Not(IsNull()),
          deletedAt: IsNull(),
        },
        order: { createdAt: 'DESC' },
      });
    }

    const bankAccountId = register?.bankAccountId
      ? Number(register.bankAccountId)
      : undefined;
    const cashAccountId = register?.cashAccountId
      ? Number(register.cashAccountId)
      : undefined;

    const validationErrors: string[] = [];
    if (!bankAccountId || !cashAccountId) {
      validationErrors.push(
        'Bank or cash account IDs missing - receipt creation will fail',
      );
    }
    if (!registerNameMatched && register) {
      validationErrors.push(
        `Bank/cash accounts borrowed from register "${register.registerName}" ` +
          '(no register matches this store name) - review before go-live',
      );
    }
    if (!fusionMetadata) {
      validationErrors.push(
        'No FusionSalesMetadata found for store - using defaults',
      );
    } else if (!nameMatched) {
      validationErrors.push(
        'FusionSalesMetadata matched by region only (not store name) - bill-to/business unit may be wrong; review',
      );
    }
    if (regionSource === 'ORDER_HINT' || regionSource === 'NONE') {
      validationErrors.push(
        `Region "${region}" taken from the order data (source=${regionSource}) - ` +
          'not confirmed by outlet config, metadata or register; review',
      );
    }

    // Create the configuration. Concurrent order-sync workers processing several
    // orders for the same new branch may collide on the branchCode unique
    // constraint — the losers of the race would otherwise throw and fall back to
    // an INVALID config, skipping the order. On a race, keep the row the winner
    // created by re-reading it after a save conflict.
    let config: StoreConfiguration;
    try {
      config = await this.stores.save(
        this.stores.create({
          branchCode,
          branchName,
          odooBranchId: numberToBigInt(branchId),
          oracleOperatingUnitId: fusionMetadata?.billToAccount || BigInt(0),
          oracleBusinessUnit:
            fusionMetadata?.businessUnit ||
            businessUnitMap?.businessUnitName ||
            'DEFAULT_BU',
          billToSiteName: fusionMetadata?.billToName || `BILL_TO_${region}`,
          billToLocation: fusionMetadata?.siteNumber || null,
          bankAccountName: register?.bankAccount || `BANK_${region}`,
          cashAccountName: register?.cashAccount || `CASH_${region}`,
          // Populate account IDs from register if available
          bankAccountId: bankAccountId ?? null,
          cashAccountId: cashAccountId ?? null,
          paymentTermsName: 'IMMEDIATE',
          taxClassificationCode: null,
          transactionSource: fusionMetadata?.txnSource || 'Manual',
          transactionType: fusionMetadata?.txnType || 'PASA CONSULTING SALE',
          invoiceCurrencyCode: this.currencyForRegion(region),
          region,
          isActive: true,
          // Fully name-resolved (this store's own metadata + its own register
          // accounts + confirmed region) → VALIDATED, matching the seeder.
          // Anything borrowed or guessed stays PENDING/PARTIAL for review.
          validationStatus:
            bankAccountId && cashAccountId
              ? validationErrors.length === 0
                ? ValidationStatus.VALIDATED
                : ValidationStatus.PENDING
              : ValidationStatus.PARTIAL,
          validationErrors:
            validationErrors.length > 0 ? validationErrors : null,
          createdBy: 'SYSTEM_AUTO_CREATE',
        }),
      );
    } catch (err) {
      // Lost the branchCode race — reuse the row the winner created.
      const existing = await this.stores.findOne({ where: { branchCode } });
      if (!existing) throw err;
      config = existing;
    }

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
   * Re-resolves auto-created / unreviewed store configurations with the
   * name-first resolution (outlet config region → own metadata → own register),
   * repairing rows that were created with an arbitrary same-region register or
   * a region mislabelled by the order data (e.g. a Saudi mall tagged BH).
   * Manually validated rows are never touched.
   */
  async repairAutoCreatedConfigs(opts: { dryRun?: boolean } = {}): Promise<{
    dryRun: boolean;
    examined: number;
    repaired: number;
    unchanged: number;
    results: Array<{
      branchCode: string;
      branchName: string;
      action: 'REPAIRED' | 'UNCHANGED';
      changes: Record<string, { from: unknown; to: unknown }>;
      issues: string[];
    }>;
  }> {
    const candidates = await this.stores.find({
      where: [
        { validationStatus: ValidationStatus.PENDING },
        { validationStatus: ValidationStatus.PARTIAL },
      ],
    });

    const results: Array<{
      branchCode: string;
      branchName: string;
      action: 'REPAIRED' | 'UNCHANGED';
      changes: Record<string, { from: unknown; to: unknown }>;
      issues: string[];
    }> = [];

    for (const config of candidates) {
      const {
        metadata,
        region: resolvedRegion,
        nameMatched,
        regionSource,
      } = await this.resolveStoreMetadata(config.branchName, config.region);
      const region = resolvedRegion ?? config.region;
      const register = await this.resolveRegisterByName(
        config.branchName,
        region,
      );

      const issues: string[] = [];
      if (!nameMatched) issues.push('metadata not name-matched');
      if (!register) issues.push('no name-matched register');
      if (regionSource === 'ORDER_HINT' || regionSource === 'NONE')
        issues.push(`region unconfirmed (source=${regionSource})`);

      const businessUnitMap = region
        ? await this.businessUnitMaps.findOne({ where: { region } })
        : null;

      const next: Partial<StoreConfiguration> = {};
      if (region && region !== config.region) next.region = region;
      if (nameMatched && metadata) {
        const bu = metadata.businessUnit || businessUnitMap?.businessUnitName;
        if (bu && bu !== config.oracleBusinessUnit)
          next.oracleBusinessUnit = bu;
        if (
          metadata.billToName &&
          metadata.billToName !== config.billToSiteName
        )
          next.billToSiteName = metadata.billToName;
        if (
          metadata.siteNumber &&
          metadata.siteNumber !== config.billToLocation
        )
          next.billToLocation = metadata.siteNumber;
        if (
          metadata.txnSource &&
          metadata.txnSource !== config.transactionSource
        )
          next.transactionSource = metadata.txnSource;
        if (metadata.txnType && metadata.txnType !== config.transactionType)
          next.transactionType = metadata.txnType;
        if (metadata.billToAccount != null) {
          const opUnit = BigInt(metadata.billToAccount);
          if (opUnit !== config.oracleOperatingUnitId)
            next.oracleOperatingUnitId = opUnit;
        }
      }
      if (register) {
        if (
          register.bankAccount &&
          register.bankAccount !== config.bankAccountName
        )
          next.bankAccountName = register.bankAccount;
        if (
          register.cashAccount &&
          register.cashAccount !== config.cashAccountName
        )
          next.cashAccountName = register.cashAccount;
        const bankId = register.bankAccountId
          ? Number(register.bankAccountId)
          : null;
        const cashId = register.cashAccountId
          ? Number(register.cashAccountId)
          : null;
        if (bankId != null && bankId !== config.bankAccountId)
          next.bankAccountId = bankId;
        if (cashId != null && cashId !== config.cashAccountId)
          next.cashAccountId = cashId;
      }
      const currency = this.currencyForRegion(region);
      if (currency !== config.invoiceCurrencyCode)
        next.invoiceCurrencyCode = currency;

      const fullyResolved =
        nameMatched && register != null && issues.length === 0;
      const nextStatus = fullyResolved
        ? ValidationStatus.VALIDATED
        : config.validationStatus;
      if (nextStatus !== config.validationStatus)
        next.validationStatus = nextStatus;

      const changed = Object.keys(next).length > 0;
      if (changed) {
        next.validationErrors = issues.length > 0 ? issues : null;
        if (!opts.dryRun) {
          await this.stores.update(
            { branchCode: config.branchCode },
            next as never,
          );
          this.clearCache(config.branchCode);
        }
      }

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, to] of Object.entries(next)) {
        if (key === 'validationErrors') continue;
        changes[key] = {
          from: (config as unknown as Record<string, unknown>)[key],
          to,
        };
      }
      results.push({
        branchCode: config.branchCode,
        branchName: config.branchName,
        action: changed ? 'REPAIRED' : 'UNCHANGED',
        changes,
        issues,
      });
    }

    const repaired = results.filter((r) => r.action === 'REPAIRED').length;
    this.logger.log(
      `Store-config repair ${opts.dryRun ? '(dry-run) ' : ''}— ` +
        `${repaired} repaired of ${results.length} examined.`,
    );
    return {
      dryRun: opts.dryRun ?? false,
      examined: results.length,
      repaired,
      unchanged: results.length - repaired,
      results,
    };
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
      creditMemoTransactionType: null,
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
    } as StoreConfiguration;
  }

  async getRawConfig(branchCode: string) {
    const config = await this.stores.findOne({
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
    const config = await this.stores.findOne({
      where: { branchCode },
    });

    if (!config) {
      throw new NotFoundException(
        `Store configuration not found for branch: ${branchCode}`,
      );
    }

    await this.stores.delete({ branchCode });
    this.logger.log(`Store configuration deleted: ${branchCode}`);
  }

  async validateConfig(
    branchCode: string,
  ): Promise<{ isValid: boolean; errors: string[]; warnings: string[] }> {
    const config = await this.stores.findOne({
      where: { branchCode },
    });
    if (!config)
      return {
        isValid: false,
        errors: ['Store config not found'],
        warnings: [],
      };

    const errors: string[] = [];
    const warnings: string[] = [];

    // Critical fields - will block sync
    if (!config.billToSiteName) errors.push('billToSiteName is required');
    if (!config.bankAccountName) errors.push('bankAccountName is required');
    if (!config.cashAccountName) errors.push('cashAccountName is required');
    if (!config.paymentTermsName) errors.push('paymentTermsName is required');
    if (!config.oracleBusinessUnit)
      errors.push('oracleBusinessUnit is required');

    // Account ID validation - critical for receipt creation
    if (config.bankAccountId === null) {
      errors.push(
        'bankAccountId is required for receipt creation - receipts will be skipped',
      );
    }
    if (config.cashAccountId === null) {
      errors.push(
        'cashAccountId is required for receipt creation - cash receipts will be skipped',
      );
    }

    // Warning fields - won't block sync but should be reviewed
    if (!config.region)
      warnings.push('region should be set for proper configuration matching');
    if (!config.taxClassificationCode)
      warnings.push(
        'taxClassificationCode not set - may affect tax calculation',
      );

    const status =
      errors.length === 0
        ? ValidationStatus.VALIDATED
        : ValidationStatus.INVALID;
    await this.stores.update(
      { branchCode },
      {
        validationStatus: status,
        validationErrors: (errors.length ? errors : null) as unknown as object,
        lastValidatedAt: new Date(),
      },
    );

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

    return { isValid: errors.length === 0, errors, warnings };
  }

  async listStores(activeOnly = false) {
    return this.stores.find({
      where: activeOnly ? { isActive: true } : undefined,
      order: { branchCode: 'ASC' },
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
    const mapped = {
      ...rest,
      odooBranchId:
        odooBranchId != null ? BigInt(odooBranchId) : numberToBigInt(0),
      oracleOperatingUnitId:
        oracleOperatingUnitId != null
          ? BigInt(oracleOperatingUnitId)
          : numberToBigInt(0),
    };

    const existing = await this.stores.findOne({ where: { branchCode } });
    if (existing) {
      Object.assign(existing, mapped);
      existing.version = (existing.version ?? 0) + 1;
      return this.stores.save(existing);
    }
    return this.stores.save(this.stores.create({ branchCode, ...mapped }));
  }

  /**
   * Populate missing bank/cash account IDs for store configurations
   * Uses VendHqRegister data as the source of truth for account IDs by region
   *
   * @returns Summary of updated configurations
   */
  async populateBankCashAccountIds(): Promise<{
    totalStores: number;
    updated: number;
    skipped: number;
    errors: string[];
  }> {
    this.logger.log(
      'Starting bank/cash account ID population for store configurations',
    );

    const errors: string[] = [];
    let updated = 0;
    let skipped = 0;

    // Get all store configurations that need account IDs
    const stores = await this.stores.find({
      where: [{ bankAccountId: IsNull() }, { cashAccountId: IsNull() }],
      order: { branchCode: 'ASC' },
    });

    this.logger.log(`Found ${stores.length} stores with missing account IDs`);

    // Get VendHqRegister data by region to use as reference. Fetch all
    // registers with account IDs ordered newest-first, then keep the first
    // (most recent) row seen per region — the Oracle-portable equivalent of
    // Postgres's DISTINCT ON (region) ... ORDER BY region, createdAt DESC.
    const regionAccountMap = await this.buildRegionAccountMap(true);

    this.logger.log(
      `Found account IDs for ${regionAccountMap.size} regions from VendHqRegister`,
    );

    // Update each store configuration
    for (const store of stores) {
      try {
        // Fail clearly rather than silently defaulting to AE (which would pick
        // the wrong region's bank/cash accounts).
        const region = store.region;
        if (!region) {
          const error = `Store ${store.branchCode} has no region — cannot resolve bank/cash accounts. Set the store's region.`;
          errors.push(error);
          this.logger.warn(error);
          skipped++;
          continue;
        }
        const accountIds = regionAccountMap.get(region);

        if (!accountIds) {
          const error = `No account IDs found for region ${region} (store ${store.branchCode})`;
          errors.push(error);
          this.logger.warn(error);
          skipped++;
          continue;
        }

        const updateData: Partial<StoreConfiguration> = {};
        if (store.bankAccountId === null) {
          updateData.bankAccountId = accountIds.bankAccountId;
        }
        if (store.cashAccountId === null) {
          updateData.cashAccountId = accountIds.cashAccountId;
        }

        if (Object.keys(updateData).length > 0) {
          await this.stores.update(
            { id: store.id },
            {
              bankAccountId: updateData.bankAccountId,
              cashAccountId: updateData.cashAccountId,
              validationStatus: ValidationStatus.PENDING,
            },
          );

          this.logger.log(
            `Updated store ${store.branchCode}: ` +
              `bank=${updateData.bankAccountId || 'unchanged'}, ` +
              `cash=${updateData.cashAccountId || 'unchanged'}`,
          );
          updated++;
        } else {
          skipped++;
        }
      } catch (err) {
        const errorMsg = `Failed to update store ${store.branchCode}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(errorMsg);
        this.logger.error(errorMsg);
        skipped++;
      }
    }

    this.logger.log(
      `Completed: ${updated} updated, ${skipped} skipped out of ${stores.length} stores`,
    );

    // Clear cache after updates
    this.clearCache();

    return {
      totalStores: stores.length,
      updated,
      skipped,
      errors,
    };
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
    const odooBranches = await this.aggregateBranches(this.odooOrders);

    this.logger.log(
      `Found ${odooBranches.length} unique branches in BackupOdooOrder`,
    );

    // ── Step 2: Get unique branches from BackupIbqOrder ─────────────────────
    const ibqBranches = await this.aggregateBranches(this.ibqOrders);

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
    const fusionMetadata = await this.salesMetadata.find({
      order: { billToName: 'ASC' },
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

    // ── Step 4.5: Get VendHqRegister data by region for account IDs ─────────
    const regionAccountMap = await this.buildRegionAccountMap(false);

    this.logger.log(
      `Found account IDs for ${regionAccountMap.size} regions from VendHqRegister`,
    );

    // ── Step 5: Create StoreConfiguration for each branch ───────────────────
    let created = 0;
    let skipped = 0;

    for (const branch of allBranches) {
      const branchCode = String(branch.branchId);

      try {
        // Check if config already exists
        const existing = await this.stores.findOne({
          where: { branchCode },
        });

        if (existing) {
          this.logger.debug(
            `Branch ${branchCode} already has configuration, skipping`,
          );
          skipped++;
          continue;
        }

        // Match by normalised store name first (authoritative region), then fall
        // back to a region-only match. Name matching picks THIS store's bill-to /
        // business unit and its TRUE region, instead of an arbitrary same-region
        // row applied under a possibly-mislabelled order region.
        const target = this.normalizeName(branch.branchName);
        const normals = fusionMetadata.filter(
          (m) => m.customerType === 'NORMAL',
        );
        const byName = target
          ? normals.filter((m) => this.normalizeName(m.billToName) === target)
          : [];
        let metadata =
          byName.length === 1
            ? byName[0]
            : byName.length > 1
              ? (byName.find((m) => m.region === branch.region) ?? byName[0])
              : undefined;
        const nameMatched = !!metadata;
        if (!metadata && branch.region) {
          metadata = normals.find((m) => m.region === branch.region);
        }

        if (!metadata) {
          const error = `No FusionSalesMetadata for branch ${branchCode} (name="${branch.branchName ?? ''}", region=${branch.region ?? 'none'})`;
          errors.push(error);
          this.logger.warn(error);
          skipped++;
          continue;
        }

        // The matched record's region is authoritative.
        const region = metadata.region;
        const accountIds = regionAccountMap.get(region);

        // Create StoreConfiguration
        await this.stores.save(
          this.stores.create({
            branchCode,
            branchName: branch.branchName || `Branch ${branchCode}`,
            odooBranchId: numberToBigInt(branch.branchId),
            oracleOperatingUnitId: metadata.billToAccount,
            oracleBusinessUnit: metadata.businessUnit,
            billToSiteName: metadata.billToName,
            billToLocation: metadata.siteNumber || null,
            bankAccountName: `BANK_${metadata.region}`,
            cashAccountName: `CASH_${metadata.region}`,
            bankAccountId: accountIds?.bankAccountId ?? null,
            cashAccountId: accountIds?.cashAccountId ?? null,
            paymentTermsName: 'IMMEDIATE',
            taxClassificationCode: null,
            transactionSource: metadata.txnSource,
            transactionType: metadata.txnType,
            invoiceCurrencyCode: this.currencyForRegion(region),
            region,
            isActive: true,
            validationStatus:
              accountIds && nameMatched
                ? ValidationStatus.PENDING
                : ValidationStatus.PARTIAL,
            createdBy: 'SYSTEM_POPULATE_API',
          }),
        );

        this.logger.log(
          `Created StoreConfiguration for branch ${branchCode} (${branch.branchName || 'N/A'})` +
            (accountIds
              ? ` with account IDs`
              : ` without account IDs - needs manual update`),
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

  /**
   * Aggregates unique branches from a backup-order repository (Odoo or IBQ),
   * grouping by branchId with a representative branchName/region and order count.
   * Replaces the former Postgres `$queryRaw` GROUP BY with a portable TypeORM
   * query builder that works against Oracle.
   */
  private async aggregateBranches(
    repo: Repository<ObjectLiteral>,
  ): Promise<BranchInfo[]> {
    const rows = await repo
      .createQueryBuilder('o')
      .select('o.branchId', 'branchId')
      .addSelect('MAX(o.branchName)', 'branchName')
      .addSelect('MAX(o.region)', 'region')
      .addSelect('COUNT(*)', 'orderCount')
      .where('o.branchId IS NOT NULL')
      .groupBy('o.branchId')
      .orderBy('COUNT(*)', 'DESC')
      .addOrderBy('o.branchId', 'ASC')
      .getRawMany<{
        branchId: number | string;
        branchName: string | null;
        region: string | null;
        orderCount: number | string;
      }>();

    return rows.map((r) => ({
      branchId: Number(r.branchId),
      branchName: r.branchName,
      region: r.region,
      orderCount: Number(r.orderCount),
    }));
  }

  /**
   * Builds a region → { bankAccountId, cashAccountId } map from VendHqRegister,
   * keeping the most-recent (by createdAt) register per region. Replaces the
   * former Postgres `DISTINCT ON (region)` query with a portable fetch-then-dedupe
   * that works against Oracle. When `activeOnly` is true, deleted registers are
   * excluded (mirrors the former `deletedAt IS NULL` filter).
   */
  private async buildRegionAccountMap(
    excludeDeleted: boolean,
  ): Promise<Map<string, { bankAccountId: number; cashAccountId: number }>> {
    const registers = await this.registers.find({
      where: {
        bankAccountId: Not(IsNull()),
        cashAccountId: Not(IsNull()),
        ...(excludeDeleted ? { deletedAt: IsNull() } : {}),
      },
      order: { createdAt: 'DESC' },
    });

    const map = new Map<
      string,
      { bankAccountId: number; cashAccountId: number }
    >();
    for (const reg of registers) {
      if (!reg.region || map.has(reg.region)) continue;
      if (reg.bankAccountId && reg.cashAccountId) {
        map.set(reg.region, {
          bankAccountId: Number(reg.bankAccountId),
          cashAccountId: Number(reg.cashAccountId),
        });
      }
    }
    return map;
  }
}
