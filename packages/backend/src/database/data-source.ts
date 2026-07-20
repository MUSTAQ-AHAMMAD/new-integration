import { DataSource } from 'typeorm';
import { OracleConnectionOptions } from 'typeorm/driver/oracle/OracleConnectionOptions';
import * as oracledb from 'oracledb';
import { OracleNamingStrategy } from './oracle-naming.strategy';

/**
 * Builds TypeORM connection options for the Oracle **application** database from
 * the APP_DB_* environment variables. This is DISTINCT from ORACLE_DB_* (which
 * is the Oracle Fusion ERP source used by oracle-native.service for item/config
 * import) — the app DB must not clobber that connection. Oracle replaces
 * PostgreSQL/Prisma as the operational store.
 *
 * Thick mode (APP_DB_THICK_MODE=true) initialises the Instant Client once,
 * before any pool is created — required for older DB versions / advanced auth
 * (this DB uses Native Network Encryption → thick mode is mandatory).
 */
let thickModeInitialised = false;

export function buildOracleDataSourceOptions(): OracleConnectionOptions {
  const host = process.env.APP_DB_HOST ?? 'localhost';
  const port = parseInt(process.env.APP_DB_PORT ?? '1521', 10);
  const serviceName = process.env.APP_DB_SERVICE ?? 'XEPDB1';

  if (process.env.APP_DB_THICK_MODE === 'true' && !thickModeInitialised) {
    try {
      oracledb.initOracleClient({
        libDir: process.env.APP_DB_INSTANT_CLIENT_DIR || undefined,
      });
      thickModeInitialised = true;
    } catch (err) {
      // initOracleClient throws if already initialised — safe to ignore.
      if (!/already been/i.test((err as Error).message)) throw err;
    }
  }

  return {
    type: 'oracle',
    username: process.env.APP_DB_USERNAME ?? '',
    password: process.env.APP_DB_PASSWORD ?? '',
    connectString: `${host}:${port}/${serviceName}`,
    schema: process.env.APP_DB_SCHEMA || undefined,
    // Oracle 12.1 = 30-byte identifier limit; truncate generated names.
    namingStrategy: new OracleNamingStrategy(),
    // Entities are discovered by NestJS via autoLoadEntities; the glob is used by
    // the standalone DataSource (migrations / CLI).
    entities: [__dirname + '/entities/*.entity.{ts,js}'],
    migrations: [__dirname + '/migrations/*.{ts,js}'],
    // Never auto-sync in production; use migrations. Toggle for local bootstrap.
    synchronize: process.env.APP_DB_SYNCHRONIZE === 'true',
    logging: process.env.APP_DB_LOGGING === 'true',
  };
}

/**
 * Standalone DataSource for the TypeORM CLI (migration generate/run). The Nest
 * runtime uses DatabaseModule instead.
 */
export const AppDataSource = new DataSource(buildOracleDataSourceOptions());
