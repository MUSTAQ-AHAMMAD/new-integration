import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import {
  BillToMatchVia,
  REGION_DEFAULT_SUBINVENTORY,
  isRegionDefault,
  matchBillTo,
  normalizeStoreName,
} from '../sync/bill-to-resolver';

export interface BillToRow {
  id: string;
  region: string;
  customerType: string;
  subinventory: string | null;
  billToName: string;
  billToAccount: string;
  siteNumber: string | null;
  businessUnit: string;
  costCenterCode: string | null;
}

export type StoreBillToStatus = 'MAPPED' | 'REGION_DEFAULT' | 'MISSING';

export interface StoreBillTo {
  storeId: string;
  branchCode: string;
  branchName: string;
  region: string;
  status: StoreBillToStatus;
  via: BillToMatchVia | null;
  billTo: BillToRow | null;
  /** For MISSING stores: an existing bill-to that looks like the same store. */
  suggestion: { templateId: string; reason: string } | null;
}

export interface RegionBillToSummary {
  region: string;
  businessUnit: string | null;
  stores: number;
  mapped: number;
  viaDefault: number;
  missing: number;
  regionDefault: BillToRow | null;
}

export interface BillToMappingStatus {
  regions: RegionBillToSummary[];
  stores: StoreBillTo[];
  /** Existing per-store NORMAL bill-to rows, selectable as templates. */
  templates: BillToRow[];
}

export interface BillToApplyRequest {
  /** Give these stores their own bill-to, copied from a template row. */
  stores?: { storeId: string; templateId: string }[];
  /** Set a region's default bill-to ('*'), copied from a template row. */
  regionDefaults?: { region: string; templateId: string }[];
  /**
   * Also copy the template store's delivery-platform rows (TABBY, TAMARA, …)
   * where the target has none yet. Default true.
   */
  includeProviders?: boolean;
}

export interface BillToApplyResult {
  created: number;
  updated: number;
  providerRowsCopied: number;
}

const toRow = (m: FusionSalesMetadata): BillToRow => ({
  id: m.id,
  region: m.region,
  customerType: m.customerType,
  subinventory: m.subinventory,
  billToName: m.billToName,
  billToAccount: String(m.billToAccount),
  siteNumber: m.siteNumber,
  businessUnit: m.businessUnit,
  costCenterCode: m.costCenterCode,
});

const isNormal = (m: { customerType: string | null }) =>
  (m.customerType ?? '').trim().toUpperCase() === 'NORMAL';

/**
 * Admin "Bill-to Mapping": shows which active stores the posting run can
 * resolve a FusionSalesMetadata bill-to for (using the exact same matcher), and
 * lets an admin fix the gaps by copying an existing bill-to onto a store or
 * onto the region default — no hand-typed account or site numbers.
 */
@Injectable()
export class BillToMappingService {
  private readonly logger = new Logger(BillToMappingService.name);

  constructor(
    @InjectRepository(StoreConfiguration)
    private readonly stores: Repository<StoreConfiguration>,
    @InjectRepository(FusionSalesMetadata)
    private readonly salesMeta: Repository<FusionSalesMetadata>,
    @InjectRepository(FusionBusinessUnitMap)
    private readonly buMap: Repository<FusionBusinessUnitMap>,
  ) {}

  async status(region?: string): Promise<BillToMappingStatus> {
    const [stores, meta, bus] = await Promise.all([
      this.stores.find({
        where: { isActive: true, ...(region ? { region } : {}) },
        order: { region: 'ASC', branchName: 'ASC' },
      }),
      this.salesMeta.find(),
      this.buMap.find(),
    ]);

    const metaByRegion = new Map<string, FusionSalesMetadata[]>();
    for (const m of meta) {
      const list = metaByRegion.get(m.region) ?? [];
      list.push(m);
      metaByRegion.set(m.region, list);
    }
    const buByRegion = new Map(bus.map((b) => [b.region, b.businessUnitName]));
    const templates = meta.filter((m) => isNormal(m) && !isRegionDefault(m));

    const result: StoreBillTo[] = stores.map((s) => {
      const region = s.region ?? '';
      const match = matchBillTo(
        metaByRegion.get(region) ?? [],
        'NORMAL',
        s.branchName,
      );
      const status: StoreBillToStatus = !match
        ? 'MISSING'
        : match.via === 'REGION_DEFAULT'
          ? 'REGION_DEFAULT'
          : 'MAPPED';
      return {
        storeId: s.id,
        branchCode: s.branchCode,
        branchName: s.branchName,
        region,
        status,
        via: match?.via ?? null,
        billTo: match ? toRow(match.row) : null,
        suggestion:
          status === 'MISSING'
            ? this.suggest(s.branchName, buByRegion.get(region), templates)
            : null,
      };
    });

    const regionNames = [
      ...new Set([...result.map((r) => r.region), ...bus.map((b) => b.region)]),
    ]
      .filter((r) => r && (!region || r === region))
      .sort();
    const regions: RegionBillToSummary[] = regionNames.map((r) => {
      const inRegion = result.filter((s) => s.region === r);
      const def = (metaByRegion.get(r) ?? []).find(
        (m) => isNormal(m) && isRegionDefault(m),
      );
      return {
        region: r,
        businessUnit: buByRegion.get(r) ?? null,
        stores: inRegion.length,
        mapped: inRegion.filter((s) => s.status === 'MAPPED').length,
        viaDefault: inRegion.filter((s) => s.status === 'REGION_DEFAULT').length,
        missing: inRegion.filter((s) => s.status === 'MISSING').length,
        regionDefault: def ? toRow(def) : null,
      };
    });

    return {
      regions,
      stores: result,
      templates: templates
        .map(toRow)
        .sort(
          (a, b) =>
            a.region.localeCompare(b.region) ||
            (a.subinventory ?? '').localeCompare(b.subinventory ?? ''),
        ),
    };
  }

  /**
   * Best-effort guess for an unmapped store: the same name in another region
   * (e.g. an SN store that is also a KSA store), then the name without a
   * trailing number (PANORAMA2 → PANORAMA). Same business unit wins ties.
   */
  private suggest(
    branchName: string,
    businessUnit: string | undefined,
    templates: FusionSalesMetadata[],
  ): { templateId: string; reason: string } | null {
    const target = normalizeStoreName(branchName);
    if (!target) return null;
    const pick = (key: string) => {
      const hits = templates.filter(
        (t) =>
          normalizeStoreName(t.subinventory) === key ||
          normalizeStoreName(t.billToName) === key,
      );
      return hits.find((t) => t.businessUnit === businessUnit) ?? hits[0];
    };
    const exact = pick(target);
    if (exact) {
      return {
        templateId: exact.id,
        reason: `same store name in ${exact.region}`,
      };
    }
    const base = target.replace(/\d+$/, '');
    if (base && base !== target) {
      const near = pick(base);
      if (near) {
        return {
          templateId: near.id,
          reason: `"${near.subinventory}" in ${near.region} (name without number)`,
        };
      }
    }
    return null;
  }

  async apply(req: BillToApplyRequest): Promise<BillToApplyResult> {
    const includeProviders = req.includeProviders !== false;
    const out: BillToApplyResult = { created: 0, updated: 0, providerRowsCopied: 0 };

    const targets: { region: string; subinventory: string; templateId: string }[] = [];
    for (const a of req.stores ?? []) {
      const store = await this.stores.findOne({ where: { id: a.storeId } });
      if (!store?.region) {
        throw new BadRequestException(`Unknown store ${a.storeId}`);
      }
      targets.push({
        region: store.region,
        subinventory: store.branchName,
        templateId: a.templateId,
      });
    }
    for (const d of req.regionDefaults ?? []) {
      if (!d.region?.trim()) throw new BadRequestException('region is required');
      targets.push({
        region: d.region.trim().toUpperCase(),
        subinventory: REGION_DEFAULT_SUBINVENTORY,
        templateId: d.templateId,
      });
    }
    if (targets.length === 0) {
      throw new BadRequestException('Nothing to apply');
    }

    for (const t of targets) {
      const template = await this.salesMeta.findOne({
        where: { id: t.templateId },
      });
      if (!template || !isNormal(template)) {
        throw new BadRequestException(
          `Template ${t.templateId} is not a NORMAL bill-to row`,
        );
      }
      // The store's NORMAL bill-to is an explicit choice: create or replace.
      const wrote = await this.writeCopy(template, t.region, t.subinventory, true);
      if (wrote === 'created') out.created++;
      if (wrote === 'updated') out.updated++;

      if (includeProviders && template.subinventory && !isRegionDefault(template)) {
        const providers = await this.salesMeta.find({
          where: {
            region: template.region,
            subinventory: template.subinventory,
          },
        });
        for (const p of providers.filter((p) => !isNormal(p))) {
          // Never overwrite a platform row the target already has.
          const res = await this.writeCopy(p, t.region, t.subinventory, false);
          if (res === 'created') out.providerRowsCopied++;
        }
      }
      this.logger.log(
        `Bill-to for ${t.region}/${t.subinventory} copied from ` +
          `${template.region}/${template.subinventory} ` +
          `(account ${String(template.billToAccount)}, site ${template.siteNumber ?? '-'})`,
      );
    }
    return out;
  }

  /** Copies a bill-to row onto (region, subinventory) for the same customer type. */
  private async writeCopy(
    source: FusionSalesMetadata,
    region: string,
    subinventory: string,
    overwrite: boolean,
  ): Promise<'created' | 'updated' | 'kept'> {
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      ...fields
    } = source;
    const existing = await this.salesMeta.findOne({
      where: { region, subinventory, customerType: source.customerType },
    });
    if (existing) {
      if (!overwrite) return 'kept';
      await this.salesMeta.update(existing.id, { ...fields, region, subinventory });
      return 'updated';
    }
    await this.salesMeta.save(
      this.salesMeta.create({ ...fields, region, subinventory }),
    );
    return 'created';
  }
}
