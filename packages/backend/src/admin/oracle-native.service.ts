import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, ObjectLiteral, Repository } from 'typeorm';
import { generateId } from '../database/id.util';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionCredential } from '../database/entities/fusion-credential.entity';
import { FusionCustomerAccount } from '../database/entities/fusion-customer-account.entity';
import { FusionReceiptMethod } from '../database/entities/fusion-receipt-method.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { OutletIntegrationConfig } from '../database/entities/outlet-integration-config.entity';
import { SalesIntegrationStatus } from '../database/entities/sales-integration-status.entity';
import { ServiceProviderJournalMeta } from '../database/entities/service-provider-journal-meta.entity';
import { VendHqCredential } from '../database/entities/vend-hq-credential.entity';
import { VendHqDiscountItem } from '../database/entities/vend-hq-discount-item.entity';
import { VendHqItemMeta } from '../database/entities/vend-hq-item-meta.entity';
import { VendHqOutlet } from '../database/entities/vend-hq-outlet.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
import { VendHqServiceProvider } from '../database/entities/vend-hq-service-provider.entity';
import { VendHqTaxMeta } from '../database/entities/vend-hq-tax-meta.entity';

// Oracle-to-middleware table + column mapping
// Keys are Oracle table names in the ODOO_INTEGRATION schema (uppercase).
// Each entry declares how Oracle rows map to entity data and which unique
// columns identify a row for upsert-on-conflict.
interface OracleTableMapping {
  oracleTable: string;
  repo: (svc: OracleNativeService) => Repository<ObjectLiteral>;
  mapRow: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Unique column(s) used as the upsert conflict target. */
  conflictColumns: string[];
}

function col(row: Record<string, unknown>, name: string): unknown {
  // Oracle column names may be uppercase or mixed case depending on quoting
  return row[name] ?? row[name.toUpperCase()] ?? row[name.toLowerCase()];
}

function str(row: Record<string, unknown>, name: string): string {
  const v = col(row, name);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return v != null ? String(v) : '';
}

/**
 * Returns the first non-empty value among the given columns, or '' if all are
 * empty. Used for NOT NULL keys that have a natural fallback (e.g. an item whose
 * ITEM_ID is null but SKU is set). Oracle treats '' as NULL, so a plain str()
 * on a null source column would fail a NOT NULL constraint (ORA-01400).
 */
function firstStr(row: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const v = col(row, name);
    if (v != null) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const s = String(v).trim();
      if (s !== '') return s;
    }
  }
  return '';
}

function num(row: Record<string, unknown>, name: string): number {
  const v = col(row, name);
  return v != null ? Number(v) : 0;
}

function bool(row: Record<string, unknown>, name: string): boolean {
  const v = col(row, name);
  if (v == null) return false;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const s = String(v);
  return s.toUpperCase() === 'Y' || s === '1' || v === true;
}

function optStr(row: Record<string, unknown>, name: string): string | null {
  const v = col(row, name);
  if (v == null) return null;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const s = String(v);
  return s.trim() !== '' ? s : null;
}

function optNum(row: Record<string, unknown>, name: string): number | null {
  const v = col(row, name);
  if (v == null) return null;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const s = String(v);
  return s.trim() !== '' ? Number(v) : null;
}

/**
 * Like {@link optNum} but only returns the value when it fits a signed 32-bit
 * integer (the range Prisma's `Int` / Postgres `integer` accept). Oracle IDs
 * such as VENDHQ_ITEM_META.SOURCE_ID are Fusion item ids well beyond Int32
 * (e.g. 100000000343698); passing those makes Prisma reject the whole row.
 * Out-of-range or non-numeric values become null so the row still imports.
 */
function optInt32(row: Record<string, unknown>, name: string): number | null {
  const v = col(row, name);
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < -2147483648 || i > 2147483647) return null;
  return i;
}

/**
 * Parses an Oracle date column into a JS Date for Prisma's DateTime fields.
 * node-oracledb returns DATE/TIMESTAMP columns as JS Date objects, but some
 * rows arrive as strings (e.g. "Sun Aug 07 2022 14:51:57 GMT+0000 (...)").
 * Prisma rejects raw date strings that aren't ISO-8601, so normalise to Date.
 * Returns null for empty/unparseable values so the row still imports.
 */
function optDate(row: Record<string, unknown>, name: string): Date | null {
  const v = col(row, name);
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const s = String(v).trim();
  if (s === '') return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function optBigInt(row: Record<string, unknown>, name: string): bigint | null {
  const v = col(row, name);
  if (v == null) return null;
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const s = String(v).trim();
  if (s === '') return null;
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint')
    return null;
  try {
    return BigInt(s.split('.')[0]);
  } catch {
    return null;
  }
}

function bigint(row: Record<string, unknown>, name: string): bigint {
  const v = col(row, name);
  if (v == null) return 0n;
  // Guard against object/array/symbol types that BigInt() cannot convert
  // and that would produce a misleading string (e.g. "[object Object]")
  // before the try-catch below could normalise the error into 0n.
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'bigint')
    return 0n;
  try {
    // Strip any decimal part (Oracle may return numeric types as floats).
    // Falls back to 0n so a single bad row does not abort the whole import;
    // the record will be skipped by Prisma's unique-constraint check.
    return BigInt(String(v).split('.')[0]);
  } catch {
    return 0n;
  }
}

const MAPPINGS: OracleTableMapping[] = [
  // OUTLETS_INTEGRATION_CONFIG → OutletIntegrationConfig
  {
    oracleTable: 'OUTLETS_INTEGRATION_CONFIG',
    repo: (s) => s.outletIntegrationConfigRepo,
    mapRow: (r) => ({
      outletName: str(r, 'OUTLET_NAME'),
      integMode: str(r, 'INTEG_MODE'),
      region: str(r, 'REGION'),
    }),
    conflictColumns: ['outletName'],
  },
  // FUSION_BUSINESS_UNIT_ID_MAP → FusionBusinessUnitMap
  {
    oracleTable: 'FUSION_BUSINESS_UNIT_ID_MAP',
    repo: (s) => s.fusionBusinessUnitMapRepo,
    mapRow: (r) => ({
      businessUnitId: bigint(r, 'BUSINESS_UNIT_ID'),
      businessUnitName: str(r, 'BUSINESS_UNIT_NAME'),
      region: str(r, 'REGION'),
    }),
    conflictColumns: ['businessUnitId', 'region'],
  },
  // FUSION_RECEIPT_METHOD → FusionReceiptMethod
  {
    oracleTable: 'FUSION_RECEIPT_METHOD',
    repo: (s) => s.fusionReceiptMethodRepo,
    mapRow: (r) => ({
      receiptMethodId: bigint(r, 'RECEIPT_METHOD_ID'),
      receiptMethodName: str(r, 'RECEIPT_METHOD_NAME'),
      receiptIsCash: bool(r, 'RECEIPT_IS_CASH'),
      receiptBankCharge: num(r, 'RECEIPT_BANK_CHARGE'),
      receiptMethodTax: num(r, 'RECEIPT_METHOD_TAX'),
      region: str(r, 'REGION'),
    }),
    conflictColumns: ['receiptMethodName', 'region'],
  },
  // FUSION_SALES_METADATA → FusionSalesMetadata
  {
    oracleTable: 'FUSION_SALES_METADATA',
    repo: (s) => s.fusionSalesMetadataRepo,
    mapRow: (r) => ({
      billToName: str(r, 'BILL_TO_NAME'),
      billToAccount: bigint(r, 'BILL_TO_ACCOUNT'),
      siteNumber: optStr(r, 'SITE_NUMBER'),
      businessUnit: str(r, 'BUSINESS_UNIT'),
      txnSource: str(r, 'TXN_SOURCE'),
      txnType: str(r, 'TXN_TYPE'),
      rateIsCorporate: bool(r, 'RATE_IS_CORPORATE'),
      recActivityNameBank: optStr(r, 'REC_ACTIVITY_NAME_BANK'),
      recActivityNameCash: optStr(r, 'REC_ACTIVITY_NAME_CASH'),
      subinventory: optStr(r, 'SUBINVENTORY'),
      integrationSource: str(r, 'INTEGRATION_SOURCE'),
      distributionAccId: optBigInt(r, 'DISTRIBUTION_ACC_ID'),
      costCenterCode: optStr(r, 'COST_CENTER_CODE'),
      region: str(r, 'REGION'),
      customerType: str(r, 'CUSTOMER_TYPE'),
    }),
    // Java key — one row per (outlet, customer type, region). Keying on
    // billToName collapsed per-branch service-provider rows into one.
    conflictColumns: ['subinventory', 'region', 'customerType'],
  },
  // SERVICE_PROVIDER_JOURNAL_META → ServiceProviderJournalMeta
  {
    oracleTable: 'SERVICE_PROVIDER_JOURNAL_META',
    repo: (s) => s.serviceProviderJournalMetaRepo,
    mapRow: (r) => ({
      region: str(r, 'REGION'),
      ledgerId: bigint(r, 'LEDGER_ID'),
      taxGroupId: optBigInt(r, 'TAX_GROUP_ID'),
      chartOfAccountsId: bigint(r, 'CHART_OF_ACCOUNTS_ID'),
      serviceProvider: str(r, 'SERVICE_PROVIDER'),
      creditDebit: optStr(r, 'CREDIT_DEBIT'),
      costIssue: optStr(r, 'COST_ISSUE'),
      costRma: optStr(r, 'COST_RMA'),
      company: optStr(r, 'COMPANY'),
      account: optStr(r, 'ACCOUNT'),
      department: optStr(r, 'DEPARTMENT'),
      productCategory: optStr(r, 'PRODUCT_CATEGORY'),
      interCompany: optStr(r, 'INTER_COMPANY'),
      jeCategory: optStr(r, 'JE_CATEGORY'),
      jeSource: optStr(r, 'JE_SOURCE'),
      isCash: bool(r, 'IS_CASH'),
      summaryFlag: bool(r, 'SUMMARY_FLAG'),
      fixedFreightCharge: num(r, 'FIXED_FREIGHT_CHARGE'),
      bankChargeRate: num(r, 'BANK_CHARGE_RATE'),
      futUsed: optStr(r, 'FUT_USED'),
      extraSegment1: optStr(r, 'EXTRA_SEGMENT_1'),
      extraSegment2: optStr(r, 'EXTRA_SEGMENT_2'),
      extraSegment3: optStr(r, 'EXTRA_SEGMENT_3'),
    }),
    // Compound key: each provider has paired CREDIT/DEBIT (× cash) rows — keying
    // on serviceProvider alone collapses them and loses the offsetting account.
    conflictColumns: ['serviceProvider', 'region', 'creditDebit', 'isCash'],
  },
  // FUSION_CREDENTIALS → FusionCredential
  {
    oracleTable: 'FUSION_CREDENTIALS',
    repo: (s) => s.fusionCredentialRepo,
    mapRow: (r) => ({
      hostName: str(r, 'HOST_NAME'),
      server: str(r, 'SERVER'),
      username: str(r, 'USERNAME'),
      password: str(r, 'PASSWORD'),
      active: bool(r, 'ACTIVE'),
    }),
    conflictColumns: ['hostName'],
  },
  // VENDHQ_CREDENTIALS → VendHqCredential
  {
    oracleTable: 'VENDHQ_CREDENTIALS',
    repo: (s) => s.vendHqCredentialRepo,
    mapRow: (r) => ({
      domainName: str(r, 'DOMAIN_NAME'),
      personalToken: str(r, 'PERSONAL_TOKEN'),
      active: bool(r, 'ACTIVE'),
      region: str(r, 'REGION'),
      fusionOrgCode: optStr(r, 'FUSION_ORG_CODE'),
      timezoneOffset: num(r, 'TIMEZONE_OFFSET'),
      fusionTaxCode: optStr(r, 'FUSION_TAX_CODE'),
      currency: optStr(r, 'CURRENCY') ?? 'AED',
    }),
    conflictColumns: ['domainName'],
  },
  // VENDHQ_OUTLETS → VendHqOutlet
  {
    oracleTable: 'VENDHQ_OUTLETS',
    repo: (s) => s.vendHqOutletRepo,
    mapRow: (r) => ({
      outletId: str(r, 'OUTLET_ID'),
      outletName: str(r, 'OUTLET_NAME'),
      currency: str(r, 'CURRENCY') || 'AED',
      version: bigint(r, 'VERSION'),
      region: str(r, 'REGION'),
    }),
    conflictColumns: ['outletId', 'region'],
  },
  // VENDHQ_REGISTERS → VendHqRegister
  {
    oracleTable: 'VENDHQ_REGISTERS',
    repo: (s) => s.vendHqRegisterRepo,
    mapRow: (r) => ({
      registerId: str(r, 'REGISTER_ID'),
      outletId: str(r, 'OUTLET_ID'),
      registerName: str(r, 'REGISTER_NAME'),
      cashAccount: optStr(r, 'CASH_ACCOUNT'),
      cashAccountId: optBigInt(r, 'CASH_ACCOUNT_ID'),
      bankAccount: optStr(r, 'BANK_ACCOUNT'),
      bankAccountId: optBigInt(r, 'BANK_ACCOUNT_ID'),
      giftAccount: optStr(r, 'GIFT_ACCOUNT'),
      giftAccountId: optBigInt(r, 'GIFT_ACCOUNT_ID'),
      version: bigint(r, 'VERSION'),
      region: str(r, 'REGION'),
    }),
    conflictColumns: ['registerId', 'region'],
  },
  // VENDHQ_SERVICE_PROVIDERS → VendHqServiceProvider
  {
    oracleTable: 'VENDHQ_SERVICE_PROVIDERS',
    repo: (s) => s.vendHqServiceProviderRepo,
    mapRow: (r) => ({
      region: str(r, 'REGION'),
      serviceProvider: str(r, 'SERVICE_PROVIDER'),
      vendHqCustomerId: optStr(r, 'VENDHQ_CUSTOMER_ID'),
      isCash: bool(r, 'IS_CASH'),
    }),
    conflictColumns: ['serviceProvider'],
  },
  // VENDHQ_DISCOUNT_ITEMS → VendHqDiscountItem
  {
    oracleTable: 'VENDHQ_DISCOUNT_ITEMS',
    repo: (s) => s.vendHqDiscountItemRepo,
    mapRow: (r) => ({
      discountItemId: str(r, 'DISCOUNT_ITEM_ID'),
      region: str(r, 'REGION'),
    }),
    conflictColumns: ['discountItemId', 'region'],
  },
  // VENDHQ_TAX_META → VendHqTaxMeta
  {
    oracleTable: 'VENDHQ_TAX_META',
    repo: (s) => s.vendHqTaxMetaRepo,
    mapRow: (r) => ({
      taxId: str(r, 'TAX_ID'),
      taxName: str(r, 'TAX_NAME'),
      version: bigint(r, 'VERSION'),
      fusionName: optStr(r, 'FUSION_NAME'),
      region: str(r, 'REGION'),
    }),
    conflictColumns: ['taxId', 'region'],
  },
  // SALES_INTEGRATION_STATUS → SalesIntegrationStatus
  {
    oracleTable: 'SALES_INTEGRATION_STATUS',
    repo: (s) => s.salesIntegrationStatusRepo,
    mapRow: (r) => ({
      region: str(r, 'REGION'),
      integMode: str(r, 'INTEG_MODE'),
      status: str(r, 'STATUS'),
    }),
    conflictColumns: ['region', 'integMode'],
  },
  // VENDHQ_ITEM_META → VendHqItemMeta
  {
    oracleTable: 'VENDHQ_ITEM_META',
    repo: (s) => s.vendHqItemMetaRepo,
    mapRow: (r) => ({
      requestId: optInt32(r, 'REQUEST_ID'),
      status: optStr(r, 'STATUS'),
      message: optStr(r, 'MESSAGE'),
      // ~1,590 items have a null ITEM_ID but a valid SKU. Since the whole
      // downstream path keys items by SKU (productCode), fall back to SKU so
      // those items still import and are usable; last resort is the handle.
      itemId: firstStr(r, 'ITEM_ID', 'SKU', 'HANDLE'),
      // Fusion SOURCE_ID exceeds Int32; null out-of-range values (field is
      // informational and unread — mirrors ItemSyncService's own handling).
      sourceId: optInt32(r, 'SOURCE_ID'),
      uomCode: optStr(r, 'UOM_CODE'),
      handle: optStr(r, 'HANDLE'),
      itemType: optStr(r, 'ITEM_TYPE'),
      uomName: optStr(r, 'UOM_NAME'),
      active: bool(r, 'ACTIVE'),
      // NAME is NOT NULL but ~71 rows have none — fall back to SKU/description.
      name: firstStr(r, 'NAME', 'SKU', 'DESCRIPTION') || 'Unnamed item',
      description: optStr(r, 'DESCRIPTION'),
      sku: optStr(r, 'SKU'),
      brandId: optStr(r, 'BRAND_ID'),
      trackInventory: bool(r, 'TRACK_INVENTORY'),
      retailPrice: optNum(r, 'RETAIL_PRICE'),
      taxId: optStr(r, 'TAX_ID'),
      requestDate: optDate(r, 'REQUEST_DATE'),
      lastUpdateDate: optDate(r, 'LAST_UPDATE_DATE'),
      region: str(r, 'REGION'),
    }),
    conflictColumns: ['itemId', 'region'],
  },
];

export interface OracleImportResult {
  table: string;
  oracleTable: string;
  imported: number;
  skipped: number;
  errors: string[];
}

export interface OracleImportSummary {
  connectedAs: string;
  tablesFound: string[];
  results: OracleImportResult[];
  totalImported: number;
  totalErrors: number;
}

@Injectable()
export class OracleNativeService {
  private readonly logger = new Logger(OracleNativeService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(OutletIntegrationConfig)
    readonly outletIntegrationConfigRepo: Repository<OutletIntegrationConfig>,
    @InjectRepository(FusionBusinessUnitMap)
    readonly fusionBusinessUnitMapRepo: Repository<FusionBusinessUnitMap>,
    @InjectRepository(FusionReceiptMethod)
    readonly fusionReceiptMethodRepo: Repository<FusionReceiptMethod>,
    @InjectRepository(FusionSalesMetadata)
    readonly fusionSalesMetadataRepo: Repository<FusionSalesMetadata>,
    @InjectRepository(ServiceProviderJournalMeta)
    readonly serviceProviderJournalMetaRepo: Repository<ServiceProviderJournalMeta>,
    @InjectRepository(FusionCredential)
    readonly fusionCredentialRepo: Repository<FusionCredential>,
    @InjectRepository(VendHqCredential)
    readonly vendHqCredentialRepo: Repository<VendHqCredential>,
    @InjectRepository(VendHqOutlet)
    readonly vendHqOutletRepo: Repository<VendHqOutlet>,
    @InjectRepository(VendHqRegister)
    readonly vendHqRegisterRepo: Repository<VendHqRegister>,
    @InjectRepository(VendHqServiceProvider)
    readonly vendHqServiceProviderRepo: Repository<VendHqServiceProvider>,
    @InjectRepository(VendHqDiscountItem)
    readonly vendHqDiscountItemRepo: Repository<VendHqDiscountItem>,
    @InjectRepository(VendHqTaxMeta)
    readonly vendHqTaxMetaRepo: Repository<VendHqTaxMeta>,
    @InjectRepository(SalesIntegrationStatus)
    readonly salesIntegrationStatusRepo: Repository<SalesIntegrationStatus>,
    @InjectRepository(VendHqItemMeta)
    readonly vendHqItemMetaRepo: Repository<VendHqItemMeta>,
    @InjectRepository(FusionCustomerAccount)
    readonly fusionCustomerAccountRepo: Repository<FusionCustomerAccount>,
  ) {}

  /**
   * Extracts a human-readable identifier from an Oracle row for error messages.
   * Tries common ID/name/code columns to help identify which row failed.
   */
  /**
   * Assigns the client-generated primary key before an upsert.
   *
   * Entities migrated off Prisma keep a string PK filled in by a `@BeforeInsert`
   * hook, but TypeORM's `upsert()` goes through the InsertQueryBuilder and never
   * fires entity listeners — every insert would fail with
   * `ORA-01400: cannot insert NULL into (..."id")`.
   *
   * The existing row's id is reused when the conflict target already matches, so
   * re-running an import never re-keys a row (which would break FK references).
   */
  private async ensurePrimaryKey(
    repo: Repository<ObjectLiteral>,
    data: Record<string, unknown>,
    conflictColumns: string[],
  ): Promise<void> {
    const primary = repo.metadata.primaryColumns;
    // Only applies to a single, app-generated string PK. Numeric/identity or
    // composite keys are left to the database.
    if (primary.length !== 1) return;
    const pk = primary[0].propertyName;
    if (primary[0].isGenerated || data[pk] != null) return;

    const where = Object.fromEntries(
      conflictColumns.map((c) => [c, data[c] ?? IsNull()]),
    );
    const existing = await repo.findOne({
      where,
      select: { [pk]: true },
    });
    data[pk] = existing?.[pk] ?? generateId();
  }

  /**
   * Returns the NOT NULL, non-defaulted columns whose mapped value is empty.
   * Oracle treats '' as NULL, so these would fail ORA-01400 on insert. The PK
   * (filled by ensurePrimaryKey) and auto-managed date/version columns are
   * excluded.
   */
  private missingRequiredColumns(
    repo: Repository<ObjectLiteral>,
    data: Record<string, unknown>,
  ): string[] {
    const pk = new Set(repo.metadata.primaryColumns.map((c) => c.propertyName));
    const missing: string[] = [];
    for (const col of repo.metadata.columns) {
      if (col.isNullable) continue;
      if (col.default !== undefined) continue;
      if (
        col.isGenerated ||
        col.isCreateDate ||
        col.isUpdateDate ||
        col.isVersion ||
        pk.has(col.propertyName)
      ) {
        continue;
      }
      const v = data[col.propertyName];
      if (v === null || v === undefined || v === '') {
        missing.push(col.propertyName);
      }
    }
    return missing;
  }

  private getRowIdentifier(
    row: Record<string, unknown>,
    _mapping: OracleTableMapping,
  ): string | null {
    // Try common identifier columns
    const identifierKeys = [
      'ROW_ID',
      'ID',
      'ITEM_ID',
      'NAME',
      'OUTLET_NAME',
      'REGION',
      'CODE',
      'BUSINESS_UNIT_NAME',
      'BILL_TO_NAME',
      'SERVICE_PROVIDER',
    ];

    for (const key of identifierKeys) {
      const value = col(row, key);
      if (value == null) {
        continue;
      }
      const strValue =
        typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
      if (strValue.trim() !== '') {
        return `${key}=${strValue}`;
      }
    }

    return null;
  }

  private getConnectionConfig() {
    const host = this.config.get<string>('ORACLE_DB_HOST');
    const port = this.config.get<number>('ORACLE_DB_PORT') ?? 1521;
    const serviceName = this.config.get<string>('ORACLE_DB_SERVICE');
    const username = this.config.get<string>('ORACLE_DB_USERNAME');
    const password = this.config.get<string>('ORACLE_DB_PASSWORD');

    if (!host || !serviceName || !username || !password) {
      throw new BadRequestException(
        'Oracle DB connection not configured. Set ORACLE_DB_HOST, ORACLE_DB_SERVICE, ORACLE_DB_USERNAME, ORACLE_DB_PASSWORD in environment.',
      );
    }

    return { host, port: Number(port), serviceName, username, password };
  }

  async importFromOracle(tables?: string[]): Promise<OracleImportSummary> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const oracledb = require('oracledb') as typeof import('oracledb');

    // Enable thick mode when configured (required for Native Network Encryption / ORA-12660).
    // Thick mode requires Oracle Instant Client to be installed on the host.
    // Set ORACLE_DB_THICK_MODE=true and optionally ORACLE_DB_INSTANT_CLIENT_DIR to the
    // directory containing the Instant Client shared libraries.
    const useThickMode = ['true', '1', 'yes'].includes(
      (this.config.get<string>('ORACLE_DB_THICK_MODE') ?? '').toLowerCase(),
    );
    if (useThickMode && oracledb.thin) {
      const libDir = this.config.get<string>('ORACLE_DB_INSTANT_CLIENT_DIR');
      try {
        oracledb.initOracleClient(libDir ? { libDir } : {});
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(
          `Failed to initialise Oracle thick mode: ${msg}. ` +
            'Ensure Oracle Instant Client is installed and ORACLE_DB_INSTANT_CLIENT_DIR points to its library directory.',
        );
      }
    }

    const cfg = this.getConnectionConfig();

    const connectString = `${cfg.host}:${cfg.port}/${cfg.serviceName}`;
    const role = this.config.get<string>('ORACLE_DB_ROLE');
    const privilege =
      role?.toUpperCase() === 'SYSDBA' ? oracledb.SYSDBA : undefined;

    // Fail fast when the DB is unreachable instead of hanging the request —
    // oracledb.getConnection has no built-in acquisition timeout in thick mode.
    const CONNECT_TIMEOUT_MS = 20_000;
    let connection: import('oracledb').Connection | undefined;
    try {
      connection = await Promise.race([
        oracledb.getConnection({
          user: cfg.username,
          password: cfg.password,
          connectString,
          ...(privilege !== undefined ? { privilege } : {}),
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`,
                ),
              ),
            CONNECT_TIMEOUT_MS,
          ),
        ),
      ]);
      // Bound individual queries so a huge table scan can't hang indefinitely.
      connection.callTimeout = 120_000;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Failed to connect to Oracle DB: ${msg}`);
    }

    const rawSchema =
      this.config.get<string>('ORACLE_DB_SCHEMA') ?? 'ODOO_INTEGRATION';
    // Validate schema name to prevent SQL injection through configuration
    if (!/^[A-Za-z0-9_]+$/.test(rawSchema)) {
      throw new BadRequestException(
        `Invalid ORACLE_DB_SCHEMA name: "${rawSchema}"`,
      );
    }
    const schema = rawSchema.toUpperCase();

    // Discover which tables exist in the schema
    let tablesFound: string[] = [];
    try {
      const result = await connection.execute<[string]>(
        `SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = :owner ORDER BY TABLE_NAME`,
        [schema],
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      tablesFound = (result.rows ?? []).map((r) => r[0]);
    } catch {
      // Fallback: try to use SYS.ALL_TABLES with DBA_TABLES
      this.logger.warn(
        'Could not query ALL_TABLES, attempting DBA_TABLES fallback',
      );
    }

    const targetMappings = MAPPINGS.filter((m) => {
      if (tables && tables.length > 0) {
        return tables.includes(m.oracleTable);
      }
      return tablesFound.length === 0 || tablesFound.includes(m.oracleTable);
    });

    const results: OracleImportResult[] = [];

    for (const mapping of targetMappings) {
      const repo = mapping.repo(this);
      const result: OracleImportResult = {
        table: repo.metadata.name || mapping.oracleTable,
        oracleTable: mapping.oracleTable,
        imported: 0,
        skipped: 0,
        errors: [],
      };

      try {
        const queryResult = await connection.execute<Record<string, unknown>>(
          `SELECT * FROM "${schema}"."${mapping.oracleTable}"`,
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        );

        const rows = queryResult.rows ?? [];

        // Upsert in concurrent chunks — row-by-row sequential upserts made a
        // full multi-table import exceed the request timeout.
        const CHUNK = 25;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const outcomes = await Promise.allSettled(
            chunk.map((row) =>
              // Resolve inside so mapRow errors are captured too.
              Promise.resolve().then(async () => {
                const data = mapping.mapRow(row);
                // Turn the opaque ORA-01400 (Oracle stores '' as NULL, so a
                // NOT NULL column fed an empty value is rejected) into a clear,
                // actionable skip reason naming the exact column.
                const missing = this.missingRequiredColumns(repo, data);
                if (missing.length > 0) {
                  throw new Error(
                    `source row has empty required column(s): ${missing.join(', ')}`,
                  );
                }
                await this.ensurePrimaryKey(
                  repo,
                  data,
                  mapping.conflictColumns,
                );
                return repo.upsert(data, mapping.conflictColumns);
              }),
            ),
          );
          outcomes.forEach((outcome, j) => {
            if (outcome.status === 'fulfilled') {
              result.imported++;
              return;
            }
            result.skipped++;
            const row = chunk[j];
            const errorMsg =
              outcome.reason instanceof Error
                ? outcome.reason.message
                : String(outcome.reason);
            const rowIdentifier = this.getRowIdentifier(row, mapping);
            // Cap the errors array so a fully-mismatched table can't bloat the response.
            if (result.errors.length < 50) {
              result.errors.push(
                `Row ${i + j + 1}${rowIdentifier ? ` (${rowIdentifier})` : ''}: ${errorMsg}`,
              );
            }
            this.logger.warn(
              `Oracle import error in ${mapping.oracleTable} row ${i + j + 1}: ${errorMsg}`,
            );
          });
        }
      } catch (tableErr: unknown) {
        const msg =
          tableErr instanceof Error ? tableErr.message : String(tableErr);
        this.logger.warn(
          `Skipping Oracle table ${mapping.oracleTable}: ${msg}`,
        );
        result.errors.push(`Table query failed: ${msg}`);
      }

      results.push(result);
    }

    await connection.close();

    const totalImported = results.reduce((s, r) => s + r.imported, 0);
    const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);

    return {
      connectedAs: `${cfg.username}@${cfg.host}:${cfg.port}/${cfg.serviceName}`,
      tablesFound,
      results,
      totalImported,
      totalErrors,
    };
  }

  /**
   * Seeds the FusionCustomerAccount map (account number → cust_account_id) used
   * by standard receipts as <CustomerId>. Oracle's CustomerProfileService (the
   * Java resolver) is unavailable on the current pod, so the map is derived from
   * the historical Oracle tables: FUSION_STANDARD_RECEIPT.CUSTOMER_ID correlated
   * with FUSION_INVOICE_HEADER.BILL_TO_ACC_NUMBER via the shared transaction
   * number embedded in the receipt number. When an account maps to more than one
   * customer id, the most frequently used id wins.
   */
  async importCustomerAccounts(): Promise<{
    connectedAs: string;
    imported: number;
    distinctAccounts: number;
    errors: string[];
  }> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const oracledb = require('oracledb') as typeof import('oracledb');
    const useThickMode = ['true', '1', 'yes'].includes(
      (this.config.get<string>('ORACLE_DB_THICK_MODE') ?? '').toLowerCase(),
    );
    if (useThickMode && oracledb.thin) {
      const libDir = this.config.get<string>('ORACLE_DB_INSTANT_CLIENT_DIR');
      try {
        oracledb.initOracleClient(libDir ? { libDir } : {});
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(
          `Failed to initialise Oracle thick mode: ${msg}.`,
        );
      }
    }

    const cfg = this.getConnectionConfig();
    const connectString = `${cfg.host}:${cfg.port}/${cfg.serviceName}`;
    const role = this.config.get<string>('ORACLE_DB_ROLE');
    const privilege =
      role?.toUpperCase() === 'SYSDBA' ? oracledb.SYSDBA : undefined;

    let connection: import('oracledb').Connection | undefined;
    try {
      connection = await oracledb.getConnection({
        user: cfg.username,
        password: cfg.password,
        connectString,
        ...(privilege !== undefined ? { privilege } : {}),
      });
      connection.callTimeout = 120_000;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Failed to connect to Oracle DB: ${msg}`);
    }

    const rawSchema =
      this.config.get<string>('ORACLE_DB_SCHEMA') ?? 'ODOO_INTEGRATION';
    if (!/^[A-Za-z0-9_]+$/.test(rawSchema)) {
      throw new BadRequestException(
        `Invalid ORACLE_DB_SCHEMA name: "${rawSchema}"`,
      );
    }
    const schema = rawSchema.toUpperCase();
    const errors: string[] = [];

    // account+region → { customerId → occurrence count, name }
    const map = new Map<
      string,
      {
        accountNumber: bigint;
        region: string;
        name: string | null;
        counts: Map<string, number>;
      }
    >();

    try {
      const q = `SELECT h.BILL_TO_ACC_NUMBER AS ACCT, h.BILL_TO_CUST_NAME AS NAME,
                        r.CUSTOMER_ID AS CID, r.REGION AS REGION, COUNT(*) AS CNT
                   FROM "${schema}"."FUSION_STANDARD_RECEIPT" r
                   JOIN "${schema}"."FUSION_INVOICE_HEADER" h
                     ON TO_CHAR(h.TXN_NUMBER) = REGEXP_SUBSTR(r.RECEIPT_NUMBER, '[0-9]+$')
                  WHERE r.CUSTOMER_ID IS NOT NULL
                    AND h.BILL_TO_ACC_NUMBER IS NOT NULL
                  GROUP BY h.BILL_TO_ACC_NUMBER, h.BILL_TO_CUST_NAME, r.CUSTOMER_ID, r.REGION`;
      const res = await connection.execute<Record<string, unknown>>(q, [], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      // Oracle scalar columns arrive as string/number; anything else is a
      // driver anomaly and the row is skipped rather than stringified badly.
      const scalar = (v: unknown): string | null =>
        typeof v === 'string' || typeof v === 'number' ? String(v) : null;
      for (const row of res.rows ?? []) {
        const acct = scalar(row['ACCT']);
        const cid = scalar(row['CID']);
        const region = scalar(row['REGION']);
        if (acct == null || cid == null || region == null) continue;
        const key = `${acct}|${region}`;
        const entry = map.get(key) ?? {
          accountNumber: BigInt(acct),
          region,
          name: scalar(row['NAME']),
          counts: new Map<string, number>(),
        };
        const cidStr = cid;
        const cnt = Number(row['CNT'] ?? 1);
        entry.counts.set(cidStr, (entry.counts.get(cidStr) ?? 0) + cnt);
        map.set(key, entry);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await connection.close();
      throw new BadRequestException(
        `Customer-account correlation query failed: ${msg}`,
      );
    }

    await connection.close();

    let imported = 0;
    for (const entry of map.values()) {
      // Pick the most frequently used customer id for this account+region.
      let bestCid = '';
      let bestCount = -1;
      for (const [cid, count] of entry.counts) {
        if (count > bestCount) {
          bestCount = count;
          bestCid = cid;
        }
      }
      const data = {
        accountNumber: entry.accountNumber,
        customerAccountId: BigInt(bestCid),
        region: entry.region,
        customerName: entry.name,
      };
      const conflictColumns = ['accountNumber', 'region'];
      try {
        await this.ensurePrimaryKey(
          this.fusionCustomerAccountRepo,
          data,
          conflictColumns,
        );
        await this.fusionCustomerAccountRepo.upsert(data, conflictColumns);
        imported++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (errors.length < 50) {
          errors.push(`${entry.accountNumber}/${entry.region}: ${msg}`);
        }
      }
    }

    return {
      connectedAs: `${cfg.username}@${cfg.host}:${cfg.port}/${cfg.serviceName}`,
      imported,
      distinctAccounts: map.size,
      errors,
    };
  }
}
