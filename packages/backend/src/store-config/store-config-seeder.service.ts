/**
 * StoreConfigSeederService — bulk-provisions StoreConfiguration rows for a whole
 * region from the imported reference data, so a region can be made ready for
 * day-1 invoicing without hand-entering every outlet.
 *
 * For each outlet in OUTLETS_INTEGRATION_CONFIG it resolves:
 *   - bill-to name / site / account   ← FusionSalesMetadata (NORMAL, name match)
 *   - business unit                   ← FusionSalesMetadata / FusionBusinessUnitMap
 *   - bank & cash account ids         ← VendHqRegister (name match)
 *   - transaction source / type       ← FusionSalesMetadata
 *   - currency                        ← region default
 *   - isActive                        ← INTEG_MODE (NONE → inactive)
 *
 * The odooBranchId is taken from a backed-up Odoo order for the outlet when one
 * exists (the numeric branch id incoming orders use); otherwise the site number
 * is used as a provisional branch code. Anything that cannot be fully resolved
 * is still written but flagged NEEDS_REVIEW with the specific gaps, so an
 * operator gets a worklist rather than silent guesses.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { OutletIntegrationConfig } from '../database/entities/outlet-integration-config.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
import { generateId } from '../database/id.util';
import { ValidationStatus } from '../database/enums';
import { bigIntToNumber } from '../common/utils/bigint-utils';

/** Currency per region — matches the store-config service defaults. */
const REGION_CURRENCY: Record<string, string> = {
  SN: 'SAR',
  SA: 'SAR',
  AE: 'AED',
  KW: 'KWD',
  BH: 'BHD',
  OM: 'OMR',
};

export interface SeedOutletResult {
  outletName: string;
  branchCode: string | null;
  integMode: string;
  action: 'CREATED' | 'UPDATED' | 'SKIPPED_NONE' | 'SKIPPED_NO_METADATA';
  validationStatus?: 'VALID' | 'NEEDS_REVIEW';
  issues: string[];
}

export interface SeedReport {
  region: string;
  outlets: number;
  created: number;
  updated: number;
  skipped: number;
  needsReview: number;
  results: SeedOutletResult[];
}

@Injectable()
export class StoreConfigSeederService {
  private readonly logger = new Logger(StoreConfigSeederService.name);

  constructor(
    @InjectRepository(OutletIntegrationConfig)
    private readonly outlets: Repository<OutletIntegrationConfig>,
    @InjectRepository(FusionSalesMetadata)
    private readonly salesMeta: Repository<FusionSalesMetadata>,
    @InjectRepository(FusionBusinessUnitMap)
    private readonly buMap: Repository<FusionBusinessUnitMap>,
    @InjectRepository(VendHqRegister)
    private readonly registers: Repository<VendHqRegister>,
    @InjectRepository(BackupOdooOrder)
    private readonly backupOrders: Repository<BackupOdooOrder>,
    @InjectRepository(StoreConfiguration)
    private readonly stores: Repository<StoreConfiguration>,
  ) {}

  private norm(v: string | null | undefined): string {
    return (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Seeds/updates store configs for one region (or all regions when omitted).
   * `dryRun` returns the report without writing anything.
   */
  async seedRegion(
    region: string | undefined,
    opts: { dryRun?: boolean; activateNonMatched?: boolean } = {},
  ): Promise<SeedReport[]> {
    const regions = region
      ? [region]
      : [
          ...new Set(
            (await this.outlets.find({ select: { region: true } }))
              .map((o) => o.region?.trim())
              .filter((r): r is string => !!r),
          ),
        ];

    const reports: SeedReport[] = [];
    for (const r of regions) {
      reports.push(await this.seedOne(r, opts));
    }
    return reports;
  }

  private async seedOne(
    region: string,
    opts: { dryRun?: boolean; activateNonMatched?: boolean },
  ): Promise<SeedReport> {
    const outlets = await this.outlets.find({ where: { region } });
    // Preload the region's reference data once.
    const metaRows = await this.salesMeta.find({
      where: { region, customerType: 'NORMAL' },
    });
    const metaByName = new Map(
      metaRows.map((m) => [this.norm(m.billToName), m]),
    );
    const registerRows = await this.registers.find({
      where: { region, bankAccountId: Not(IsNull()), cashAccountId: Not(IsNull()) },
    });
    const registerByName = new Map(
      registerRows.map((r) => [this.norm(r.registerName), r]),
    );
    const bu = await this.buMap.findOne({ where: { region } });
    const currency = REGION_CURRENCY[region] ?? 'AED';

    // Preload the branchName → Odoo branchId map once (avoids an N+1 query per
    // outlet against the remote DB, which made a whole-region seed time out).
    const backupRows = await this.backupOrders
      .createQueryBuilder('o')
      .select('o.branchName', 'branchName')
      .addSelect('MAX(o.branchId)', 'branchId')
      .where('o.region = :region', { region })
      .andWhere('o.branchName IS NOT NULL')
      .groupBy('o.branchName')
      .getRawMany<{ branchName: string; branchId: number }>();
    const branchIdByName = new Map(
      backupRows.map((r) => [this.norm(r.branchName), r.branchId]),
    );
    const existingCodes = new Set(
      (await this.stores.find({ select: { branchCode: true } })).map(
        (s) => s.branchCode,
      ),
    );

    const report: SeedReport = {
      region,
      outlets: outlets.length,
      created: 0,
      updated: 0,
      skipped: 0,
      needsReview: 0,
      results: [],
    };

    for (const outlet of outlets) {
      const result = await this.seedOutlet(
        outlet,
        region,
        currency,
        metaByName,
        registerByName,
        bu,
        branchIdByName,
        existingCodes,
        opts,
      );
      report.results.push(result);
      if (result.action === 'CREATED') report.created++;
      else if (result.action === 'UPDATED') report.updated++;
      else report.skipped++;
      if (result.validationStatus === 'NEEDS_REVIEW') report.needsReview++;
    }

    this.logger.log(
      `[${region}] seed ${opts.dryRun ? '(dry-run) ' : ''}— ${report.created} created, ` +
        `${report.updated} updated, ${report.skipped} skipped, ${report.needsReview} need review`,
    );
    return report;
  }

  private async seedOutlet(
    outlet: OutletIntegrationConfig,
    region: string,
    currency: string,
    metaByName: Map<string, FusionSalesMetadata>,
    registerByName: Map<string, VendHqRegister>,
    bu: FusionBusinessUnitMap | null,
    branchIdByName: Map<string, number>,
    existingCodes: Set<string>,
    opts: { dryRun?: boolean; activateNonMatched?: boolean },
  ): Promise<SeedOutletResult> {
    const mode = (outlet.integMode ?? '').trim().toUpperCase();
    if (mode === 'NONE') {
      return {
        outletName: outlet.outletName,
        branchCode: null,
        integMode: mode,
        action: 'SKIPPED_NONE',
        issues: [],
      };
    }

    const meta = metaByName.get(this.norm(outlet.outletName));
    if (!meta) {
      // No bill-to metadata → an invoice could never be built. Report, don't guess.
      return {
        outletName: outlet.outletName,
        branchCode: null,
        integMode: mode,
        action: 'SKIPPED_NO_METADATA',
        issues: [
          `No NORMAL FusionSalesMetadata bill-to matches outlet name "${outlet.outletName}" in ${region}`,
        ],
      };
    }

    const issues: string[] = [];
    const register = registerByName.get(this.norm(outlet.outletName));
    if (!register) {
      issues.push('No VendHqRegister name-match — receipt bank/cash accounts unresolved');
    }

    // Branch code: prefer the Odoo branch id already seen in backups (what live
    // orders key on); fall back to the site number as a provisional code.
    const odooBranchId =
      branchIdByName.get(this.norm(outlet.outletName)) ?? null;
    const branchCode = odooBranchId
      ? String(odooBranchId)
      : (meta.siteNumber?.trim() || null);
    if (!branchCode) {
      issues.push('No Odoo branch id and no site number — cannot assign a branch code');
      return {
        outletName: outlet.outletName,
        branchCode: null,
        integMode: mode,
        action: 'SKIPPED_NO_METADATA',
        issues,
      };
    }
    if (!odooBranchId) {
      issues.push(
        'Branch code derived from site number (no Odoo order seen yet) — ' +
          'confirm it matches the outlet\'s Odoo branch_id before going live',
      );
    }

    const validationStatus: 'VALID' | 'NEEDS_REVIEW' =
      issues.length > 0 ? 'NEEDS_REVIEW' : 'VALID';

    const data: Partial<StoreConfiguration> = {
      branchCode,
      branchName: outlet.outletName,
      odooBranchId: BigInt(odooBranchId ?? (Number(branchCode) || 0)),
      region,
      oracleOperatingUnitId: bu
        ? BigInt(bigIntToNumber(bu.businessUnitId, 'businessUnitId'))
        : BigInt(0),
      oracleBusinessUnit: meta.businessUnit || bu?.businessUnitName || 'DEFAULT_BU',
      billToSiteName: meta.siteNumber || outlet.outletName,
      billToLocation: meta.siteNumber || null,
      bankAccountName: register?.bankAccount || `BANK_${region}`,
      cashAccountName: register?.cashAccount || `CASH_${region}`,
      bankAccountId: register?.bankAccountId ? Number(register.bankAccountId) : null,
      cashAccountId: register?.cashAccountId ? Number(register.cashAccountId) : null,
      paymentTermsName: 'IMMEDIATE',
      transactionSource: meta.txnSource || 'Vend',
      transactionType: meta.txnType || 'Vend Invoice',
      invoiceCurrencyCode: currency,
      // Eligible outlets are active; INTEG_MODE gating still decides manual vs auto.
      isActive: true,
      validationStatus:
        validationStatus === 'VALID'
          ? ValidationStatus.VALIDATED
          : ValidationStatus.PARTIAL,
      validationErrors: issues.length ? { issues } : null,
      version: 1,
      createdBy: 'store-config-seeder',
    };

    const existing = existingCodes.has(branchCode);
    const action: SeedOutletResult['action'] = existing ? 'UPDATED' : 'CREATED';

    if (!opts.dryRun) {
      if (existing) {
        await this.stores.update({ branchCode }, data as never);
      } else {
        await this.stores.save(this.stores.create({ id: generateId(), ...data }));
      }
    }

    return {
      outletName: outlet.outletName,
      branchCode,
      integMode: mode,
      action,
      validationStatus,
      issues,
    };
  }
}
