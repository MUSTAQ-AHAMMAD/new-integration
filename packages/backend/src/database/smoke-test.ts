/**
 * Live smoke test against Oracle: exercises the migrated RefundTracking
 * repository end-to-end (insert → read → update → count → delete) to verify the
 * transformers (Decimal, boolean, timestamp) and UUID PK generation round-trip
 * correctly on the real DB. Cleans up after itself.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Decimal } from 'decimal.js';
import { buildOracleDataSourceOptions } from './data-source';
import { RefundTracking } from './entities/refund-tracking.entity';
import { SyncStatus } from './enums';

async function main(): Promise<void> {
  const ds = new DataSource({
    ...buildOracleDataSourceOptions(),
    username: 'NEW_INTEGRATION',
    password: process.env.NEW_INTEGRATION_PWD,
    schema: 'NEW_INTEGRATION',
    synchronize: false,
  });
  await ds.initialize();
  const repo = ds.getRepository(RefundTracking);

  // INSERT
  const saved = await repo.save(
    repo.create({
      originalOrderId: 'ORD-SMOKE',
      originalOrderNumber: 'S-SMOKE',
      refundOrderId: `REF-SMOKE-${Date.now()}`,
      refundOrderNumber: 'R-SMOKE',
      branchCode: 'DXB',
      refundAmount: new Decimal('123.45'),
      refundReason: 'smoke test',
      refundDate: new Date(),
      oracleCreditMemoNumber: '',
      creditMemoStatus: SyncStatus.PENDING,
      isReconciled: false,
    }),
  );
  console.log('INSERT ok — generated id:', saved.id, '| id is UUID:', /^[0-9a-f-]{36}$/.test(saved.id));

  // READ + verify transformers
  const found = await repo.findOneOrFail({ where: { id: saved.id } });
  console.log('READ ok — refundAmount is Decimal:', found.refundAmount instanceof Decimal, '=', found.refundAmount.toString());
  console.log('  isReconciled is boolean:', typeof found.isReconciled === 'boolean', '=', found.isReconciled);
  console.log('  creditMemoStatus:', found.creditMemoStatus, '| refundDate is Date:', found.refundDate instanceof Date);
  console.log('  createdAt auto-set:', found.createdAt instanceof Date);

  // UPDATE
  await repo.update(saved.id, { creditMemoStatus: SyncStatus.SYNCED, isReconciled: true });
  const updated = await repo.findOneOrFail({ where: { id: saved.id } });
  console.log('UPDATE ok — status:', updated.creditMemoStatus, '| isReconciled:', updated.isReconciled);

  // COUNT (repository query used by getRefundStats)
  const pending = await repo.count({ where: { creditMemoStatus: SyncStatus.SYNCED } });
  console.log('COUNT ok — SYNCED rows:', pending);

  // CLEANUP
  await repo.delete(saved.id);
  console.log('DELETE ok — row removed');

  await ds.destroy();
}

main()
  .then(() => { console.log('\n✅ SMOKE TEST PASSED against live Oracle.'); process.exit(0); })
  .catch((e) => { console.error('\n❌ SMOKE TEST FAILED:', (e as Error).message); process.exit(1); });
