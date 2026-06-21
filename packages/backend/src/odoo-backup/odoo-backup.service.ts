/**
 * OdooBackupService — scheduled backup of orders from the main Odoo instance
 * (configured via ODOO_BASE_URL / ODOO_API_KEY env vars) into local PostgreSQL
 * backup tables.
 *
 * Runs every 15 minutes. On each run it:
 *  1. Reads the lastSyncAt watermark from OdooBackupState.
 *  2. Fetches orders from Odoo using that watermark as startDate.
 *  3. Upserts each order into BackupOdooOrder / BackupOdooOrderLine /
 *     BackupOdooOrderPayment.
 *  4. Advances the lastSyncAt watermark.
 *
 * The service also exposes a `backupOrders` method used by the manual
 * fetch-odoo endpoint so raw data is persisted before processing.
 *
 * Per-region Odoo credentials can be stored in the OdooCredential table and
 * used by the manual fetch-odoo endpoint instead of the global env vars.
 */
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import {
  OdooClient,
  OdooOrder,
  OdooOrderLine,
  OdooOrderPayment,
} from '../clients/odoo/odoo.client';
import { normalizeOrderForIngestion } from '../common/odoo-utils';
import { PrismaService } from '../prisma/prisma.service';
import { OrderSyncService } from '../sync/order-sync.service';

const DEFAULT_SOURCE = 'default';

/** Extract the integer id from an Odoo Many2one field ([id, name] or plain id) */
function resolveId(
  field: number | [number, string] | null | undefined,
): number | null {
  if (field == null) return null;
  if (Array.isArray(field)) return field[0] ?? null;
  return typeof field === 'number' ? field : null;
}

/** Extract the name string from an Odoo Many2one field */
function resolveName(
  field: number | [number, string] | null | undefined,
): string | null {
  if (field == null) return null;
  if (Array.isArray(field)) return field[1] ?? null;
  return null;
}

/** Resolve ordered quantity from a line — POS uses "qty", sale orders use "product_uom_qty" */
function resolveQty(line: OdooOrderLine): number | null {
  if (line.qty != null) return Number(line.qty);
  if (line.product_uom_qty != null) return Number(line.product_uom_qty);
  return null;
}

@Injectable()
export class OdooBackupService {
  private readonly logger = new Logger(OdooBackupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly odooClient: OdooClient,
    @Inject(forwardRef(() => OrderSyncService))
    private readonly orderSyncService: OrderSyncService,
  ) {}

  /**
   * Scheduled cron: backs up all new/updated Odoo orders every 15 minutes
   * using the lastSyncAt watermark stored in OdooBackupState.
   */
  @Cron('0 */15 * * * *')
  async runBackupJob(): Promise<void> {
    try {
      const state = await this.prisma.odooBackupState.findUnique({
        where: { source: DEFAULT_SOURCE },
      });

      const startDate = state?.lastSyncAt
        ? state.lastSyncAt.toISOString()
        : undefined;

      const runAt = new Date();
      const result = await this.backupOrders({ startDate, limit: 500 });

      // Advance the watermark after a successful cron run
      await this.prisma.odooBackupState.upsert({
        where: { source: DEFAULT_SOURCE },
        create: { source: DEFAULT_SOURCE, lastSyncAt: runAt },
        update: { lastSyncAt: runAt },
      });

      // Ingest backed-up orders into the OrderSyncQueue so the downstream
      // pipeline (BullMQ → Oracle) has real data to process.
      // Note: backup (saved/backupSkipped) and ingestion (ingested/ingestSkipped)
      // are counted separately — an order can be backed up successfully while
      // failing ingestion (e.g. missing branch mapping), and vice-versa retries
      // can re-ingest from backup without re-fetching from Odoo.
      let ingested = 0;
      let ingestSkipped = 0;
      for (const order of result.orders) {
        try {
          const payload = normalizeOrderForIngestion(order);
          if (!payload) {
            ingestSkipped++;
            continue;
          }
          await this.orderSyncService.ingestOrder(payload);
          ingested++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Failed to ingest Odoo order id=${String(order.id)}: ${msg}`,
          );
          ingestSkipped++;
        }
      }

      this.logger.log(
        `Odoo backup+ingest done: ` +
          `backup.saved=${result.saved} backup.skipped=${result.skipped} ` +
          `ingest.queued=${ingested} ingest.skipped=${ingestSkipped}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Odoo backup cron failed: ${msg}`);
    }
  }

  /**
   * Fetches orders from Odoo using the given parameters and persists them to
   * backup tables.  Returns the saved/skipped counts and the raw order list so
   * callers (e.g. the fetch-odoo endpoint) can continue processing them.
   * Does NOT advance the lastSyncAt watermark — that is the cron's responsibility.
   */
  async backupOrders(params: {
    branchId?: number;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<{ saved: number; skipped: number; orders: OdooOrder[] }> {
    const orders = await this.odooClient.getOrders({
      branchId: params.branchId,
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit ?? 100,
    });

    let saved = 0;
    let skipped = 0;

    for (const order of orders) {
      try {
        await this.upsertOrder(order);
        saved++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to persist Odoo order id=${order.id} name=${order.name ?? 'no-name'}: ${msg}`,
        );
        skipped++;
      }
    }

    return { saved, skipped, orders };
  }

  /**
   * Fetches orders from a specific OdooCredential (per-region DB credential)
   * and persists them to backup tables.
   * Uses a temporary axios instance scoped to the credential's baseUrl/apiKey.
   * Does NOT advance the lastSyncAt watermark — callers decide that.
   */
  async backupOrdersForCredential(
    cred: { id: string; baseUrl: string; apiKey: string; region: string },
    params: {
      branchId?: number;
      startDate?: string;
      endDate?: string;
      limit?: number;
    },
  ): Promise<{ saved: number; skipped: number; orders: OdooOrder[] }> {
    const baseUrl = cred.baseUrl.replace(/\/$/, '');
    const resp = await axios.get<unknown>(`${baseUrl}/api/pos/order`, {
      headers: { 'x-api-key': cred.apiKey },
      params: {
        ...(params.branchId !== undefined && { branch_id: params.branchId }),
        ...(params.startDate && { start_date: params.startDate }),
        ...(params.endDate && { end_date: params.endDate }),
        limit: params.limit ?? 100,
      },
      timeout: 30_000,
    });

    const orders = this.extractOrderList(resp.data);
    let saved = 0;
    let skipped = 0;

    for (const order of orders) {
      try {
        await this.upsertOrder(order);
        saved++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to persist Odoo order id=${order.id} name=${order.name ?? 'no-name'} region=${cred.region}: ${msg}`,
        );
        skipped++;
      }
    }

    return { saved, skipped, orders };
  }

  /** Flatten various Odoo REST API response envelopes to a plain order array. */
  private extractOrderList(payload: unknown): OdooOrder[] {
    if (Array.isArray(payload)) return payload as OdooOrder[];
    if (typeof payload === 'object' && payload !== null) {
      const p = payload as Record<string, unknown>;
      if (Array.isArray(p['records'])) return p['records'] as OdooOrder[];
      if (Array.isArray(p['result'])) return p['result'] as OdooOrder[];
      if (Array.isArray(p['data'])) return p['data'] as OdooOrder[];
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Upserts one Odoo order and its related line items and payments.
   * Uses the @@unique([orderId]) constraint on BackupOdooOrder to prevent
   * duplicate header rows.
   */
  private async upsertOrder(order: OdooOrder): Promise<void> {
    const branchId = resolveId(order.branch_id);
    const branchName = resolveName(order.branch_id);
    const partnerId = resolveId(order.partner_id);
    const partnerName = resolveName(order.partner_id);
    const dateOrder = order.date_order ? new Date(order.date_order) : null;

    const orderData = {
      orderName: order.name ?? null,
      branchId,
      branchName,
      dateOrder,
      amountTotal: order.amount_total != null ? Number(order.amount_total) : null,
      amountTax: order.amount_tax != null ? Number(order.amount_tax) : null,
      state: typeof order.state === 'string' ? order.state : null,
      partnerId,
      partnerName,
      timezone: typeof order.timezone === 'string' ? order.timezone : null,
      rawJson: order as object,
    };

    const upserted = await this.prisma.backupOdooOrder.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, ...orderData },
      update: orderData,
      select: { id: true },
    });
    const parentId = upserted.id;

    // ── Order lines ──────────────────────────────────────────────────────────
    const lines: OdooOrderLine[] = Array.isArray(order.lines)
      ? order.lines
      : Array.isArray(order.order_line)
        ? order.order_line
        : [];

    if (lines.length > 0) {
      // Pre-fetch all existing lines for this order to avoid N+1 queries
      const existingLines = await this.prisma.backupOdooOrderLine.findMany({
        where: { orderId: order.id },
        select: { id: true, lineId: true },
      });
      const existingLineMap = new Map(
        existingLines
          .filter((l) => l.lineId != null)
          .map((l) => [l.lineId as number, l.id]),
      );

      for (const line of lines) {
        const productId = resolveId(line.product_id);
        const productName = resolveName(line.product_id);
        const lineId = typeof line.id === 'number' ? line.id : null;

        const lineData = {
          orderId: order.id,
          lineId,
          productId,
          productName,
          qty: resolveQty(line),
          priceUnit: line.price_unit != null ? Number(line.price_unit) : null,
          priceSubtotal: line.price_subtotal != null ? Number(line.price_subtotal) : null,
          priceSubtotalIncl: line.price_subtotal_incl != null ? Number(line.price_subtotal_incl) : null,
          discount: line.discount != null ? Number(line.discount) : null,
          parentOrderId: parentId,
        };

        const existingId = lineId != null ? existingLineMap.get(lineId) : undefined;
        if (existingId) {
          await this.prisma.backupOdooOrderLine.update({
            where: { id: existingId },
            data: lineData,
          });
        } else {
          await this.prisma.backupOdooOrderLine.create({ data: lineData });
        }
      }
    }

    // ── Payments — Odoo v15 uses statement_ids, v18 may use payment_ids ──────
    const rawPayments: OdooOrderPayment[] = Array.isArray(order.statement_ids)
      ? order.statement_ids
      : Array.isArray(order.payment_ids)
        ? order.payment_ids
        : [];

    if (rawPayments.length > 0) {
      // Pre-fetch all existing payments for this order to avoid N+1 queries
      const existingPayments = await this.prisma.backupOdooOrderPayment.findMany({
        where: { orderId: order.id },
        select: { id: true, paymentId: true },
      });
      const existingPaymentMap = new Map(
        existingPayments
          .filter((p) => p.paymentId != null)
          .map((p) => [p.paymentId as number, p.id]),
      );

      for (const pmt of rawPayments) {
        const pmtId = typeof pmt.id === 'number' ? pmt.id : null;

        const pmtData = {
          orderId: order.id,
          paymentId: pmtId,
          paymentName: typeof pmt.name === 'string' ? pmt.name : null,
          amount: pmt.amount != null ? Number(pmt.amount) : null,
          parentOrderId: parentId,
        };

        const existingId = pmtId != null ? existingPaymentMap.get(pmtId) : undefined;
        if (existingId) {
          await this.prisma.backupOdooOrderPayment.update({
            where: { id: existingId },
            data: pmtData,
          });
        } else {
          await this.prisma.backupOdooOrderPayment.create({ data: pmtData });
        }
      }
    }
  }
}

