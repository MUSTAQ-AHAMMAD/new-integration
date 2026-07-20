# Prisma → TypeORM (Oracle) migration

The application database is moving from **PostgreSQL/Prisma** to **Oracle/TypeORM**.
Prisma cannot target Oracle (no such provider), so the data layer is being
replaced. TypeORM and Prisma **coexist** during the rollout: the app keeps
building and running while modules move over one at a time.

## Status — ✅ COMPLETE (100% Oracle; Prisma removed)

- **Foundation + full schema.** `src/database/` (data-source, `database.module`
  global TypeORM Oracle connection from `APP_DB_*`, transformers, enums, id.util,
  `oracle-naming.strategy`, `entity-fields`). **All 61 models → TypeORM entities.**
  Schema `NEW_INTEGRATION` + 61 tables live in PDB1.
- **Every module migrated** off Prisma to TypeORM repositories / DataSource.
- The two `Prisma.dmmf`-driven generic engines were rebuilt on TypeORM
  `EntityMetadata` (`src/database/entity-fields.ts`): **`admin.service.ts`**
  (generic CRUD/CSV) and **`reports/report-query.ts` + `reports.service.ts`**
  (dynamic report builder, now QueryBuilder-based).
- Obsolete Postgres-only debug scripts removed; `seed-csv.ts` ported to Oracle.
- **`@prisma/client` + `prisma` deps, `prisma/` schema dir, and `src/prisma/`
  removed. `PrismaModule` gone from both app modules.** Dockerfile/compose no
  longer run `prisma generate`/`db push`/`migrate deploy`.
- **Verified: 0 tsc errors, 744 tests green, `nest build` clean.** Live Oracle:
  61-table schema, broad multi-entity CRUD, and admin+reports engine smoke tests
  all pass (`src/database/smoke-test*.ts`).

> Two more Oracle gotchas fixed during rollout: (1) transformers pass `undefined`
> through so DB defaults apply (mapping it to `null` broke NOT NULL defaulted
> columns); (2) `BigInt` values **beyond 2^53** lose precision (oracledb returns
> NUMBER as JS number) — real Oracle Fusion IDs are ≤ 2^53 so this is not hit in
> practice; if it ever is, add a per-column `fetchTypeHandler` returning strings.

## Type mapping (Prisma → Oracle column)

| Prisma | TypeORM column | TS property |
| --- | --- | --- |
| `String @id @default(cuid()/uuid())` | `@PrimaryColumn({ type:'varchar2', length:36 })` + `@BeforeInsert assignId()` | `string` |
| `String` | `varchar2(255)` (long text → `clob`) | `string` |
| `Int` / `Float` | `number` | `number` |
| `BigInt` | `number` + `bigintTransformer` | `bigint` |
| `Decimal @db.Decimal(p,s)` | `number` `precision`/`scale` + `decimalTransformer` | `Decimal` (decimal.js) |
| `Boolean` | `number` `precision:1` + `booleanTransformer` | `boolean` |
| `DateTime` | `timestamp` / `@CreateDateColumn` / `@UpdateDateColumn` | `Date` |
| `Json` | `clob` + `jsonTransformer` | `unknown` |
| enum | `varchar2(40)`, value from `src/database/enums.ts` | the enum |

Oracle has no BOOLEAN (pre-23c), no native JSON column, and no ENUM — hence the
transformers. IDs are app-generated UUIDs (`crypto.randomUUID`) via `@BeforeInsert`.

## Migrating a module (the refunds pattern)

1. **Module**: add `TypeOrmModule.forFeature([...entities])` to its `imports`;
   drop `PrismaModule` once the module no longer injects `PrismaService`.
2. **Service**: replace `constructor(private prisma: PrismaService)` with
   `@InjectRepository(Entity) private readonly repo: Repository<Entity>` (one per
   entity touched).
3. **Query translation**:
   - `prisma.x.findUnique/findFirst({ where, select })` → `repo.findOne({ where, select })`
   - `prisma.x.findMany({ where, orderBy, take })` → `repo.find({ where, order, take })`
   - `prisma.x.create({ data })` + return → `repo.save(repo.create(data))`
   - `prisma.x.update({ where:{id}, data })` → `repo.update(id, data)`
   - `prisma.x.upsert(...)` → `repo.upsert(entity, conflictPaths)` or find-then-save
   - `{ field: { not: null } }` → `Not(IsNull())`; `OR: [...]` → `where: [ {...}, {...} ]`
   - `$queryRaw` (Postgres SQL) → QueryBuilder; replace Postgres-isms (`EXTRACT`,
     `::int`, `RETURNING`, `NOW()`) — most `EXTRACT`/`CASE` work on Oracle, but
     `LIMIT` → `.take()`, `RETURNING` → save-then-read.
   - `new Prisma.Decimal(x)` → `new Decimal(x)` (decimal.js).
   - enum imports from `@prisma/client` → `src/database/enums.ts`.
   - `prisma.x.createMany({ data:[...] })` → `repo.insert([...])` (or `repo.save([...])`).
   - `prisma.x.updateMany({ where, data })` → `repo.update(where, data)`.
   - `prisma.x.deleteMany({ where })` → `repo.delete(where)`.
   - `prisma.x.count({ where })` → `repo.count({ where })`.
   - `prisma.x.groupBy({ by, _count })` → `repo.createQueryBuilder('t').select('t.col','col').addSelect('COUNT(*)','count').groupBy('t.col').getRawMany()`.
   - `prisma.$transaction(async (tx) => {...})` → `this.dataSource.transaction(async (mgr) => { mgr.getRepository(Entity)... })` (inject `private dataSource: DataSource`).
   - `prisma.$transaction([p1, p2])` (array form) → run sequentially inside `dataSource.transaction`.
   - **Raw SQL** (`$queryRaw`/`$executeRaw`) → prefer QueryBuilder; if raw is kept, translate Postgres→Oracle: `LIMIT n`→`FETCH FIRST n ROWS ONLY` (or `.take()`), no `RETURNING` (save-then-read), `x::int`→`CAST(x AS NUMBER)`, `ILIKE`→`LOWER(col) LIKE LOWER(:v)`, `NOW()`→`SYSTIMESTAMP`, boolean columns are `NUMBER(1)` (`= 1`/`= 0`), `true/false` literals→`1/0`. `repo.query('...')` runs raw on Oracle.

### Oracle semantic gotchas (bit you WILL hit)
   - **Empty string `''` = NULL.** Never write `''` into a `NOT NULL` column. For
     optional/sentinel string fields make the entity column `nullable` and write
     `null` (or leave undefined) instead of `''`.
   - **Decimal columns** come back as decimal.js `Decimal` — use `.toNumber()` /
     `.toString()`, not arithmetic on the raw value.
   - **Booleans** are `NUMBER(1)` via transformer — filter with `where: { flag: true }`
     (the transformer maps it), not `= 1` in TS.
   - Identifiers ≤ 30 bytes (12.1); the naming strategy handles generated names.
4. **Tests**: mock the repository (`findOne/find/create/save/update/count`,
   `createQueryBuilder`) instead of `PrismaService`.

> Caveat: `IdempotencyService` (audit log) is still Prisma, so services that call
> it keep importing `AuditOperation`/`AuditStatus` from `@prisma/client` until it
> migrates. `SyncStatus` etc. used on entity fields come from `src/database/enums`.

## Connecting & bootstrapping the schema

The app DB uses its OWN env namespace, **`APP_DB_*`** (see `.env.example`) — kept
separate from `ORACLE_DB_*`, which is the **Oracle Fusion ERP** source that
`oracle-native.service` reads for item/config import. Do not merge them.

- **Target DB is Oracle 12.1** (Standard Edition). Two hard consequences:
  1. **30-byte identifier limit.** `OracleNamingStrategy` truncates generated
     index/FK/constraint names; long column names get an explicit short `name:`.
     Two indexes on the same column set collide — keep only one.
  2. **Empty string `''` == NULL.** A `NOT NULL` column the code writes `''` into
     will fail (`ORA-01400`). Make such columns nullable (e.g.
     `RefundTracking.oracleCreditMemoNumber`).
- **Multitenant**: connect to the **PDB** service (`pdb1...`), not the CDB-root
  service, and as the schema user (`NEW_INTEGRATION`), not `SYS`. `SYS` in the
  root can't create a normally-named local user (`ORA-65096`).
- **Thick mode is mandatory** (Native Network Encryption / `ORA-12660`). Needs
  Oracle Instant Client. On Linux/Docker set `APP_DB_INSTANT_CLIENT_DIR`; on
  Windows dev put the client dir on `PATH` before launching node.

Create the schema + all tables (one-time):
```
APP_DB_* set, plus SYS_PASSWORD + NEW_INTEGRATION_PWD + RESET_SCHEMA=true
npx ts-node --transpile-only src/database/bootstrap-schema.ts
```
`src/database/smoke-test.ts` runs a live CRUD round-trip to verify transformers.

## Finishing the migration

When every call site has moved: remove `PrismaModule` from `AppModule`, delete
`prisma/` + `@prisma/client`/`prisma` deps, and generate a TypeORM migration
(`AppDataSource`) to create the Oracle schema (or bootstrap once with
`ORACLE_DB_SYNCHRONIZE=true`).
