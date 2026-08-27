import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VendHqTaxMeta } from '../database/entities/vend-hq-tax-meta.entity';

/**
 * Per-region tax lookup, built once from VendHqTaxMeta. Mirrors the Java
 * `invoiceLine.setTaxClassificationCode(lineItem.getTaxName())` — a line's Odoo
 * tax is resolved to the Fusion classification code Oracle expects, so Oracle's
 * tax engine computes and posts the VAT as a proper tax line.
 */
export interface RegionTaxContext {
  /** Odoo tax id → Fusion classification code. */
  byTaxId: Map<string, string>;
  /** normalized tax/fusion name → Fusion classification code. */
  byName: Map<string, string>;
  /** The region's single code when unambiguous, else null. */
  regionDefault: string | null;
}

/**
 * Resolves a line's Oracle TaxClassificationCode from VendHqTaxMeta.
 *
 * Extracted as a shared service so the invoice path (DailyAggregationService)
 * and the credit-memo path (OdooTransformationService) classify tax the SAME
 * way — refunds must carry the same code as the original sale so Oracle reverses
 * the VAT, otherwise credit memos under-credit tax and reconciliation drifts.
 */
@Injectable()
export class TaxClassificationService {
  private readonly logger = new Logger(TaxClassificationService.name);
  private readonly regionTaxCache = new Map<string, RegionTaxContext>();

  constructor(
    @InjectRepository(VendHqTaxMeta)
    private readonly taxMetaRepo: Repository<VendHqTaxMeta>,
  ) {}

  private normalizeTaxKey(v: string | null | undefined): string {
    return (v ?? '').trim().toLowerCase();
  }

  /**
   * Build the region's tax lookup from VendHqTaxMeta (cached). The Fusion
   * classification code is `fusionName` (falling back to `taxName`), keyed by
   * both the Odoo tax id and the tax/fusion name so a line can match either way.
   */
  async resolveRegionTaxContext(region: string): Promise<RegionTaxContext> {
    const key = region.trim().toUpperCase();
    const cached = this.regionTaxCache.get(key);
    if (cached) return cached;

    const rows = await this.taxMetaRepo.find({ where: { region: key } });
    const byTaxId = new Map<string, string>();
    const byName = new Map<string, string>();
    const codes = new Set<string>();
    for (const r of rows) {
      const code = (r.fusionName ?? r.taxName)?.trim();
      if (!code) continue;
      codes.add(code);
      if (r.taxId) byTaxId.set(String(r.taxId).trim(), code);
      if (r.taxName) byName.set(this.normalizeTaxKey(r.taxName), code);
      byName.set(this.normalizeTaxKey(r.fusionName), code);
    }
    const distinct = [...codes];
    const ctx: RegionTaxContext = {
      byTaxId,
      byName,
      regionDefault: distinct.length === 1 ? distinct[0] : null,
    };
    if (distinct.length === 0) {
      this.logger.warn(
        `No tax code in VendHqTaxMeta for region ${key} — lines sent without a ` +
          `TaxClassificationCode (Oracle applies the customer/site default).`,
      );
    } else if (distinct.length > 1) {
      this.logger.warn(
        `Region ${key} has multiple tax codes in VendHqTaxMeta (${distinct.join(', ')}) — ` +
          `matching per line by tax id/name; unmatched lines get no code.`,
      );
    }
    this.regionTaxCache.set(key, ctx);
    return ctx;
  }

  /**
   * Resolve one line's Fusion TaxClassificationCode — Odoo tax id first (stable),
   * then tax name, then the region default. Undefined when nothing matches, so an
   * unknown code can never make Oracle reject the whole document.
   */
  resolveLineTaxCode(
    line: { taxName: string | null; taxIds?: string | null },
    ctx: RegionTaxContext,
  ): string | undefined {
    if (line.taxIds) {
      for (const raw of String(line.taxIds).split(/[\s,[\]]+/)) {
        const id = raw.trim();
        if (id && ctx.byTaxId.has(id)) return ctx.byTaxId.get(id);
      }
    }
    const byName = ctx.byName.get(this.normalizeTaxKey(line.taxName));
    if (byName) return byName;
    return ctx.regionDefault ?? undefined;
  }
}
