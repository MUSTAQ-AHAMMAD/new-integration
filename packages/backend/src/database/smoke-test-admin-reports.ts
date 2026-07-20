/**
 * Live smoke test for the TypeORM-ported generic engines (AdminService +
 * ReportsService) against Oracle. Exercises the metadata + QueryBuilder paths:
 * report datasets/records/aggregate, and a full admin CRUD + CSV cycle.
 * Cleans up after itself.
 */
import 'reflect-metadata';
import { AppDataSource } from './data-source';
import { AdminService } from '../admin/admin.service';
import { ReportsService } from '../reports/reports.service';

async function main(): Promise<void> {
  await AppDataSource.initialize();
  const reports = new ReportsService(AppDataSource);
  const admin = new AdminService(AppDataSource);
  let ok = 0;

  // ── Reports: metadata + records + aggregate ──────────────────────────────
  const datasets = reports.datasets();
  const orders = datasets.find((d) => d.slug === 'orders');
  const hasFields = !!orders && orders.fields.some((f) => f.name === 'status');
  console.log('Reports datasets (metadata from entities):', hasFields);
  ok += hasFields ? 1 : 0;

  const records = await reports.run({ dataset: 'orders', pageSize: 5 });
  console.log('Reports records mode:', records.mode === 'records');
  ok += records.mode === 'records' ? 1 : 0;

  const agg = await reports.run({
    dataset: 'orders',
    groupBy: ['status'],
    measures: [{ fn: 'count' }],
  });
  console.log('Reports aggregate mode (groupBy+count):', agg.mode === 'aggregate');
  ok += agg.mode === 'aggregate' ? 1 : 0;

  // ── Admin: list (read) ───────────────────────────────────────────────────
  const listed = await admin.list('payment-mappings', { take: 5 });
  console.log('Admin list:', typeof listed.total === 'number');
  ok += typeof listed.total === 'number' ? 1 : 0;

  // ── Admin: full CRUD cycle on payment-mappings ───────────────────────────
  const created = (await admin.create('payment-mappings', {
    sourceSystem: 'SMOKE',
    sourcePaymentName: `SMOKE-${Date.now()}`,
    oracleReceiptMethodId: 999999,
    oracleReceiptMethodName: 'Smoke Method',
  })) as { id: string };
  const createOk = !!created.id;
  console.log('Admin create:', createOk);
  ok += createOk ? 1 : 0;

  const fetched = (await admin.getOne('payment-mappings', created.id)) as {
    oracleReceiptMethodId: bigint;
  };
  const bigintOk = BigInt(fetched.oracleReceiptMethodId) === 999999n;
  console.log('Admin getOne (BigInt round-trip):', bigintOk);
  ok += bigintOk ? 1 : 0;

  await admin.update('payment-mappings', created.id, { oracleReceiptMethodName: 'Updated' });
  const updated = (await admin.getOne('payment-mappings', created.id)) as {
    oracleReceiptMethodName: string;
  };
  console.log('Admin update:', updated.oracleReceiptMethodName === 'Updated');
  ok += updated.oracleReceiptMethodName === 'Updated' ? 1 : 0;

  const csv = await admin.exportCsv('payment-mappings', 'AE');
  console.log('Admin exportCsv (has header):', csv.split('\n')[0].includes('sourceSystem'));
  ok += csv.split('\n')[0].includes('sourceSystem') ? 1 : 0;

  await admin.remove('payment-mappings', created.id);
  let removed = false;
  try {
    await admin.getOne('payment-mappings', created.id);
  } catch {
    removed = true;
  }
  console.log('Admin remove:', removed);
  ok += removed ? 1 : 0;

  await AppDataSource.destroy();
  console.log(`\n${ok}/9 checks passed.`);
  if (ok !== 9) throw new Error('some checks failed');
}

main()
  .then(() => {
    console.log('✅ ADMIN + REPORTS SMOKE PASSED against live Oracle.');
    process.exit(0);
  })
  .catch((e) => {
    console.error('❌ FAILED:', (e as Error).message);
    process.exit(1);
  });
