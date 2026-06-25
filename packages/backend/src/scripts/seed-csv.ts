/**
 * seed-csv.ts
 *
 * Auto-imports CSV files into the database without any manual mapping.
 *
 * Usage:
 *   # Import a specific file (table auto-detected from filename):
 *   pnpm seed:csv path/to/VENDHQ_REGISTERS_20240101.csv
 *
 *   # Import all CSVs in the default data/ folder:
 *   pnpm seed:csv
 *
 *   # Specify the target table explicitly:
 *   pnpm seed:csv path/to/file.csv --table vendhq-registers
 *
 * Table detection:
 *   The table slug is derived from the filename by stripping the extension,
 *   lowercasing, replacing underscores with hyphens, and removing trailing
 *   date/numeric suffixes (e.g. VENDHQ_REGISTERS_202606241630 → vendhq-registers).
 *
 * Duplicate handling:
 *   Rows that violate a unique constraint are silently skipped and counted.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient, Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Table map — mirrors the TABLE_MAP in admin.service.ts
// ---------------------------------------------------------------------------
const TABLE_MAP: Record<string, string> = {
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

// ---------------------------------------------------------------------------
// CSV parsing helpers (same logic as admin.service.ts)
// ---------------------------------------------------------------------------

function parseCsvToRows(csvText: string): Record<string, string>[] {
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

function getModelFieldTypes(modelName: string): Map<string, string> {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) return new Map();
  return new Map(model.fields.map((f) => [f.name, f.type]));
}

function buildKeyNormalizer(
  fieldTypes: Map<string, string>,
): (key: string) => string {
  const upperToLower = new Map<string, string>();
  for (const camel of fieldTypes.keys()) {
    const upper = camel
      .replace(/([A-Z])/g, '_$1')
      .toUpperCase()
      .replace(/^_/, '');
    upperToLower.set(upper, camel);
    upperToLower.set(camel, camel);
  }
  return (key: string) => upperToLower.get(key) ?? key;
}

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
        return BigInt(s.split('.')[0]);
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
      return ['true', '1', 'yes', 'y'].includes(s.toLowerCase());
    case 'DateTime': {
      const d = new Date(s);
      return isNaN(d.getTime()) ? null : d;
    }
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------
// Table detection from filename
// ---------------------------------------------------------------------------

/**
 * Derives the table slug from a CSV filename.
 *
 * Rules (applied in order):
 * 1. Strip file extension.
 * 2. Lowercase the whole string.
 * 3. Replace underscores with hyphens.
 * 4. Strip trailing date/numeric suffixes (e.g. -202606241630, -20240101, -v2).
 * 5. Return the longest matching TABLE_MAP key.
 */
function detectTable(filename: string): string | null {
  const base = path
    .basename(filename, path.extname(filename))
    .toLowerCase()
    .replace(/_/g, '-');

  // Strip trailing date/numeric/version suffixes e.g. -202606241630 or -20240101
  const stripped = base.replace(/-\d{6,}$/, '').replace(/-v\d+$/, '');

  // Try exact match first, then progressively shorter prefixes
  for (const candidate of [stripped, base]) {
    if (TABLE_MAP[candidate]) return candidate;
  }

  // Try prefix matching — e.g. if slug is "vendhq-registers-sa" find "vendhq-registers"
  const slugs = Object.keys(TABLE_MAP).sort((a, b) => b.length - a.length);
  for (const slug of slugs) {
    if (stripped.startsWith(slug) || base.startsWith(slug)) return slug;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Import a single CSV file into the database
// ---------------------------------------------------------------------------

async function importFile(
  prisma: PrismaClient,
  filePath: string,
  tableSlug: string,
): Promise<void> {
  const delegateName = TABLE_MAP[tableSlug];
  const delegate = (prisma as unknown as Record<string, unknown>)[
    delegateName
  ] as {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };

  const pascalName =
    delegateName.charAt(0).toUpperCase() + delegateName.slice(1);
  const fieldTypes = getModelFieldTypes(pascalName);
  const normalizeKey = buildKeyNormalizer(fieldTypes);

  const csvText = fs.readFileSync(filePath, 'utf-8');
  const rows = parseCsvToRows(csvText);

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      const normalizedRow = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [normalizeKey(k), v]),
      );
      const {
        id: _id,
        createdAt: _ca,
        updatedAt: _ua,
        ...data
      } = normalizedRow;
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
      const msg = err instanceof Error ? err.message : String(err);
      // Only collect first 10 unique errors to avoid noise from bulk duplicates
      if (errors.length < 10 && !errors.some((e) => e === msg)) {
        errors.push(msg);
      }
    }
  }

  console.log(
    `  ✔ ${path.basename(filePath)} → ${tableSlug}: ${imported} imported, ${skipped} skipped`,
  );
  if (errors.length > 0) {
    console.warn('  ⚠ Sample errors:');
    for (const e of errors) console.warn(`    - ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // Parse --table flag
  let explicitTable: string | undefined;
  const tableFlag = args.indexOf('--table');
  if (tableFlag !== -1) {
    explicitTable = args[tableFlag + 1];
    args.splice(tableFlag, 2);
  }

  // Collect CSV file paths
  // Use the working directory (always packages/backend/ in Docker and local dev)
  // instead of __dirname traversal, which varies by whether we're running as
  // ts-node (src/scripts/) or compiled JS (dist/scripts/).
  const defaultDataDir = path.join(process.cwd(), 'data');
  let files: string[] = [];

  if (args.length > 0) {
    // Files/dirs passed as positional arguments
    for (const arg of args) {
      const abs = path.resolve(arg);
      if (fs.statSync(abs).isDirectory()) {
        files.push(
          ...fs
            .readdirSync(abs)
            .filter((f) => f.toLowerCase().endsWith('.csv'))
            .map((f) => path.join(abs, f)),
        );
      } else {
        files.push(abs);
      }
    }
  } else {
    // Default: scan packages/backend/data/
    if (!fs.existsSync(defaultDataDir)) {
      console.error(
        `No CSV files specified and default data dir not found: ${defaultDataDir}`,
      );
      console.error('Usage: pnpm seed:csv [file.csv ...] [--table <slug>]');
      process.exit(1);
    }
    files = fs
      .readdirSync(defaultDataDir)
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .map((f) => path.join(defaultDataDir, f));
  }

  if (files.length === 0) {
    console.log('No CSV files found.');
    process.exit(0);
  }

  const prisma = new PrismaClient();

  try {
    console.log(`\nSeeding ${files.length} CSV file(s)...\n`);

    for (const filePath of files) {
      const tableSlug = explicitTable ?? detectTable(path.basename(filePath));

      if (!tableSlug) {
        console.warn(
          `  ✗ ${path.basename(filePath)}: could not detect table slug — skipping.\n` +
            `    Rename the file to match a table slug (e.g. vendhq-registers.csv)\n` +
            `    or pass --table <slug> explicitly.`,
        );
        continue;
      }

      if (!TABLE_MAP[tableSlug]) {
        console.warn(
          `  ✗ ${path.basename(filePath)}: unknown table "${tableSlug}" — skipping.\n` +
            `    Available tables: ${Object.keys(TABLE_MAP).join(', ')}`,
        );
        continue;
      }

      await importFile(prisma, filePath, tableSlug);
    }

    console.log('\nDone.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
