/**
 * Broader live smoke test: exercises several entities from different modules
 * against the real Oracle DB to validate the trickiest mappings — JSON (CLOB),
 * BigInt, the renamed StoreConfiguration column, Decimal+boolean+JSON on
 * OrderSyncQueue, and the mapped `sync_date` column + enums on AuditLog.
 * Cleans up after itself.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Decimal } from 'decimal.js';
import { buildOracleDataSourceOptions } from './data-source';
import { SyncJob } from './entities/sync-job.entity';
import { StoreConfiguration } from './entities/store-configuration.entity';
import { OrderSyncQueue } from './entities/order-sync-queue.entity';
import { AuditLog } from './entities/audit-log.entity';
import { JobType, ScopeType, JobStatus, SyncStatus, AuditOperation, AuditStatus } from './enums';

async function main(): Promise<void> {
  const ds = new DataSource({
    ...buildOracleDataSourceOptions(),
    username: 'NEW_INTEGRATION',
    password: process.env.NEW_INTEGRATION_PWD,
    schema: 'NEW_INTEGRATION',
    synchronize: false,
  });
  await ds.initialize();
  const tag = `SMOKE-${Date.now()}`;
  let ok = 0;

  // SyncJob — JSON scopeValue (CLOB) + enums
  const sjRepo = ds.getRepository(SyncJob);
  const sj = await sjRepo.save(sjRepo.create({
    jobType: JobType.ORDER_SYNC, scopeType: ScopeType.ALL,
    scopeValue: { branchCode: tag, nested: { a: 1, b: [1, 2, 3] } },
    status: JobStatus.PENDING, createdBy: tag,
  }));
  const sjBack = await sjRepo.findOneOrFail({ where: { id: sj.id } });
  const jsonOk = (sjBack.scopeValue as any)?.nested?.b?.[2] === 3;
  console.log('SyncJob JSON(CLOB) round-trip:', jsonOk); ok += jsonOk ? 1 : 0;
  await sjRepo.delete(sj.id);

  // StoreConfiguration — BigInt + renamed column + booleans
  const scRepo = ds.getRepository(StoreConfiguration);
  const sc = await scRepo.save(scRepo.create({
    // Largest JS-safe integer (2^53-1) — real Oracle Fusion IDs stay within this.
    branchCode: tag, branchName: 'Smoke Store', odooBranchId: 9007199254740991n,
    oracleOperatingUnitId: 123n, oracleBusinessUnit: 'BU', billToSiteName: 'S',
    bankAccountName: 'B', cashAccountName: 'C', paymentTermsName: 'IMMEDIATE',
    createdBy: tag, isActive: true, autoCreateMissingPaymentMethods: true,
  }));
  const scBack = await scRepo.findOneOrFail({ where: { id: sc.id } });
  const bigOk = scBack.odooBranchId === 9007199254740991n;
  const boolOk = scBack.isActive === true && scBack.autoCreateMissingPaymentMethods === true;
  console.log('StoreConfig BigInt (2^53-1) round-trip:', bigOk, '| renamed col + booleans:', boolOk);
  ok += (bigOk ? 1 : 0) + (boolOk ? 1 : 0);
  await scRepo.delete(sc.id);

  // OrderSyncQueue — Decimal + booleans + JSON
  const oq = ds.getRepository(OrderSyncQueue);
  const o = await oq.save(oq.create({
    odooOrderId: tag, odooOrderNumber: tag, branchCode: tag, orderDate: new Date(),
    orderDateUtc: new Date(), originalTimezone: 'Asia/Dubai', totalAmount: new Decimal('999.99'),
    currency: 'AED', status: SyncStatus.PENDING, isPaid: true, isCancelled: false, isRefund: false,
    validationErrors: { reasons: ['x'] },
  }));
  const oBack = await oq.findOneOrFail({ where: { id: o.id } });
  const decOk = oBack.totalAmount instanceof Decimal && oBack.totalAmount.toString() === '999.99';
  console.log('OrderSyncQueue Decimal + bool + JSON:', decOk && oBack.isPaid === true && (oBack.validationErrors as any)?.reasons?.[0] === 'x');
  ok += decOk ? 1 : 0;
  await oq.delete(o.id);

  // AuditLog — mapped sync_date column + JSON + enums
  const al = ds.getRepository(AuditLog);
  const a = await al.save(al.create({
    idempotencyKey: tag, externalId: tag, externalSystem: 'ODOO', targetSystem: 'ORACLE',
    operation: AuditOperation.CREATE_INVOICE, status: AuditStatus.SUCCESS,
    requestPayload: { a: 1 }, processingDurationMs: 5, syncDate: new Date(),
  }));
  const aBack = await al.findOneOrFail({ where: { id: a.id } });
  const auditOk = aBack.operation === AuditOperation.CREATE_INVOICE && aBack.syncDate instanceof Date;
  console.log('AuditLog mapped sync_date + enums:', auditOk); ok += auditOk ? 1 : 0;
  await al.delete(a.id);

  await ds.destroy();
  console.log(`\n${ok}/5 checks passed.`);
  if (ok !== 5) throw new Error('some checks failed');
}

main()
  .then(() => { console.log('✅ BROAD SMOKE PASSED against live Oracle.'); process.exit(0); })
  .catch((e) => { console.error('❌ BROAD SMOKE FAILED:', (e as Error).message); process.exit(1); });
