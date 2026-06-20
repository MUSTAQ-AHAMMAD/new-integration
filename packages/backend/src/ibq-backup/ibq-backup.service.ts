/**
 * IbqBackupService — scheduled backup of POS orders from the IBQ (Odoo)
 * REST API into local PostgreSQL tables.
 *
 * Runs every 15 minutes. For each active IbqCredential it:
 *  1. Checks that the region is not disabled (SalesIntegrationStatus with
 *     integMode = 'IBQ_BACKUP').
 *  2. Fetches POS orders from GET /api/pos/order using a start_date watermark
 *     (lastSyncAt) so only new/updated records are retrieved each run.
 *  3. Upserts each order into BackupIbqOrder / BackupIbqOrderLine /
 *     BackupIbqOrderPayment.
 *  4. Advances the lastSyncAt watermark on the credential.
 *
 * The IBQ API uses x-api-key header authentication (Odoo REST API convention).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { PrismaService } from '../prisma/prisma.service';

// ---------------------------------------------------------------------------
// Raw IBQ / Odoo POS API response shapes
// ---------------------------------------------------------------------------

interface IbqOrderLineRaw {
  id?: number;
  product_id?: number | [number, string];
  qty?: number;
  price_unit?: number;
  price_subtotal?: number;
  price_subtotal_incl?: number;
  discount?: number;
  [key: string]: unknown;
}

interface IbqOrderPaymentRaw {
  id?: number;
  name?: string;
  amount?: number;
  [key: string]: unknown;
}

interface IbqOrderRaw {
  id: number;
  name?: string;
  pos_reference?: string;
  date_order?: string;
  amount_total?: number;
  amount_tax?: number;
  amount_paid?: number;
  state?: string;
  company_id?: number | [number, string];
  config_id?: number | [number, string];
  partner_id?: number | [number, string] | null;
  lines?: IbqOrderLineRaw[];
  /// Odoo v15/v18 may return payments as statement_ids or payment_ids
  statement_ids?: IbqOrderPaymentRaw[];
  payment_ids?: IbqOrderPaymentRaw[];
  [key: string]: unknown;
}

/** Possible wrappers the IBQ API uses around the order array */
interface IbqApiResponse {
  result?: IbqOrderRaw[] | { orders?: IbqOrderRaw[]; data?: IbqOrderRaw[] };
  data?: IbqOrderRaw[];
  orders?: IbqOrderRaw[];
  [key: string]: unknown;
}

/** Integration mode label reused from SalesIntegrationStatus */
const IBQ_INTEG_MODE = 'IBQ_BACKUP';
const STATUS_ENABLED = 'ENABLED';
const STATUS_DISABLED = 'DISABLED';

/** Format a Date as the MM/DD/YYYY HH:MM:SS string the IBQ API expects */
function toIbqDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Extract the integer id from an Odoo Many2one field ([id, name] or plain id) */
function resolveId(field: number | [number, string] | null | undefined): number | null {
  if (field == null) return null;
  if (Array.isArray(field)) return field[0] ?? null;
  return typeof field === 'number' ? field : null;
}

/** Extract the name string from an Odoo Many2one field */
function resolveName(field: number | [number, string] | null | undefined): string | null {
  if (field == null) return null;
  if (Array.isArray(field)) return field[1] ?? null;
  return null;
}

/** Flatten an IBQ API response envelope into a plain order array */
function extractOrders(raw: IbqApiResponse): IbqOrderRaw[] {
  if (Array.isArray(raw)) return raw as IbqOrderRaw[];
  if (Array.isArray(raw.result)) return raw.result as IbqOrderRaw[];
  if (raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result)) {
    const r = raw.result as { orders?: IbqOrderRaw[]; data?: IbqOrderRaw[] };
    if (Array.isArray(r.orders)) return r.orders;
    if (Array.isArray(r.data)) return r.data;
  }
  if (Array.isArray(raw.data)) return raw.data as IbqOrderRaw[];
  if (Array.isArray(raw.orders)) return raw.orders as IbqOrderRaw[];
  return [];
}

@Injectable()
export class IbqBackupService {
  private readonly logger = new Logger(IbqBackupService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs every 15 minutes to back up IBQ POS orders.
   * Can also be triggered manually via IbqBackupController.
   */
  @Cron('0 */15 * * * *')
  async runBackupJob(): Promise<void> {
    const credentials = await this.prisma.ibqCredential.findMany({
      where: { active: true },
    });

    if (credentials.length === 0) {
      this.logger.warn('No active IBQ credentials found — backup skipped');
      return;
    }

    for (const cred of credentials) {
      try {
        const enabled = await this.isRegionEnabled(cred.region);
        if (!enabled) {
          this.logger.log(`IBQ backup skipped for region=${cred.region} — integration is DISABLED`);
          continue;
        }

        const result = await this.backupRegion(cred);
        this.logger.log(
          `IBQ backup done for region=${cred.region}: saved=${result.saved} skipped=${result.skipped}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`IBQ backup failed for region=${cred.region} url=${cred.baseUrl}: ${msg}`);
      }
    }
  }

  /**
   * Fetches and persists all new POS orders for one IBQ credential.
   * Uses lastSyncAt as the start_date watermark so only new/updated orders
   * are fetched on each run.
   * Exposed publicly so the controller can trigger a manual run.
   */
  async backupRegion(cred: {
    id: string;
    baseUrl: string;
    apiKey: string;
    companyId: number | null;
    region: string;
    lastSyncAt: Date | null;
  }): Promise<{ saved: number; skipped: number }> {
    const params: Record<string, string | number> = { limit: 500 };

    if (cred.companyId != null) {
      params['company_id'] = cred.companyId;
    }
    if (cred.lastSyncAt) {
      params['start_date'] = toIbqDate(cred.lastSyncAt);
    }

    const baseUrl = cred.baseUrl.replace(/\/$/, '');
    const resp = await axios.get<IbqApiResponse>(`${baseUrl}/api/pos/order`, {
      headers: {
        'x-api-key': cred.apiKey,
        'Content-Type': 'application/json',
      },
      params,
      timeout: 30_000,
    });

    const orders = extractOrders(resp.data ?? {});
    let saved = 0;
    let skipped = 0;
    const runAt = new Date();

    for (const order of orders) {
      try {
        const wasNew = await this.upsertOrder(order, cred.region);
        if (wasNew) saved++;
        else skipped++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to persist IBQ order id=${order.id} name=${order.name ?? 'no-name'} region=${cred.region}: ${msg}`,
        );
        skipped++;
      }
    }

    // Advance watermark even if no orders arrived so we don't re-scan history
    await this.prisma.ibqCredential.update({
      where: { id: cred.id },
      data: { lastSyncAt: runAt },
    });

    return { saved, skipped };
  }

  // ---------------------------------------------------------------------------
  // Region control helpers (reuse SalesIntegrationStatus pattern)
  // ---------------------------------------------------------------------------

  async isRegionEnabled(region: string): Promise<boolean> {
    const record = await this.prisma.salesIntegrationStatus.findUnique({
      where: { region_integMode: { region, integMode: IBQ_INTEG_MODE } },
    });
    return !record || record.status !== STATUS_DISABLED;
  }

  async enableRegion(region: string): Promise<{ region: string; status: string }> {
    const record = await this.prisma.salesIntegrationStatus.upsert({
      where: { region_integMode: { region, integMode: IBQ_INTEG_MODE } },
      create: { region, integMode: IBQ_INTEG_MODE, status: STATUS_ENABLED },
      update: { status: STATUS_ENABLED },
    });
    this.logger.log(`IBQ integration ENABLED for region=${region}`);
    return { region: record.region, status: record.status };
  }

  async disableRegion(region: string): Promise<{ region: string; status: string }> {
    const record = await this.prisma.salesIntegrationStatus.upsert({
      where: { region_integMode: { region, integMode: IBQ_INTEG_MODE } },
      create: { region, integMode: IBQ_INTEG_MODE, status: STATUS_DISABLED },
      update: { status: STATUS_DISABLED },
    });
    this.logger.log(`IBQ integration DISABLED for region=${region}`);
    return { region: record.region, status: record.status };
  }

  async getRegionStatus(region: string): Promise<{
    region: string;
    integrationStatus: string;
    credentials: Array<{
      id: string;
      baseUrl: string;
      companyId: number | null;
      active: boolean;
      lastSyncAt: Date | null;
    }>;
  }> {
    const [statusRecord, credentials] = await Promise.all([
      this.prisma.salesIntegrationStatus.findUnique({
        where: { region_integMode: { region, integMode: IBQ_INTEG_MODE } },
      }),
      this.prisma.ibqCredential.findMany({
        where: { region },
        select: {
          id: true,
          baseUrl: true,
          companyId: true,
          active: true,
          lastSyncAt: true,
        },
      }),
    ]);

    return {
      region,
      integrationStatus: statusRecord?.status ?? STATUS_ENABLED,
      credentials,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Upserts one IBQ POS order and its line items + payments.
   * Returns true when the record was new or updated, false when skipped.
   * Uses the @@unique([orderId, region]) constraint to prevent duplicates.
   */
  private async upsertOrder(order: IbqOrderRaw, region: string): Promise<boolean> {
    const dateOrder = order.date_order ? new Date(order.date_order) : null;

    const companyId = resolveId(order.company_id);
    const companyName = resolveName(order.company_id);
    const configId = resolveId(order.config_id);
    const configName = resolveName(order.config_id);
    const partnerId = resolveId(order.partner_id);
    const partnerName = resolveName(order.partner_id);

    const orderData = {
      orderId: order.id,
      orderName: order.name ?? null,
      posReference: order.pos_reference ?? null,
      companyId,
      companyName,
      branchId: null,
      branchName: null,
      posConfigId: configId,
      posConfigName: configName,
      dateOrder,
      amountTotal: order.amount_total ?? null,
      amountTax: order.amount_tax ?? null,
      amountPaid: order.amount_paid ?? null,
      state: order.state ?? null,
      partnerId,
      partnerName,
      region,
      rawJson: order as object,
    };

    const existing = await this.prisma.backupIbqOrder.findUnique({
      where: { orderId_region: { orderId: order.id, region } },
      select: { id: true },
    });

    let parentId: string;
    if (existing) {
      await this.prisma.backupIbqOrder.update({
        where: { id: existing.id },
        data: orderData,
      });
      parentId = existing.id;
    } else {
      const created = await this.prisma.backupIbqOrder.create({ data: orderData });
      parentId = created.id;
    }

    // ── Order lines ──────────────────────────────────────────────────────────
    const lines: IbqOrderLineRaw[] = Array.isArray(order.lines) ? order.lines : [];

    for (const line of lines) {
      const productId = resolveId(line.product_id);
      const productName = resolveName(line.product_id);
      const lineId = typeof line.id === 'number' ? line.id : null;

      const existingLine = lineId
        ? await this.prisma.backupIbqOrderLine.findFirst({
            where: { orderId: order.id, lineId, region },
            select: { id: true },
          })
        : null;

      const lineData = {
        orderId: order.id,
        lineId,
        productId,
        productName,
        qty: line.qty ?? null,
        priceUnit: line.price_unit ?? null,
        priceSubtotal: line.price_subtotal ?? null,
        priceSubtotalIncl: line.price_subtotal_incl ?? null,
        discount: line.discount ?? null,
        region,
        parentOrderId: parentId,
      };

      if (existingLine) {
        await this.prisma.backupIbqOrderLine.update({
          where: { id: existingLine.id },
          data: lineData,
        });
      } else {
        await this.prisma.backupIbqOrderLine.create({ data: lineData });
      }
    }

    // ── Payments — Odoo v15 uses statement_ids, v18 may use payment_ids ──────
    const rawPayments: IbqOrderPaymentRaw[] = Array.isArray(order.statement_ids)
      ? order.statement_ids
      : Array.isArray(order.payment_ids)
        ? order.payment_ids
        : [];

    for (const pmt of rawPayments) {
      const pmtId = typeof pmt.id === 'number' ? pmt.id : null;

      const existingPmt = pmtId
        ? await this.prisma.backupIbqOrderPayment.findFirst({
            where: { orderId: order.id, paymentId: pmtId, region },
            select: { id: true },
          })
        : null;

      const pmtData = {
        orderId: order.id,
        paymentId: pmtId,
        paymentName: pmt.name ?? null,
        amount: pmt.amount ?? null,
        region,
        parentOrderId: parentId,
      };

      if (existingPmt) {
        await this.prisma.backupIbqOrderPayment.update({
          where: { id: existingPmt.id },
          data: pmtData,
        });
      } else {
        await this.prisma.backupIbqOrderPayment.create({ data: pmtData });
      }
    }

    return !existing;
  }
}
