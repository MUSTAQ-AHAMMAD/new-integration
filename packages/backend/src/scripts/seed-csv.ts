/**
 * seed-csv.ts — auto-imports CSV files into the Oracle app database (TypeORM).
 *
 * Usage:
 *   pnpm seed:csv path/to/VENDHQ_REGISTERS_20240101.csv   # table auto-detected
 *   pnpm seed:csv                                         # all CSVs in data/
 *   pnpm seed:csv path/to/file.csv --table vendhq-registers
 *
 * The table slug is derived from the filename (extension stripped, lowercased,
 * underscores→hyphens, trailing date/version suffix removed). Reuses the same
 * slug↔entity map and CSV coercion as the admin CSV importer.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AppDataSource } from '../database/data-source';
import { fieldCategoryMap } from '../database/entity-fields';
import {
  ENTITY_MAP,
  buildKeyNormalizer,
  coerceCsvValue,
} from '../admin/admin.service';

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
    if (lastIndex === line.length && line.endsWith(',')) cells.push('');
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

/** Derives the table slug from a CSV filename. */
function detectTable(filename: string): string | null {
  const base = path
    .basename(filename, path.extname(filename))
    .toLowerCase()
    .replace(/_/g, '-');
  const stripped = base.replace(/-\d{6,}$/, '').replace(/-v\d+$/, '');
  for (const candidate of [stripped, base]) {
    if (ENTITY_MAP[candidate]) return candidate;
  }
  const slugs = Object.keys(ENTITY_MAP).sort((a, b) => b.length - a.length);
  for (const slug of slugs) {
    if (stripped.startsWith(slug) || base.startsWith(slug)) return slug;
  }
  return null;
}

async function importFile(filePath: string, tableSlug: string): Promise<void> {
  const entity = ENTITY_MAP[tableSlug];
  const repo = AppDataSource.getRepository(entity);
  const categories = fieldCategoryMap(AppDataSource.getMetadata(entity));
  const normalizeKey = buildKeyNormalizer(categories.keys());

  const rows = parseCsvToRows(fs.readFileSync(filePath, 'utf-8'));
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    try {
      const normalized = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [normalizeKey(k), v]),
      );
      const { id: _id, createdAt: _ca, updatedAt: _ua, ...data } = normalized;
      const cleaned = Object.fromEntries(
        Object.entries(data).map(([k, v]) => {
          if (v === '' || v === null || v === undefined) return [k, null];
          const category = categories.get(k);
          return [k, category ? coerceCsvValue(v, category) : v];
        }),
      );
      await repo.save(repo.create(cleaned));
      imported++;
    } catch (err: unknown) {
      skipped++;
      const msg = err instanceof Error ? err.message : String(err);
      if (errors.length < 10 && !errors.some((e) => e === msg)) errors.push(msg);
    }
  }

  console.log(
    `  ✔ ${path.basename(filePath)} → ${tableSlug}: ${imported} imported, ${skipped} skipped`,
  );
  for (const e of errors) console.warn(`    - ${e}`);
}

async function main() {
  const args = process.argv.slice(2);
  let explicitTable: string | undefined;
  const tableFlag = args.indexOf('--table');
  if (tableFlag !== -1) {
    explicitTable = args[tableFlag + 1];
    args.splice(tableFlag, 2);
  }

  const defaultDataDir = path.join(process.cwd(), 'data');
  let files: string[] = [];
  if (args.length > 0) {
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
    if (!fs.existsSync(defaultDataDir)) {
      console.error(`No CSV files specified and data dir not found: ${defaultDataDir}`);
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

  await AppDataSource.initialize();
  try {
    console.log(`\nSeeding ${files.length} CSV file(s) into Oracle...\n`);
    for (const filePath of files) {
      const tableSlug = explicitTable ?? detectTable(path.basename(filePath));
      if (!tableSlug || !ENTITY_MAP[tableSlug]) {
        console.warn(
          `  ✗ ${path.basename(filePath)}: could not resolve table slug — skipping. ` +
            `Rename to a known slug or pass --table <slug>.`,
        );
        continue;
      }
      await importFile(filePath, tableSlug);
    }
    console.log('\nDone.');
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
