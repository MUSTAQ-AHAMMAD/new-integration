/**
 * InventoryUploadService — relieves (and returns) Oracle stock for a branch's
 * day of Odoo sales, the same way the crm-inventory-missreceipt app's
 * "Inventory Template Generation" + "Inventory Bulk Upload" screens do it by hand:
 *
 *   1. Conversion (inventoryTemplateController.convertRecords)
 *        - one row per (subinventory, item, order ref, date, UoM), quantities
 *          SUMMED across the order's lines for that item;
 *        - Oracle qty = -(Odoo qty): Odoo sends sales POSITIVE and refunds
 *          NEGATIVE, Oracle wants the reverse —
 *            sale   (Odoo +2) → -2 "Vend Sales Issue"  (stock out)
 *            refund (Odoo -1) → +1 "Vend RMA"          (stock back in)
 *          The type follows the final sign, so an exchange (refund order that
 *          also sells a new item) issues the new item and returns the old one;
 *          net 0 → skipped.
 *   2. Upload (inventoryController.processUploadRows)
 *        - one POST per row to inventoryStagedTransactions with the fixed
 *          SourceHeaderId "1" / SourceLineId "0" / TransactionMode "1" /
 *          SourceCode "SERVICE" / UseCurrentCostFlag "true";
 *        - CONCURRENCY rows in parallel;
 *        - an HTTP 2xx whose body carries ProcessStatus "3" or an ErrorCode is a
 *          FAILURE (Oracle rejects in-band);
 *        - rows that already succeeded are never re-sent.
 *
 * Runs once per branch/day, independently of the invoice groups, so refund-only
 * days and days whose invoice is already posted still get their stock moved.
 * Every attempt is recorded in FusionInvTxn (SUCCESS / ERROR); a re-run retries
 * only the ERROR rows.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  InventoryStagedTransactionPayload,
  OracleClient,
} from '../clients/oracle/oracle.client';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { FusionInvTxn } from '../database/entities/fusion-inv-txn.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { generateId } from '../database/id.util';
import { mapWithConcurrency } from '../common/utils/concurrency';
import {
  DailyAggregationService,
  NON_INVOICEABLE_STATES,
} from './daily-aggregation.service';
import { OdooTransformationService } from './odoo-transformation.service';

/** Rows sent to Oracle in parallel per branch/day (reference CONCURRENCY = 10). */
const INVENTORY_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.DAILY_INVENTORY_CONCURRENCY ?? '10', 10) || 10,
);

/** Transaction types used by the reference template generator. */
const SALES_ISSUE_TYPE =
  process.env.ORACLE_INVENTORY_ISSUE_TXN_TYPE || 'Vend Sales Issue';
const RMA_TYPE = process.env.ORACLE_INVENTORY_RMA_TXN_TYPE || 'Vend RMA';

/** Status for rows Oracle refused because the subinventory would go negative. */
export const NEGATIVE_INVENTORY = 'NEGATIVE_INVENTORY';

/** Statuses an admin may re-send. */
const REPROCESSABLE = new Set([NEGATIVE_INVENTORY, 'ERROR']);

/** Max rows one admin reprocess call re-sends. */
const REPROCESS_LIMIT = 2000;

/**
 * Oracle wording for "not enough on-hand" rejections (inventory interface /
 * transaction manager), matched against the error code + explanation.
 */
const NEGATIVE_STOCK_PATTERN =
  /negative|insufficient|not enough|exceeds? (the )?(available|on.?hand)|available to (transact|reserve)|INV_NO_NEG|NEG_BAL/i;

type RowOutcome = 'SUCCESS' | 'ERROR' | typeof NEGATIVE_INVENTORY;

/** Reference default when the line carries no unit of measure. */
const DEFAULT_UOM = 'Each';

/** One converted template row, before the Oracle organisation is attached. */
export interface InventoryUploadRow {
  TransactionTypeName: string;
  ItemNumber: string;
  SubinventoryCode: string;
  /** YYYY-MM-DD */
  TransactionDate: string;
  TransactionQuantity: number;
  TransactionReference: string;
  TransactionUnitOfMeasure: string;
}

export interface InventoryUploadResult {
  branchCode: string;
  businessDay: string;
  totalRows: number;
  success: number;
  failed: number;
  /** Issues Oracle refused for lack of stock - held for admin reprocess. */
  negativeHeld: number;
  /** Rows already posted by an earlier run (not re-sent). */
  skipped: number;
}

export interface InventoryReprocessResult {
  selected: number;
  success: number;
  negativeHeld: number;
  failed: number;
  /** Rows whose order+item was already posted - marked SUPERSEDED. */
  skipped: number;
}

@Injectable()
export class InventoryUploadService {
  private readonly logger = new Logger(InventoryUploadService.name);

  constructor(
    private readonly aggregation: DailyAggregationService,
    private readonly transformation: OdooTransformationService,
    private readonly oracleClient: OracleClient,
    @InjectRepository(FusionInvTxn)
    private readonly invTxnRepo: Repository<FusionInvTxn>,
  ) {}

  /**
   * Converts and uploads one branch's business day. Never throws per row: a row
   * Oracle refuses (negative stock, unknown item, mapping gap) is recorded and
   * the rest of the day carries on.
   */
  async uploadDay(
    branchCode: string,
    businessDay: string,
  ): Promise<InventoryUploadResult> {
    const result: InventoryUploadResult = {
      branchCode,
      businessDay,
      totalRows: 0,
      success: 0,
      failed: 0,
      negativeHeld: 0,
      skipped: 0,
    };

    const { storeConfig, region, orders } =
      await this.aggregation.loadDayOrders(branchCode, businessDay);
    const subinventory = await this.resolveSubinventory(storeConfig, region);
    const rows = this.convertOrders(orders, businessDay, subinventory);
    result.totalRows = rows.length;
    if (rows.length === 0) return result;

    // Every row already recorded for these orders, keyed on order ref + item.
    // This also matches rows written by the earlier per-line implementation, so
    // switching to this upload never double-relieves a posted day.
    const existing = await this.loadExisting(
      [...new Set(rows.map((r) => r.TransactionReference))],
      region,
    );
    const orgIds = await this.resolveOrgIds(
      rows.map((r) => r.SubinventoryCode),
      `${branchCode} ${businessDay}`,
    );

    await mapWithConcurrency(rows, INVENTORY_CONCURRENCY, async (row) => {
      const prior =
        existing.get(
          this.postedKey(row.TransactionReference, row.ItemNumber),
        ) ?? [];
      if (prior.some((r) => r.status === 'SUCCESS')) {
        result.skipped += 1;
        return;
      }
      // Re-use the earlier failed/held row so a day keeps ONE row per
      // order+item, however many times it is re-run.
      const [reuse, ...older] = prior;
      const outcome = await this.uploadRow(
        row,
        orgIds.get(row.SubinventoryCode) ?? null,
        region,
        reuse,
      );
      await this.supersede(older, reuse?.id);
      this.count(result, outcome);
    });

    this.logger.log(
      `[${branchCode} ${businessDay}] inventory upload: ${result.totalRows} row(s) - ` +
        `${result.success} posted, ${result.negativeHeld} held (negative stock), ` +
        `${result.failed} failed, ${result.skipped} already posted`,
    );
    return result;
  }

  /**
   * Admin "reprocess": re-sends held/failed rows once the cause (usually
   * negative stock) is fixed in Oracle. Replays the exact payload that was
   * attempted; a row whose order+item has meanwhile been posted is superseded
   * instead of re-sent, so stock can never move twice.
   */
  async reprocess(filter: {
    ids?: string[];
    region?: string;
    statuses?: string[];
  }): Promise<InventoryReprocessResult> {
    const statuses = filter.statuses?.length
      ? filter.statuses.filter((st) => REPROCESSABLE.has(st))
      : [NEGATIVE_INVENTORY];
    const where = filter.ids?.length
      ? { id: In(filter.ids.slice(0, REPROCESS_LIMIT)), status: In(statuses) }
      : {
          status: In(statuses),
          ...(filter.region ? { region: filter.region } : {}),
        };
    const rows = statuses.length
      ? await this.invTxnRepo.find({
          where,
          order: { txnDate: 'ASC', createdAt: 'ASC' },
          take: REPROCESS_LIMIT,
        })
      : [];

    const result: InventoryReprocessResult = {
      selected: rows.length,
      success: 0,
      negativeHeld: 0,
      failed: 0,
      skipped: 0,
    };
    if (rows.length === 0) return result;

    const posted = new Set<string>();
    for (const [key, list] of await this.loadExistingForRows(rows)) {
      if (list.some((r) => r.status === 'SUCCESS')) posted.add(key);
    }
    const orgIds = await this.resolveOrgIds(
      rows.map((r) => r.subInventory ?? ''),
      'reprocess',
    );

    await mapWithConcurrency(rows, INVENTORY_CONCURRENCY, async (rec) => {
      const key = this.postedKey(rec.txnSourceName ?? '', rec.itemNumber ?? '');
      if (posted.has(key)) {
        await this.supersede([rec], undefined, 'Already posted by another row');
        result.skipped += 1;
        return;
      }
      const row = this.rowFromRecord(rec);
      if (!row) {
        await this.save({
          ...rec,
          status: 'ERROR',
          holdReason:
            'Cannot rebuild this row (missing date/UoM/qty) - re-run the integration for its day',
          retryCount: (rec.retryCount ?? 0) + 1,
          lastRetryAt: new Date(),
        });
        result.failed += 1;
        return;
      }
      const outcome = await this.uploadRow(
        row,
        orgIds.get(row.SubinventoryCode) ?? null,
        rec.region,
        rec,
        true,
      );
      if (outcome === 'SUCCESS') posted.add(key);
      this.count(result, outcome);
    });

    this.logger.log(
      `Inventory reprocess: ${result.selected} row(s) - ${result.success} posted, ` +
        `${result.negativeHeld} still negative, ${result.failed} failed, ${result.skipped} superseded`,
    );
    return result;
  }

  /** Held / failed rows for the admin panel, newest first. */
  async listHolds(params: {
    status?: string;
    region?: string;
    skip?: number;
    take?: number;
  }): Promise<{
    items: FusionInvTxn[];
    total: number;
    counts: Record<string, number>;
  }> {
    const status = params.status || NEGATIVE_INVENTORY;
    const regionWhere = params.region ? { region: params.region } : {};
    const [items, total] = await this.invTxnRepo.findAndCount({
      where: { status, ...regionWhere },
      order: { txnDate: 'DESC', updatedAt: 'DESC' },
      skip: Math.max(0, params.skip ?? 0),
      take: Math.min(Math.max(1, params.take ?? 50), 500),
    });
    const counts: Record<string, number> = {};
    for (const st of [NEGATIVE_INVENTORY, 'ERROR', 'SUCCESS']) {
      counts[st] = await this.invTxnRepo.count({
        where: { status: st, ...regionWhere },
      });
    }
    return { items, total, counts };
  }

  /**
   * Port of inventoryTemplateController.convertRecords for Odoo orders.
   * Aggregation key: subinventory | item | order ref | date | UoM.
   */
  convertOrders(
    orders: BackupOdooOrder[],
    businessDay: string,
    subinventory: string | null,
  ): InventoryUploadRow[] {
    const aggregated = new Map<
      string,
      Omit<InventoryUploadRow, 'TransactionTypeName'>
    >();

    for (const order of orders) {
      const state = (order.state ?? '').toLowerCase().trim();
      if (NON_INVOICEABLE_STATES.has(state)) continue;

      // "ALARIDAH/8371" — TransactionReference, and (reference fallback) the
      // subinventory is its prefix.
      const orderRef = (order.orderName ?? String(order.orderId)).trim();
      const sub =
        subinventory ||
        (orderRef.includes('/') ? orderRef.split('/')[0].trim() : '');
      if (!sub) {
        this.logger.warn(
          `Order ${orderRef}: no subinventory could be resolved — skipped`,
        );
        continue;
      }
      for (const line of order.orderLines ?? []) {
        const itemNumber = line.productCode?.trim();
        if (!itemNumber) continue; // reference: missing barcode rows are skipped
        const qty = Number(line.qty ?? 0);
        if (!Number.isFinite(qty) || qty === 0) continue;
        const uom =
          line.baseUomName?.trim() ||
          line.productUomName?.trim() ||
          DEFAULT_UOM;

        const key = [sub, itemNumber, orderRef, businessDay, uom].join('|||');
        const existing = aggregated.get(key);
        if (existing) {
          existing.TransactionQuantity += qty;
        } else {
          aggregated.set(key, {
            ItemNumber: itemNumber,
            SubinventoryCode: sub,
            TransactionDate: businessDay,
            TransactionQuantity: qty,
            TransactionReference: orderRef,
            TransactionUnitOfMeasure: uom,
          });
        }
      }
    }

    const rows: InventoryUploadRow[] = [];
    for (const row of aggregated.values()) {
      // Odoo sale (+) → Oracle issue (-); Odoo refund (-) → Oracle RMA (+).
      const finalQty = this.round(-row.TransactionQuantity);
      if (finalQty === 0) continue;
      rows.push({
        ...row,
        TransactionQuantity: finalQty,
        TransactionTypeName: finalQty > 0 ? RMA_TYPE : SALES_ISSUE_TYPE,
      });
    }
    return rows;
  }

  /** Port of inventoryController.mapRowToPayload. */
  buildPayload(
    row: InventoryUploadRow,
    organizationId: number | null,
  ): InventoryStagedTransactionPayload {
    const organizationName =
      process.env.ORACLE_INVENTORY_ORGANIZATION_NAME?.trim();
    return {
      // The reference sends the organisation the operator typed in; here it is
      // the org that owns the subinventory (or a fixed name when configured).
      ...(organizationName
        ? { OrganizationName: organizationName }
        : { OrganizationId: organizationId ?? undefined }),
      TransactionTypeName: row.TransactionTypeName,
      ItemNumber: row.ItemNumber,
      SubinventoryCode: row.SubinventoryCode,
      TransactionDate: `${row.TransactionDate}T00:00:00.000+00:00`,
      TransactionQuantity: String(row.TransactionQuantity),
      TransactionReference: row.TransactionReference,
      ExternalSystemTransactionReference: row.TransactionReference,
      TransactionUnitOfMeasure: row.TransactionUnitOfMeasure,
      SourceHeaderId: '1',
      SourceLineId: '0',
      TransactionMode: '1',
      SourceCode: 'SERVICE',
      UseCurrentCostFlag: 'true',
    };
  }

  /**
   * Port of inventoryController.processRow. Records the outcome on `existing`
   * when given (re-run / reprocess) so a row is never duplicated.
   */
  private async uploadRow(
    row: InventoryUploadRow,
    organizationId: number | null,
    region: string,
    existing?: FusionInvTxn,
    isRetry = false,
  ): Promise<RowOutcome> {
    const record: Partial<FusionInvTxn> = {
      id: existing?.id ?? generateId(),
      organizationName:
        process.env.ORACLE_INVENTORY_ORGANIZATION_NAME?.trim() ||
        (organizationId != null ? String(organizationId) : null),
      itemNumber: row.ItemNumber,
      txnSourceName: row.TransactionReference,
      sourceLineRef: `${row.TransactionReference}|${row.ItemNumber}|${row.TransactionUnitOfMeasure}`,
      subInventory: row.SubinventoryCode,
      txnUom: row.TransactionUnitOfMeasure,
      txnDate: new Date(`${row.TransactionDate}T00:00:00.000Z`),
      txnQty: row.TransactionQuantity,
      txnType: row.TransactionTypeName,
      region,
      requestDate: new Date(),
      retryCount: isRetry
        ? (existing?.retryCount ?? 0) + 1
        : (existing?.retryCount ?? 0),
      lastRetryAt: isRetry ? new Date() : (existing?.lastRetryAt ?? null),
    };

    if (
      organizationId == null &&
      !process.env.ORACLE_INVENTORY_ORGANIZATION_NAME?.trim()
    ) {
      const reason =
        `Mapping: subinventory "${row.SubinventoryCode}" not found in Oracle ` +
        `(activeSubinventories) - check FusionSalesMetadata SUBINVENTORY for this store`;
      await this.save({
        ...record,
        status: 'ERROR',
        holdReason: reason,
        message: reason,
      });
      return 'ERROR';
    }

    const payload = this.buildPayload(row, organizationId);
    const payloadJson = JSON.stringify(payload);
    record.requestPayload = payloadJson;
    try {
      const { status, data } =
        await this.oracleClient.postInventoryStagedTransaction(payload);
      const responseText = this.stringifyBody(data, `HTTP ${status}`);
      const embeddedError = this.extractOracleError(data);
      const body = this.isRecord(data) ? data : {};
      const interfaceId = Number(body['TransactionInterfaceId']);
      if (Number.isFinite(interfaceId)) record.requestId = interfaceId;

      if (embeddedError) {
        this.logger.error(
          `[${row.SubinventoryCode}] ${row.TransactionReference} ${row.ItemNumber} FAILED ` +
            `(ProcessStatus=${this.str(body['ProcessStatus'], 'N/A')} ErrorCode=${this.str(body['ErrorCode'], 'N/A')}): ` +
            `${embeddedError} | HTTP ${status}`,
        );
        return this.saveFailure(
          record,
          row,
          embeddedError,
          `${embeddedError}\nRequest: ${payloadJson}\nResponse (HTTP ${status}): ${responseText}`,
        );
      }

      await this.save({
        ...record,
        status: 'SUCCESS',
        holdReason: null,
        message: this.truncate(
          `${row.TransactionTypeName} | HTTP ${status}\nRequest: ${payloadJson}\nResponse: ${responseText}`,
        ),
      });
      return 'SUCCESS';
    } catch (err) {
      const e = err as {
        message?: string;
        response?: { status?: number; statusText?: string; data?: unknown };
      };
      const resData = e.response?.data;
      const resBody = this.isRecord(resData) ? resData : {};
      const errMsg =
        (typeof resBody['detail'] === 'string' && resBody['detail']) ||
        (typeof resBody['message'] === 'string' && resBody['message']) ||
        (typeof resData === 'string' && resData.trim()) ||
        e.message ||
        'Oracle API error';
      const errorBody = this.stringifyBody(
        resData,
        e.response?.statusText || e.message || 'No response body',
      );
      this.logger.error(
        `[${row.SubinventoryCode}] ${row.TransactionReference} ${row.ItemNumber} FAILED (API): ` +
          `${String(errMsg).slice(0, 500)} | HTTP ${e.response?.status ?? 'N/A'}`,
      );
      return this.saveFailure(
        record,
        row,
        errMsg === errorBody ? errMsg : `${errMsg} ${errorBody}`,
        `${errMsg}\nRequest: ${payloadJson}\nResponse (HTTP ${e.response?.status ?? 'N/A'}): ${errorBody}`,
      );
    }
  }

  /** ERROR, or NEGATIVE_INVENTORY when Oracle refused for lack of stock. */
  private async saveFailure(
    record: Partial<FusionInvTxn>,
    row: InventoryUploadRow,
    reasonText: string,
    fullMessage: string,
  ): Promise<RowOutcome> {
    const negative =
      row.TransactionQuantity < 0 && this.isNegativeInventoryError(reasonText);
    const status: RowOutcome = negative ? NEGATIVE_INVENTORY : 'ERROR';
    const reason = reasonText.replace(/\s+/g, ' ').trim();
    await this.save({
      ...record,
      status,
      holdReason: (negative
        ? `Negative stock in ${row.SubinventoryCode}: ${reason}`
        : reason
      ).slice(0, 1000),
      message: this.truncate(fullMessage),
    });
    return status;
  }

  /**
   * Oracle's "would drive on-hand negative / not enough stock" rejections.
   * Extendable via ORACLE_NEGATIVE_INVENTORY_PATTERN (a regex) when a pod words
   * it differently.
   */
  private isNegativeInventoryError(text: string): boolean {
    if (NEGATIVE_STOCK_PATTERN.test(text)) return true;
    const extra = process.env.ORACLE_NEGATIVE_INVENTORY_PATTERN?.trim();
    if (!extra) return false;
    try {
      return new RegExp(extra, 'i').test(text);
    } catch {
      return false;
    }
  }

  /** Rebuilds a template row from a stored record (for reprocess). */
  private rowFromRecord(rec: FusionInvTxn): InventoryUploadRow | null {
    if (rec.requestPayload) {
      try {
        const p = JSON.parse(
          rec.requestPayload,
        ) as Partial<InventoryStagedTransactionPayload>;
        if (
          p.ItemNumber &&
          p.SubinventoryCode &&
          p.TransactionDate &&
          p.TransactionQuantity &&
          p.TransactionUnitOfMeasure &&
          p.TransactionTypeName
        ) {
          return {
            TransactionTypeName: p.TransactionTypeName,
            ItemNumber: p.ItemNumber,
            SubinventoryCode: p.SubinventoryCode,
            TransactionDate: p.TransactionDate.slice(0, 10),
            TransactionQuantity: Number(p.TransactionQuantity),
            TransactionReference:
              p.TransactionReference ?? rec.txnSourceName ?? '',
            TransactionUnitOfMeasure: p.TransactionUnitOfMeasure,
          };
        }
      } catch {
        // fall through to the columns
      }
    }
    // Rows written before payloads were stored: rebuild from the columns.
    const qty = Number(rec.txnQty);
    if (
      !rec.itemNumber ||
      !rec.subInventory ||
      !rec.txnDate ||
      !rec.txnUom ||
      !Number.isFinite(qty) ||
      qty === 0
    ) {
      return null;
    }
    return {
      TransactionTypeName:
        rec.txnType || (qty > 0 ? RMA_TYPE : SALES_ISSUE_TYPE),
      ItemNumber: rec.itemNumber,
      SubinventoryCode: rec.subInventory,
      TransactionDate: new Date(rec.txnDate).toISOString().slice(0, 10),
      TransactionQuantity: qty,
      TransactionReference: rec.txnSourceName ?? '',
      TransactionUnitOfMeasure: rec.txnUom,
    };
  }

  private count(
    result: { success: number; negativeHeld: number; failed: number },
    outcome: RowOutcome,
  ): void {
    if (outcome === 'SUCCESS') result.success += 1;
    else if (outcome === NEGATIVE_INVENTORY) result.negativeHeld += 1;
    else result.failed += 1;
  }

  /** Marks duplicate older rows so the admin panel shows one row per order+item. */
  private async supersede(
    rows: FusionInvTxn[],
    replacedById?: string,
    reason?: string,
  ): Promise<void> {
    const targets = rows.filter((r) => r.status !== 'SUCCESS');
    if (targets.length === 0) return;
    try {
      await this.invTxnRepo.update(
        { id: In(targets.map((r) => r.id)) },
        {
          status: 'SUPERSEDED',
          holdReason:
            reason ??
            (replacedById ? `Replaced by row ${replacedById}` : 'Replaced'),
        },
      );
    } catch (err) {
      this.logger.warn(
        `Could not mark ${targets.length} row(s) superseded: ${(err as Error).message}`,
      );
    }
  }

  /** Oracle organisation per subinventory (cached in the client). */
  private async resolveOrgIds(
    subinventories: string[],
    context: string,
  ): Promise<Map<string, number | null>> {
    const orgIds = new Map<string, number | null>();
    for (const sub of new Set(subinventories.filter(Boolean))) {
      try {
        orgIds.set(sub, await this.oracleClient.resolveSubinventoryOrgId(sub));
      } catch (err) {
        this.logger.warn(
          `[${context}] could not resolve inventory org for subinventory ` +
            `"${sub}": ${(err as Error).message}`,
        );
        orgIds.set(sub, null);
      }
    }
    return orgIds;
  }

  /**
   * Subinventory stock is moved in: the store's FusionSalesMetadata SUBINVENTORY
   * (the same value the invoice bill-to keys on). When that cannot be resolved
   * the reference rule applies per order — the order ref's prefix.
   */
  private async resolveSubinventory(
    storeConfig: StoreConfiguration,
    region: string,
  ): Promise<string | null> {
    try {
      const meta = await this.transformation.resolveBillToForAggregate(
        'NORMAL',
        region,
        storeConfig.branchName,
      );
      const sub = meta?.subinventory?.trim();
      if (sub) return sub;
      this.logger.warn(
        `[${storeConfig.branchCode}] no NORMAL FusionSalesMetadata row with ` +
          `SUBINVENTORY matching store "${storeConfig.branchName}" (${region}) - ` +
          `falling back to the order-ref prefix`,
      );
    } catch (err) {
      this.logger.warn(
        `[${storeConfig.branchCode}] subinventory lookup failed, falling back ` +
          `to order-ref prefix: ${(err as Error).message}`,
      );
    }
    return null;
  }

  /**
   * Every live row (not SUPERSEDED) recorded for these order refs, grouped by
   * order ref + item, most recently updated first.
   */
  private async loadExisting(
    orderRefs: string[],
    region: string,
  ): Promise<Map<string, FusionInvTxn[]>> {
    const byKey = new Map<string, FusionInvTxn[]>();
    for (let i = 0; i < orderRefs.length; i += 1000) {
      const found = await this.invTxnRepo.find({
        where: {
          txnSourceName: In(orderRefs.slice(i, i + 1000)),
          region,
          status: In(['SUCCESS', 'ERROR', NEGATIVE_INVENTORY, 'PENDING']),
        },
        order: { updatedAt: 'DESC' },
      });
      for (const r of found) {
        if (!r.txnSourceName || !r.itemNumber) continue;
        const key = this.postedKey(r.txnSourceName, r.itemNumber);
        const list = byKey.get(key);
        if (list) list.push(r);
        else byKey.set(key, [r]);
      }
    }
    return byKey;
  }

  /** {@link loadExisting} for a set of stored rows, across regions. */
  private async loadExistingForRows(
    rows: FusionInvTxn[],
  ): Promise<Map<string, FusionInvTxn[]>> {
    const merged = new Map<string, FusionInvTxn[]>();
    const byRegion = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.txnSourceName) continue;
      const set = byRegion.get(r.region) ?? new Set<string>();
      set.add(r.txnSourceName);
      byRegion.set(r.region, set);
    }
    for (const [region, refs] of byRegion) {
      for (const [k, v] of await this.loadExisting([...refs], region)) {
        merged.set(k, [...(merged.get(k) ?? []), ...v]);
      }
    }
    return merged;
  }

  private postedKey(orderRef: string, itemNumber: string): string {
    return `${orderRef}|${itemNumber}`;
  }

  private async save(record: Partial<FusionInvTxn>): Promise<void> {
    try {
      await this.invTxnRepo.save(this.invTxnRepo.create(record));
    } catch (err) {
      this.logger.error(
        `Failed to record inventory txn ${record.txnSourceName} ${record.itemNumber}: ` +
          `${(err as Error).message}`,
      );
    }
  }

  /** Port of inventoryController.extractOracleError. */
  private extractOracleError(responseBody: unknown): string | null {
    let parsed: unknown = responseBody;
    if (typeof responseBody === 'string') {
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        parsed = responseBody;
      }
    }

    if (this.isRecord(parsed) && !Array.isArray(parsed)) {
      // ProcessStatus: "1" success, "2" pending, "3" rejected.
      const processStatus =
        parsed['ProcessStatus'] != null
          ? this.str(parsed['ProcessStatus'])
          : null;
      const errorCode = this.str(parsed['ErrorCode'], '').trim();
      const errorExplanation = this.str(parsed['ErrorExplanation'], '').trim();
      if (processStatus === '3') {
        if (errorCode && errorExplanation)
          return `[${errorCode}] ${errorExplanation}`;
        if (errorCode) return `Oracle error code: ${errorCode}`;
        if (errorExplanation) return errorExplanation;
        return 'Oracle ProcessStatus=3 (transaction rejected)';
      }
      if (errorCode) {
        return `[${errorCode}]${errorExplanation ? ` ${errorExplanation}` : ''}`;
      }
    }

    const normalize = (val: unknown): string | null => {
      if (val === null || val === undefined) return null;
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (!trimmed || trimmed.toLowerCase() === 'success') return null;
        return trimmed;
      }
      if (Array.isArray(val)) {
        for (const entry of val) {
          const found = normalize(entry);
          if (found) return found;
        }
        return null;
      }
      if (this.isRecord(val)) {
        for (const field of [
          'error',
          'Error',
          'ERROR',
          'errors',
          'Errors',
          'ERRORS',
          'errorMessage',
          'ErrorMessage',
        ]) {
          if (Object.prototype.hasOwnProperty.call(val, field)) {
            const found = normalize(val[field]);
            if (found) return found;
          }
        }
      }
      return null;
    };
    // Only scan error fields of an object body — a bare string 2xx body is not
    // an error by itself.
    return this.isRecord(parsed) ? normalize(parsed) : null;
  }

  private stringifyBody(body: unknown, fallback = ''): string {
    if (body === undefined || body === null) return fallback;
    if (typeof body === 'string') return body.trim() ? body : fallback || body;
    try {
      const json = JSON.stringify(body);
      return json === '{}' && fallback ? fallback : json;
    } catch {
      return fallback;
    }
  }

  private truncate(text: string, max = 30_000): string {
    return text.length > max ? text.slice(0, max) : text;
  }

  /** Avoids float noise from summing (0.1 + 0.2) in the quantity sent. */
  private round(n: number): number {
    return Math.round(n * 1e6) / 1e6;
  }

  /** Primitive → string; objects/null → fallback (never "[object Object]"). */
  private str(value: unknown, fallback = ''): string {
    return typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
      ? String(value)
      : fallback;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
