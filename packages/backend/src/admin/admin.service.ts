import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Map of route slug → Prisma delegate name
const TABLE_MAP: Record<string, keyof PrismaService> = {
  'fusion-credentials': 'fusionCredential',
  'vendhq-credentials': 'vendHqCredential',
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
};

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  getDelegate(table: string): any {
    const delegateName = TABLE_MAP[table];
    if (!delegateName) throw new BadRequestException(`Unknown table: ${table}`);
    return (this.prisma as any)[delegateName];
  }

  async list(
    table: string,
    options: { skip?: number; take?: number; region?: string },
  ) {
    const delegate = this.getDelegate(table);
    const where = options.region ? { region: options.region } : {};
    const [data, total] = await Promise.all([
      delegate.findMany({
        where,
        skip: options.skip ?? 0,
        // Increased from 50 → 100 to reduce round-trips for bulk admin operations.
        take: options.take ?? 100,
        orderBy: { createdAt: 'desc' },
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

  async create(table: string, body: Record<string, unknown>) {
    const delegate = this.getDelegate(table);
    // Strip id if provided so default cuid() is used
    const { id: _id, createdAt: _ca, updatedAt: _ua, ...data } = body as any;
    return delegate.create({ data });
  }

  async update(table: string, id: string, body: Record<string, unknown>) {
    await this.getOne(table, id);
    const delegate = this.getDelegate(table);
    const { id: _id, createdAt: _ca, ...data } = body as any;
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
      headers.map(AdminService.escapeCsvCell).join(','),
      ...rows.map((row) =>
        headers.map((h) => AdminService.escapeCsvCell(row[h])).join(','),
      ),
    ];
    return lines.join('\n');
  }

  private static parseCsvToRows(csvText: string): Record<string, unknown>[] {
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];

    // Simple CSV parser that handles quoted fields
    const parseRow = (line: string): string[] => {
      const cells: string[] = [];
      let inQuote = false;
      let cell = '';
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuote && line[i + 1] === '"') {
            cell += '"';
            i++;
          } else {
            inQuote = !inQuote;
          }
        } else if (ch === ',' && !inQuote) {
          cells.push(cell);
          cell = '';
        } else {
          cell += ch;
        }
      }
      cells.push(cell);
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
    const where = region ? { region } : {};
    const rows = (await delegate.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 10000,
    })) as Record<string, unknown>[];
    return AdminService.rowsToCsv(rows);
  }

  /** Import records from CSV text, skipping system columns */
  async importCsv(
    table: string,
    csvText: string,
  ): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const delegate = this.getDelegate(table);
    const rows = AdminService.parseCsvToRows(csvText);
    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      try {
        // Strip system / read-only columns so the DB generates them
        const { id: _id, createdAt: _ca, updatedAt: _ua, ...data } = row as Record<string, unknown>;
        // Coerce empty strings to null for optional fields
        const cleaned = Object.fromEntries(
          Object.entries(data).map(([k, v]) => [k, v === '' ? null : v]),
        );
        await delegate.create({ data: cleaned });
        imported++;
      } catch (err: unknown) {
        skipped++;
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return { imported, skipped, errors };
  }
}
