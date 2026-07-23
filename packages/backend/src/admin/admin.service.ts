import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, ObjectLiteral, Repository } from 'typeorm';
import { EntityMetadata } from 'typeorm';
import { numberToBigInt } from '../common/utils/bigint-utils';
import {
  FieldCategory,
  fieldCategoryMap,
  regionRelationProperty,
} from '../database/entity-fields';
import { ApiEndpointConfig } from '../database/entities/api-endpoint-config.entity';
import { BackupIbqOrder } from '../database/entities/backup-ibq-order.entity';
import { BackupIbqOrderLine } from '../database/entities/backup-ibq-order-line.entity';
import { BackupIbqOrderPayment } from '../database/entities/backup-ibq-order-payment.entity';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { BackupOdooOrderPayment } from '../database/entities/backup-odoo-order-payment.entity';
import { BackupVendHqLineItem } from '../database/entities/backup-vend-hq-line-item.entity';
import { BackupVendHqPayment } from '../database/entities/backup-vend-hq-payment.entity';
import { BackupVendHqPromotion } from '../database/entities/backup-vend-hq-promotion.entity';
import { BackupVendHqSale } from '../database/entities/backup-vend-hq-sale.entity';
import { FusionApplyReceipt } from '../database/entities/fusion-apply-receipt.entity';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionCredential } from '../database/entities/fusion-credential.entity';
import { FusionInvTxn } from '../database/entities/fusion-inv-txn.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionJournalHeader } from '../database/entities/fusion-journal-header.entity';
import { FusionJournalLine } from '../database/entities/fusion-journal-line.entity';
import { FusionMiscReceipt } from '../database/entities/fusion-misc-receipt.entity';
import { FusionReceiptMethod } from '../database/entities/fusion-receipt-method.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { FusionStandardReceipt } from '../database/entities/fusion-standard-receipt.entity';
import { IbqCredential } from '../database/entities/ibq-credential.entity';
import { OdooCredential } from '../database/entities/odoo-credential.entity';
import { OutletIntegrationConfig } from '../database/entities/outlet-integration-config.entity';
import { PaymentMethodMapping } from '../database/entities/payment-method-mapping.entity';
import { SaleSyncStatus } from '../database/entities/sale-sync-status.entity';
import { SalesIntegrationStatus } from '../database/entities/sales-integration-status.entity';
import { ServiceProviderJournalMeta } from '../database/entities/service-provider-journal-meta.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqDiscountItem } from '../database/entities/vend-hq-discount-item.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { VendHqOutlet } from '../database/entities/vend-hq-outlet.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
import { VendHqServiceProvider } from '../database/entities/vend-hq-service-provider.entity';
import { VendHqTaxMeta } from '../database/entities/vend-hq-tax-meta.entity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EntityClass = new () => any;

// Map of route slug → TypeORM entity class (was Prisma delegate name).
// Exported so the CSV seeding script can reuse the same slug↔entity mapping.
export const ENTITY_MAP: Record<string, EntityClass> = {
  'fusion-credentials': FusionCredential,
  'vendhq-credentials': VendHqCredential,
  'odoo-credentials': OdooCredential,
  'payment-mappings': PaymentMethodMapping,
  'store-configs': StoreConfiguration,
  'outlet-config': OutletIntegrationConfig,
  'fusion-bu-map': FusionBusinessUnitMap,
  'fusion-receipt-methods': FusionReceiptMethod,
  'fusion-sales-metadata': FusionSalesMetadata,
  'service-provider-journal-meta': ServiceProviderJournalMeta,
  'sales-integration-status': SalesIntegrationStatus,
  'vendhq-discount-items': VendHqDiscountItem,
  'vendhq-tax-meta': VendHqTaxMeta,
  'vendhq-outlets': VendHqOutlet,
  'vendhq-registers': VendHqRegister,
  'vendhq-service-providers': VendHqServiceProvider,
  'vendhq-item-meta': VendHqItemMeta,
  'fusion-invoice-headers': FusionInvoiceHeader,
  'fusion-invoice-lines': FusionInvoiceLine,
  'fusion-standard-receipts': FusionStandardReceipt,
  'fusion-misc-receipts': FusionMiscReceipt,
  'fusion-apply-receipts': FusionApplyReceipt,
  'fusion-journal-headers': FusionJournalHeader,
  'fusion-journal-lines': FusionJournalLine,
  'fusion-inv-txns': FusionInvTxn,
  'backup-sales': BackupVendHqSale,
  'backup-line-items': BackupVendHqLineItem,
  'backup-payments': BackupVendHqPayment,
  'backup-promotions': BackupVendHqPromotion,
  'backup-odoo-orders': BackupOdooOrder,
  'backup-odoo-order-lines': BackupOdooOrderLine,
  'backup-odoo-order-payments': BackupOdooOrderPayment,
  'ibq-credentials': IbqCredential,
  'backup-ibq-orders': BackupIbqOrder,
  'backup-ibq-order-lines': BackupIbqOrderLine,
  'backup-ibq-order-payments': BackupIbqOrderPayment,
  'sale-sync-status': SaleSyncStatus,
  'api-endpoint-configs': ApiEndpointConfig,
};

/**
 * Builds a lookup from external CSV headers to the camelCase field names used
 * by the entities. Matching is tolerant of header style: case and separators
 * (underscores, dashes, spaces) are ignored, so "RECEIPT_METHOD_ID",
 * "receipt_method_id", "Receipt Method Id" and "receiptMethodId" all map to
 * "receiptMethodId". System columns (id/createdAt/updatedAt) are included so
 * re-imports of exported CSVs normalise them for stripping. Headers that match
 * no field are passed through verbatim (and rejected by the caller).
 */
export function buildKeyNormalizer(
  fieldNames: Iterable<string>,
): (key: string) => string {
  const canon = (k: string) => k.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const lookup = new Map<string, string>();
  for (const camel of fieldNames) {
    lookup.set(canon(camel), camel);
  }
  for (const sys of ['id', 'createdAt', 'updatedAt']) {
    if (!lookup.has(canon(sys))) lookup.set(canon(sys), sys);
  }
  return (key: string) => lookup.get(canon(key)) ?? key;
}

/**
 * Coerces a CSV string value to the JS type the entity/transformer expects,
 * based on the field category. CSV export always produces strings.
 */
export function coerceCsvValue(value: unknown, category: FieldCategory): unknown {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  switch (category) {
    case 'Int': {
      const n = parseInt(s, 10);
      return isNaN(n) ? null : n;
    }
    case 'BigInt': {
      try {
        return numberToBigInt(parseFloat(s.split('.')[0]));
      } catch {
        return null;
      }
    }
    case 'Decimal': {
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    }
    case 'Boolean':
      return ['true', '1', 'yes', 'y'].includes(s.toLowerCase());
    case 'DateTime': {
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    case 'Json': {
      try {
        return JSON.parse(s);
      } catch {
        return s;
      }
    }
    default:
      return value;
  }
}

@Injectable()
export class AdminService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private getRepo(table: string): Repository<ObjectLiteral> {
    const entity = ENTITY_MAP[table];
    if (!entity) throw new BadRequestException(`Unknown table: ${table}`);
    return this.dataSource.getRepository(entity);
  }

  private getMeta(table: string): EntityMetadata {
    const entity = ENTITY_MAP[table];
    if (!entity) throw new BadRequestException(`Unknown table: ${table}`);
    return this.dataSource.getMetadata(entity);
  }

  /**
   * Region filter. Tables with a direct `region` column filter on it; child
   * tables (order lines/payments) filter through their parent relation.
   */
  private regionWhere(
    table: string,
    region: string,
  ): Record<string, unknown> {
    const meta = this.getMeta(table);
    if (meta.columns.some((c) => c.propertyName === 'region')) {
      return { region };
    }
    const rel = regionRelationProperty(meta);
    return rel ? { [rel]: { region } } : {};
  }

  /** Best orderBy: createdAt → updatedAt → id. */
  private orderBy(table: string): Record<string, 'DESC'> {
    const names = new Set(
      this.getMeta(table).columns.map((c) => c.propertyName),
    );
    if (names.has('createdAt')) return { createdAt: 'DESC' };
    if (names.has('updatedAt')) return { updatedAt: 'DESC' };
    return { id: 'DESC' };
  }

  async list(
    table: string,
    options: { skip?: number; take?: number; region?: string },
  ) {
    const repo = this.getRepo(table);
    const where = options.region ? this.regionWhere(table, options.region) : {};
    const [data, total] = await repo.findAndCount({
      where,
      skip: options.skip ?? 0,
      take: options.take ?? 100,
      order: this.orderBy(table),
    });
    return { data, total, skip: options.skip ?? 0, take: options.take ?? 100 };
  }

  async getOne(table: string, id: string) {
    const repo = this.getRepo(table);
    const record = await repo.findOne({ where: { id } });
    if (!record)
      throw new NotFoundException(`Record ${id} not found in ${table}`);
    return record;
  }

  /**
   * Canonicalise `region` (trim + uppercase) so cross-table joins stay
   * consistent. Applied on every write path.
   */
  static normalizeRegion<T extends Record<string, unknown>>(data: T): T {
    if (typeof data.region === 'string' && data.region.trim() !== '') {
      return { ...data, region: data.region.trim().toUpperCase() };
    }
    return data;
  }

  async create(table: string, body: Record<string, unknown>) {
    const repo = this.getRepo(table);
    const { id: _id, createdAt: _ca, updatedAt: _ua, ...data } = body;
    const entity = repo.create(AdminService.normalizeRegion(data));
    return repo.save(entity);
  }

  async update(table: string, id: string, body: Record<string, unknown>) {
    await this.getOne(table, id);
    const repo = this.getRepo(table);
    const { id: _id, createdAt: _ca, updatedAt: _ua, ...data } = body;
    await repo.update(
      id,
      AdminService.normalizeRegion(data) as ObjectLiteral,
    );
    return this.getOne(table, id);
  }

  async remove(table: string, id: string) {
    await this.getOne(table, id);
    const repo = this.getRepo(table);
    await repo.delete(id);
  }

  /** Available admin tables with metadata. */
  static tables() {
    return Object.keys(ENTITY_MAP).map((slug) => ({
      slug,
      model: ENTITY_MAP[slug].name,
    }));
  }

  // ── CSV helpers ────────────────────────────────────────────────

  private static escapeCsvCell(value: unknown): string {
    const str = value == null ? '' : String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replaceAll('"', '""')}"`;
    }
    return str;
  }

  private static rowsToCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const lines = [
      headers.map((h) => AdminService.escapeCsvCell(h)).join(','),
      ...rows.map((row) =>
        headers.map((h) => AdminService.escapeCsvCell(row[h])).join(','),
      ),
    ];
    return lines.join('\n');
  }

  private static parseCsvToRows(csvText: string): Record<string, unknown>[] {
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];

    const parseRow = (line: string): string[] => {
      const cells: string[] = [];
      const fieldPattern = /(?:^|,)("(?:[^"]|"")*"|[^,]*)/g;
      let match: RegExpExecArray | null;
      let lastIndex = 0;
      while ((match = fieldPattern.exec(line)) !== null) {
        lastIndex = fieldPattern.lastIndex;
        let value = match[1] ?? '';
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).replace(/""/g, '"');
        }
        cells.push(value);
      }
      if (lastIndex === line.length && line.endsWith(',')) {
        cells.push('');
      }
      return cells;
    };

    const headers = parseRow(lines[0]);
    return lines.slice(1).map((line) => {
      const values = parseRow(line);
      return Object.fromEntries(
        headers.map((h, i) => [h.trim(), values[i]?.trim() ?? '']),
      );
    });
  }

  /** Export all records of a table as a CSV string. */
  async exportCsv(table: string, region?: string): Promise<string> {
    const repo = this.getRepo(table);
    const where = region ? this.regionWhere(table, region) : {};
    const rows = await repo.find({
      where,
      order: this.orderBy(table),
      take: 10000,
    });
    return AdminService.rowsToCsv(rows as Record<string, unknown>[]);
  }

  /** Import records from CSV text, skipping system columns. */
  async importCsv(
    table: string,
    csvText: string,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const repo = this.getRepo(table);
    const categories = fieldCategoryMap(this.getMeta(table));
    const rows = AdminService.parseCsvToRows(csvText);
    const normalizeKey = buildKeyNormalizer(categories.keys());
    const validFields = Array.from(categories.keys());
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      try {
        const normalizedRow = Object.fromEntries(
          Object.entries(row).map(([k, v]) => [normalizeKey(k), v]),
        );

        const unknownFields = Object.keys(normalizedRow).filter(
          (k) =>
            k !== 'id' &&
            k !== 'createdAt' &&
            k !== 'updatedAt' &&
            !validFields.includes(k),
        );

        if (unknownFields.length > 0) {
          errors.push(
            `Row ${rowIndex + 1}: Unknown fields [${unknownFields.join(', ')}]. Valid fields: ${validFields.join(', ')}`,
          );
          skipped++;
          continue;
        }

        const {
          id: _id,
          createdAt: _ca,
          updatedAt: _ua,
          ...data
        } = normalizedRow;
        const cleaned = AdminService.normalizeRegion(
          Object.fromEntries(
            Object.entries(data).map(([k, v]) => {
              if (v === '' || v === null || v === undefined) return [k, null];
              const category = categories.get(k);
              return [k, category ? coerceCsvValue(v, category) : v];
            }),
          ),
        );
        await repo.save(repo.create(cleaned));
        imported++;
      } catch (err: unknown) {
        skipped++;
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(`Row ${rowIndex + 1}: ${errorMsg}`);
      }
    }

    return { imported, skipped, errors };
  }
}
