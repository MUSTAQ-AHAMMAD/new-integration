import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { numberToBigInt } from '../common/utils/bigint-utils';

/** Minimal typed interface for the dynamic Prisma delegates used by AdminService. */
interface PrismaDelegate {
  findMany(args?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  count(args?: Record<string, unknown>): Promise<number>;
  findUnique(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  create(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  delete(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

// Map of route slug → Prisma delegate name
const TABLE_MAP: Record<string, keyof PrismaService> = {
  'fusion-credentials': 'fusionCredential',
  'vendhq-credentials': 'vendHqCredential',
  'odoo-credentials': 'odooCredential',
  'outlet-config': 'outletIntegrationConfig',
  'fusion-bu-map': 'fusionBusinessUnitMap',
  'fusion-receipt-methods': 'fusionReceiptMethod',
  'fusion-sales-metadata': 'fusionSalesMetadata',
  'service-provider-journal-meta': 'serviceProviderJournalMeta',
  'sales-integration-status': 'salesIntegrationStatus',
  'vendhq-discount-items': 'vendHqDiscountItem',
  'vendhq-tax-meta': 'vendHqTaxMeta',
  'vendhq-outlets': 'vendHqOutlet',
  'vendhq-registers': 'vendHqRegister',
  'vendhq-service-providers': 'vendHqServiceProvider',
  'vendhq-item-meta': 'vendHqItemMeta',
  'fusion-invoice-headers': 'fusionInvoiceHeader',
  'fusion-invoice-lines': 'fusionInvoiceLine',
  'fusion-standard-receipts': 'fusionStandardReceipt',
  'fusion-misc-receipts': 'fusionMiscReceipt',
  'fusion-apply-receipts': 'fusionApplyReceipt',
  'fusion-journal-headers': 'fusionJournalHeader',
  'fusion-journal-lines': 'fusionJournalLine',
  'fusion-inv-txns': 'fusionInvTxn',
  'backup-sales': 'backupVendHqSale',
  'backup-line-items': 'backupVendHqLineItem',
  'backup-payments': 'backupVendHqPayment',
  'backup-promotions': 'backupVendHqPromotion',
  'backup-odoo-orders': 'backupOdooOrder',
  'backup-odoo-order-lines': 'backupOdooOrderLine',
  'backup-odoo-order-payments': 'backupOdooOrderPayment',
  'ibq-credentials': 'ibqCredential',
  'backup-ibq-orders': 'backupIbqOrder',
  'backup-ibq-order-lines': 'backupIbqOrderLine',
  'backup-ibq-order-payments': 'backupIbqOrderPayment',
  'sale-sync-status': 'saleSyncStatus',
  'api-endpoint-configs': 'apiEndpointConfig',
};

// ── Prisma DMMF helpers ─────────────────────────────────────────────────────

/**
 * Converts a TABLE_MAP delegate name (lowerCamelCase) to the Prisma model
 * name (PascalCase) so we can look it up in Prisma.dmmf at runtime.
 */
function delegateToModelName(delegateName: string): string {
  return delegateName.charAt(0).toUpperCase() + delegateName.slice(1);
}

/** Returns a Map<fieldName, prismaType> for the given table slug. */
function getModelFieldTypes(table: string): Map<string, string> {
  const delegateName = TABLE_MAP[table];
  if (!delegateName) return new Map();
  const modelName = delegateToModelName(String(delegateName));
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) return new Map();
  return new Map(model.fields.map((f) => [f.name, f.type]));
}

/**
 * Returns the best `orderBy` clause for a table.
 * Uses `createdAt` when available, falls back to `updatedAt`, then `id`.
 * This prevents runtime errors on models that lack `createdAt`
 * (e.g. SalesIntegrationStatus only has `updatedAt`).
 */
function getOrderBy(table: string): Record<string, 'asc' | 'desc'> {
  const fields = getModelFieldTypes(table);
  if (fields.has('createdAt')) return { createdAt: 'desc' };
  if (fields.has('updatedAt')) return { updatedAt: 'desc' };
  return { id: 'desc' };
}

/**
 * Builds the Prisma `where` clause for an optional region filter.
 *
 * Most tables have a direct `region` column and can be filtered with
 * `{ region }` directly.  Child tables (e.g. BackupOdooOrderLine,
 * BackupOdooOrderPayment) do not carry `region` themselves but are linked
 * to a parent `BackupOdooOrder` via an `order` relation.  For those tables
 * the region must be filtered through the relation: `{ order: { region } }`.
 *
 * If neither a direct `region` field nor an `order` relation is found, an
 * empty object is returned (no filter applied) so the query still succeeds.
 */
function getRegionWhere(
  table: string,
  region: string,
): Record<string, unknown> {
  const fields = getModelFieldTypes(table);
  if (fields.has('region')) {
    return { region };
  }

  // Fall back to filtering through the `order` relation when the model is a
  // child of a table that carries `region` (e.g. order-line, order-payment).
  const delegateName = TABLE_MAP[table];
  if (!delegateName) return {};
  const modelName = delegateToModelName(String(delegateName));
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (model) {
    const hasOrderRelation = model.fields.some(
      (f) => f.name === 'order' && f.kind === 'object',
    );
    if (hasOrderRelation) {
      return { order: { region } };
    }
  }

  return {};
}

/**
 * Builds a lookup map from UPPER_SNAKE_CASE (external CSV headers) to the
 * camelCase field names used by Prisma.  Also handles keys that are already
 * camelCase by including them verbatim.
 *
 * Example: "RECEIPT_METHOD_ID" → "receiptMethodId"
 *
 * Note: Prisma field names always start with a lowercase letter (camelCase),
 * so the `replace(/^_/, '')` guard exists only as a safety measure.
 */
function buildKeyNormalizer(
  fieldTypes: Map<string, string>,
): (key: string) => string {
  const upperToLower = new Map<string, string>();
  for (const camel of fieldTypes.keys()) {
    // Derive the UPPER_SNAKE_CASE form so we can recognize external CSVs.
    // Works correctly for all Prisma camelCase field names that start with
    // a lowercase letter (e.g. "receiptMethodId" → "RECEIPT_METHOD_ID").
    const upper = camel
      .replace(/([A-Z])/g, '_$1')
      .toUpperCase()
      .replace(/^_/, '');
    upperToLower.set(upper, camel);
    // Also allow the camelCase form directly (self-exported CSVs).
    upperToLower.set(camel, camel);
  }
  return (key: string) => upperToLower.get(key) ?? key;
}

/**
 * Coerces a CSV string value to the correct JS type based on the Prisma
 * field type.  CSV export always produces strings, so without this step
 * Prisma would reject numeric and boolean columns.
 */
function coerceCsvValue(value: unknown, prismaType: string): unknown {
  if (value === null || value === undefined || value === '') return null;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const s = String(value);
  switch (prismaType) {
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
    case 'Float':
    case 'Decimal': {
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    }
    case 'Boolean':
      // Any value in the truthy list → true; everything else (including 'false',
      // '0', 'no', 'n', or any unrecognised string) → false.
      return ['true', '1', 'yes', 'y'].includes(s.toLowerCase());
    case 'DateTime': {
      // Dates exported by the app are in ISO 8601 format (YYYY-MM-DD or full
      // ISO string), so new Date() parses them consistently.
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    default:
      return value;
  }
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  getDelegate(table: string): PrismaDelegate {
    const delegateName = TABLE_MAP[table];
    if (!delegateName) throw new BadRequestException(`Unknown table: ${table}`);

    return (this.prisma as unknown as Record<string, unknown>)[
      delegateName as string
    ] as PrismaDelegate;
  }

  async list(
    table: string,
    options: { skip?: number; take?: number; region?: string },
  ) {
    const delegate = this.getDelegate(table);
    const where = options.region ? getRegionWhere(table, options.region) : {};
    const orderBy = getOrderBy(table);
    const [data, total] = await Promise.all([
      delegate.findMany({
        where,
        skip: options.skip ?? 0,
        // Increased from 50 → 100 to reduce round-trips for bulk admin operations.
        take: options.take ?? 100,
        orderBy,
      }),
      delegate.count({ where }),
    ]);
    return { data, total, skip: options.skip ?? 0, take: options.take ?? 100 };
  }

  async getOne(table: string, id: string) {
    const delegate = this.getDelegate(table);
    const record = await delegate.findUnique({ where: { id } });
    if (!record)
      throw new NotFoundException(`Record ${id} not found in ${table}`);
    return record;
  }

  create(table: string, body: Record<string, unknown>) {
    const delegate = this.getDelegate(table);
    // Strip id if provided so default cuid() is used
    const { id: _id, createdAt: _ca, updatedAt: _ua, ...data } = body;
    return delegate.create({ data });
  }

  async update(table: string, id: string, body: Record<string, unknown>) {
    await this.getOne(table, id);
    const delegate = this.getDelegate(table);
    const { id: _id, createdAt: _ca, updatedAt: _ua, ...data } = body;
    return delegate.update({ where: { id }, data });
  }

  async remove(table: string, id: string) {
    await this.getOne(table, id);
    const delegate = this.getDelegate(table);
    await delegate.delete({ where: { id } });
  }

  /** Returns the list of available admin tables with metadata */
  static tables() {
    return Object.keys(TABLE_MAP).map((slug) => ({
      slug,
      model: TABLE_MAP[slug],
    }));
  }

  // ── CSV helpers ────────────────────────────────────────────────

  private static escapeCsvCell(value: unknown): string {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
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

    // Regex-based CSV parser — handles quoted fields and escaped double-quotes
    const parseRow = (line: string): string[] => {
      const cells: string[] = [];
      // Match each field: optionally quoted (with "" escape) or plain (no comma)
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
      // If the line ends with a comma, fieldPattern won't capture the trailing empty field
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

  /** Export all records of a table as CSV string */
  async exportCsv(table: string, region?: string): Promise<string> {
    const delegate = this.getDelegate(table);
    const where = region ? getRegionWhere(table, region) : {};
    const orderBy = getOrderBy(table);
    const rows = await delegate.findMany({
      where,
      orderBy,
      take: 10000,
    });
    return AdminService.rowsToCsv(rows);
  }

  /** Import records from CSV text, skipping system columns */
  async importCsv(
    table: string,
    csvText: string,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const delegate = this.getDelegate(table);
    const rows = AdminService.parseCsvToRows(csvText);
    const fieldTypes = getModelFieldTypes(table);
    // Build a normalizer that maps both UPPER_SNAKE_CASE (external CSVs) and
    // camelCase (self-exported CSVs) headers to the Prisma field names.
    const normalizeKey = buildKeyNormalizer(fieldTypes);
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Get valid field names for detailed error reporting
    const validFields = Array.from(fieldTypes.keys());

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      try {
        // Normalise keys first so UPPER_SNAKE_CASE headers from external CSVs
        // are mapped to the camelCase field names expected by Prisma.
        const normalizedRow = Object.fromEntries(
          Object.entries(row).map(([k, v]) => [normalizeKey(k), v]),
        );

        // Track unknown fields for better error messages
        const unknownFields = Object.keys(normalizedRow).filter(
          (k) =>
            k !== 'id' &&
            k !== 'createdAt' &&
            k !== 'updatedAt' &&
            !validFields.includes(k),
        );

        if (unknownFields.length > 0) {
          const msg = `Row ${rowIndex + 1}: Unknown fields [${unknownFields.join(', ')}]. Valid fields: ${validFields.join(', ')}`;
          skipped++;
          errors.push(msg);
          continue;
        }

        // Strip system / read-only columns so the DB generates them
        const {
          id: _id,
          createdAt: _ca,
          updatedAt: _ua,
          ...data
        } = normalizedRow;
        // Coerce each field to its correct Prisma type (CSV values are all
        // strings; without coercion Prisma rejects Int, Float and Boolean fields).
        // Fields not found in the DMMF are passed through as-is; Prisma will
        // then validate them (unknown columns are rejected at the DB layer).
        const cleaned = Object.fromEntries(
          Object.entries(data).map(([k, v]) => {
            if (v === '' || v === null || v === undefined) return [k, null];
            const prismaType = fieldTypes.get(k);
            return [k, prismaType ? coerceCsvValue(v, prismaType) : v];
          }),
        );
        await delegate.create({ data: cleaned });
        imported++;
      } catch (err: unknown) {
        skipped++;
        const errorMsg =
          err instanceof Error ? err.message : String(err);
        // Enhanced error message with row context
        errors.push(`Row ${rowIndex + 1}: ${errorMsg}`);
      }
    }

    return { imported, skipped, errors };
  }
}
