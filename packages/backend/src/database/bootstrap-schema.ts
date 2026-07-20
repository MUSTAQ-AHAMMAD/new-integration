/**
 * One-time bootstrap: creates the NEW_INTEGRATION schema (Oracle user) and all
 * entity tables via TypeORM synchronize.
 *
 * Run once against the target Oracle DB. Secrets come from env, never hardcoded:
 *   SYS_PASSWORD        SYS/SYSDBA password (to create the schema user)
 *   NEW_INTEGRATION_PWD password to set for the NEW_INTEGRATION app user
 * plus the standard ORACLE_DB_* connection vars.
 *
 * On this Windows box, ensure the Instant Client dir is on PATH before running
 * (thick mode); in Docker the ORACLE_DB_INSTANT_CLIENT_DIR path is used.
 */
import 'reflect-metadata';
import * as oracledb from 'oracledb';
import { DataSource } from 'typeorm';
import { buildOracleDataSourceOptions } from './data-source';

const TARGET_USER = 'NEW_INTEGRATION';

async function main(): Promise<void> {
  const targetPwd = process.env.NEW_INTEGRATION_PWD;
  const sysPwd = process.env.SYS_PASSWORD;
  if (!targetPwd || !sysPwd) {
    throw new Error('SYS_PASSWORD and NEW_INTEGRATION_PWD must be set.');
  }

  // buildOracleDataSourceOptions initialises the thick client as a side effect.
  const baseOptions = buildOracleDataSourceOptions();
  const connectString = (baseOptions as { connectString: string }).connectString;

  // ── 1. Create/refresh the schema user as SYS ────────────────────────────
  const admin = await oracledb.getConnection({
    user: 'SYS',
    password: sysPwd,
    connectString,
    privilege: oracledb.SYSDBA,
  });
  const existing = await admin.execute<[number]>(
    `SELECT 1 FROM dba_users WHERE username = :u`,
    [TARGET_USER],
  );
  // Repeatable bootstrap: drop and recreate for a clean slate (RESET_SCHEMA=true).
  if ((existing.rows?.length ?? 0) > 0 && process.env.RESET_SCHEMA === 'true') {
    await admin.execute(`DROP USER ${TARGET_USER} CASCADE`);
    console.log(`Dropped existing ${TARGET_USER} (RESET_SCHEMA).`);
  }
  const stillExists =
    process.env.RESET_SCHEMA === 'true' ? false : (existing.rows?.length ?? 0) > 0;
  if (!stillExists) {
    await admin.execute(`CREATE USER ${TARGET_USER} IDENTIFIED BY "${targetPwd}"`);
    console.log(`Created schema/user ${TARGET_USER}`);
  } else {
    await admin.execute(`ALTER USER ${TARGET_USER} IDENTIFIED BY "${targetPwd}"`);
    console.log(`Schema/user ${TARGET_USER} already exists — password reset`);
  }
  for (const grant of [
    `GRANT CREATE SESSION TO ${TARGET_USER}`,
    `GRANT CREATE TABLE TO ${TARGET_USER}`,
    `GRANT CREATE VIEW TO ${TARGET_USER}`,
    `GRANT CREATE SEQUENCE TO ${TARGET_USER}`,
    `GRANT UNLIMITED TABLESPACE TO ${TARGET_USER}`,
  ]) {
    await admin.execute(grant);
  }
  await admin.commit();
  await admin.close();
  console.log('Granted privileges.');

  // ── 2. Synchronize entities into the schema as NEW_INTEGRATION ───────────
  const ds = new DataSource({
    ...baseOptions,
    username: TARGET_USER,
    password: targetPwd,
    schema: TARGET_USER,
    synchronize: true,
    logging: ['error', 'schema'],
  });
  await ds.initialize();
  const tables = await ds.query<{ TABLE_NAME: string }[]>(
    `SELECT table_name AS "TABLE_NAME" FROM user_tables ORDER BY table_name`,
  );
  console.log(`\n✅ ${tables.length} tables in ${TARGET_USER}:`);
  console.log(tables.map((t) => t.TABLE_NAME).join(', '));
  await ds.destroy();
}

main()
  .then(() => {
    console.log('\nBootstrap complete.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ BOOTSTRAP FAILED:', (err as Error).message);
    process.exit(1);
  });
