import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

// Oracle-to-middleware table + column mapping
// Keys are Oracle table names in the ODOO_INTEGRATION schema (uppercase).
// Each entry declares how Oracle rows map to Prisma create-data objects.
interface OracleTableMapping {
  oracleTable: string;
  prismaDelegate: (prisma: PrismaService) => {
    upsert: (args: Record<string, unknown>) => Promise<unknown>;
  };
  mapRow: (row: Record<string, unknown>) => Record<string, unknown>;
  upsertWhere: (row: Record<string, unknown>) => Record<string, unknown>;
}

function col(row: Record<string, unknown>, name: string): unknown {
  // Oracle column names may be uppercase or mixed case depending on quoting
  return row[name] ?? row[name.toUpperCase()] ?? row[name.toLowerCase()];
}

function str(row: Record<string, unknown>, name: string): string {
  const v = col(row, name);
  return v != null ? String(v) : '';
}

function num(row: Record<string, unknown>, name: string): number {
  const v = col(row, name);
  return v != null ? Number(v) : 0;
}

function bool(row: Record<string, unknown>, name: string): boolean {
  const v = col(row, name);
  if (v == null) return false;
  return String(v).toUpperCase() === 'Y' || String(v) === '1' || v === true;
}

function optStr(row: Record<string, unknown>, name: string): string | null {
  const v = col(row, name);
  return v != null && String(v).trim() !== '' ? String(v) : null;
}

function optNum(row: Record<string, unknown>, name: string): number | null {
  const v = col(row, name);
  return v != null && String(v).trim() !== '' ? Number(v) : null;
}

const MAPPINGS: OracleTableMapping[] = [
  // OUTLET_INTEGRATION_CONFIG → OutletIntegrationConfig
  {
    oracleTable: 'OUTLET_INTEGRATION_CONFIG',
    prismaDelegate: (p) => p.outletIntegrationConfig as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      outletName: str(r, 'OUTLET_NAME'),
      integMode: str(r, 'INTEG_MODE'),
      region: str(r, 'REGION'),
    }),
    upsertWhere: (r) => ({ outletName: str(r, 'OUTLET_NAME') }),
  },
  // FUSION_BU_MAP → FusionBusinessUnitMap
  {
    oracleTable: 'FUSION_BU_MAP',
    prismaDelegate: (p) => p.fusionBusinessUnitMap as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      businessUnitId: num(r, 'BUSINESS_UNIT_ID'),
      businessUnitName: str(r, 'BUSINESS_UNIT_NAME'),
      region: str(r, 'REGION'),
    }),
    upsertWhere: (r) => ({
      businessUnitId_region: {
        businessUnitId: num(r, 'BUSINESS_UNIT_ID'),
        region: str(r, 'REGION'),
      },
    }),
  },
  // FUSION_RECEIPT_METHODS → FusionReceiptMethod
  {
    oracleTable: 'FUSION_RECEIPT_METHODS',
    prismaDelegate: (p) => p.fusionReceiptMethod as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      receiptMethodId: num(r, 'RECEIPT_METHOD_ID'),
      receiptMethodName: str(r, 'RECEIPT_METHOD_NAME'),
      receiptIsCash: bool(r, 'RECEIPT_IS_CASH'),
      receiptBankCharge: num(r, 'RECEIPT_BANK_CHARGE'),
      receiptMethodTax: num(r, 'RECEIPT_METHOD_TAX'),
      region: str(r, 'REGION'),
    }),
    upsertWhere: (r) => ({ receiptMethodName: str(r, 'RECEIPT_METHOD_NAME') }),
  },
  // FUSION_SALES_METADATA → FusionSalesMetadata
  {
    oracleTable: 'FUSION_SALES_METADATA',
    prismaDelegate: (p) => p.fusionSalesMetadata as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      billToName: str(r, 'BILL_TO_NAME'),
      billToAccount: num(r, 'BILL_TO_ACCOUNT'),
      siteNumber: optStr(r, 'SITE_NUMBER'),
      businessUnit: str(r, 'BUSINESS_UNIT'),
      txnSource: str(r, 'TXN_SOURCE'),
      txnType: str(r, 'TXN_TYPE'),
      rateIsCorporate: bool(r, 'RATE_IS_CORPORATE'),
      recActivityNameBank: optStr(r, 'REC_ACTIVITY_NAME_BANK'),
      recActivityNameCash: optStr(r, 'REC_ACTIVITY_NAME_CASH'),
      subinventory: optStr(r, 'SUBINVENTORY'),
      integrationSource: str(r, 'INTEGRATION_SOURCE'),
      distributionAccId: optNum(r, 'DISTRIBUTION_ACC_ID'),
      costCenterCode: optStr(r, 'COST_CENTER_CODE'),
      region: str(r, 'REGION'),
      customerType: str(r, 'CUSTOMER_TYPE'),
    }),
    upsertWhere: (r) => ({ billToName: str(r, 'BILL_TO_NAME') }),
  },
  // SERVICE_PROVIDER_JOURNAL_META → ServiceProviderJournalMeta
  {
    oracleTable: 'SERVICE_PROVIDER_JOURNAL_META',
    prismaDelegate: (p) => p.serviceProviderJournalMeta as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      region: str(r, 'REGION'),
      ledgerId: num(r, 'LEDGER_ID'),
      taxGroupId: optNum(r, 'TAX_GROUP_ID'),
      chartOfAccountsId: num(r, 'CHART_OF_ACCOUNTS_ID'),
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
    }),
    upsertWhere: (r) => ({ serviceProvider: str(r, 'SERVICE_PROVIDER') }),
  },
  // FUSION_CREDENTIALS → FusionCredential
  {
    oracleTable: 'FUSION_CREDENTIALS',
    prismaDelegate: (p) => p.fusionCredential as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      hostName: str(r, 'HOST_NAME'),
      server: str(r, 'SERVER'),
      username: str(r, 'USERNAME'),
      password: str(r, 'PASSWORD'),
      active: bool(r, 'ACTIVE'),
    }),
    upsertWhere: (r) => ({ hostName: str(r, 'HOST_NAME') }),
  },
  // VENDHQ_CREDENTIALS → VendHqCredential
  {
    oracleTable: 'VENDHQ_CREDENTIALS',
    prismaDelegate: (p) => p.vendHqCredential as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      domainName: str(r, 'DOMAIN_NAME'),
      personalToken: str(r, 'PERSONAL_TOKEN'),
      active: bool(r, 'ACTIVE'),
      region: str(r, 'REGION'),
      fusionOrgCode: optStr(r, 'FUSION_ORG_CODE'),
      timezoneOffset: num(r, 'TIMEZONE_OFFSET'),
      fusionTaxCode: optStr(r, 'FUSION_TAX_CODE'),
    }),
    upsertWhere: (r) => ({ domainName: str(r, 'DOMAIN_NAME') }),
  },
  // VENDHQ_OUTLETS → VendHqOutlet
  {
    oracleTable: 'VENDHQ_OUTLETS',
    prismaDelegate: (p) => p.vendHqOutlet as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      outletId: str(r, 'OUTLET_ID'),
      outletName: str(r, 'OUTLET_NAME'),
      currency: str(r, 'CURRENCY') || 'AED',
      version: num(r, 'VERSION') || 1,
      region: str(r, 'REGION'),
    }),
    upsertWhere: (r) => ({
      outletId_region: {
        outletId: str(r, 'OUTLET_ID'),
        region: str(r, 'REGION'),
      },
    }),
  },
  // VENDHQ_REGISTERS → VendHqRegister
  {
    oracleTable: 'VENDHQ_REGISTERS',
    prismaDelegate: (p) => p.vendHqRegister as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      registerId: str(r, 'REGISTER_ID'),
      outletId: str(r, 'OUTLET_ID'),
      registerName: str(r, 'REGISTER_NAME'),
      cashAccount: optStr(r, 'CASH_ACCOUNT'),
      cashAccountId: optNum(r, 'CASH_ACCOUNT_ID'),
      bankAccount: optStr(r, 'BANK_ACCOUNT'),
      bankAccountId: optNum(r, 'BANK_ACCOUNT_ID'),
      giftAccount: optStr(r, 'GIFT_ACCOUNT'),
      giftAccountId: optNum(r, 'GIFT_ACCOUNT_ID'),
      version: num(r, 'VERSION') || 1,
      region: str(r, 'REGION'),
    }),
    upsertWhere: (r) => ({
      registerId_region: {
        registerId: str(r, 'REGISTER_ID'),
        region: str(r, 'REGION'),
      },
    }),
  },
  // VENDHQ_SERVICE_PROVIDERS → VendHqServiceProvider
  {
    oracleTable: 'VENDHQ_SERVICE_PROVIDERS',
    prismaDelegate: (p) => p.vendHqServiceProvider as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      region: str(r, 'REGION'),
      serviceProvider: str(r, 'SERVICE_PROVIDER'),
      vendHqCustomerId: optStr(r, 'VENDHQ_CUSTOMER_ID'),
      isCash: bool(r, 'IS_CASH'),
    }),
    upsertWhere: (r) => ({ serviceProvider: str(r, 'SERVICE_PROVIDER') }),
  },
  // VENDHQ_DISCOUNT_ITEMS → VendHqDiscountItem
  {
    oracleTable: 'VENDHQ_DISCOUNT_ITEMS',
    prismaDelegate: (p) => p.vendHqDiscountItem as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      discountItemId: str(r, 'DISCOUNT_ITEM_ID'),
      region: str(r, 'REGION'),
    }),
    upsertWhere: (r) => ({
      discountItemId_region: {
        discountItemId: str(r, 'DISCOUNT_ITEM_ID'),
        region: str(r, 'REGION'),
      },
    }),
  },
  // VENDHQ_TAX_META → VendHqTaxMeta
  {
    oracleTable: 'VENDHQ_TAX_META',
    prismaDelegate: (p) => p.vendHqTaxMeta as ReturnType<OracleTableMapping['prismaDelegate']>,
    mapRow: (r) => ({
      taxId: str(r, 'TAX_ID'),
      taxName: str(r, 'TAX_NAME'),
      version: num(r, 'VERSION') || 1,
      fusionName: optStr(r, 'FUSION_NAME'),
      region: str(r, 'REGION'),
    }),
    upsertWhere: (r) => ({
      taxId_region: {
        taxId: str(r, 'TAX_ID'),
        region: str(r, 'REGION'),
      },
    }),
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
    private readonly prisma: PrismaService,
  ) {}

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
    // oracledb v6+ defaults to thin mode (pure JS, no Oracle Instant Client required)
    const cfg = this.getConnectionConfig();

    const connectString = `${cfg.host}:${cfg.port}/${cfg.serviceName}`;
    const role = this.config.get<string>('ORACLE_DB_ROLE');
    const privilege = role?.toUpperCase() === 'SYSDBA' ? oracledb.SYSDBA : undefined;

    let connection: import('oracledb').Connection | undefined;
    try {
      connection = await oracledb.getConnection({
        user: cfg.username,
        password: cfg.password,
        connectString,
        ...(privilege !== undefined ? { privilege } : {}),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(`Failed to connect to Oracle DB: ${msg}`);
    }

    const rawSchema = this.config.get<string>('ORACLE_DB_SCHEMA') ?? 'ODOO_INTEGRATION';
    // Validate schema name to prevent SQL injection through configuration
    if (!/^[A-Za-z0-9_]+$/.test(rawSchema)) {
      throw new BadRequestException(`Invalid ORACLE_DB_SCHEMA name: "${rawSchema}"`);
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
      this.logger.warn('Could not query ALL_TABLES, attempting DBA_TABLES fallback');
    }

    const targetMappings = MAPPINGS.filter((m) => {
      if (tables && tables.length > 0) {
        return tables.includes(m.oracleTable);
      }
      return tablesFound.length === 0 || tablesFound.includes(m.oracleTable);
    });

    const results: OracleImportResult[] = [];

    for (const mapping of targetMappings) {
      const result: OracleImportResult = {
        table: String(mapping.prismaDelegate.name || mapping.oracleTable),
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

        const rows = (queryResult.rows ?? []) as Record<string, unknown>[];
        const delegate = mapping.prismaDelegate(this.prisma);

        for (const row of rows) {
          try {
            const data = mapping.mapRow(row);
            const where = mapping.upsertWhere(row);
            await delegate.upsert({ where, update: data, create: data });
            result.imported++;
          } catch (rowErr: unknown) {
            result.skipped++;
            result.errors.push(rowErr instanceof Error ? rowErr.message : String(rowErr));
          }
        }
      } catch (tableErr: unknown) {
        const msg = tableErr instanceof Error ? tableErr.message : String(tableErr);
        this.logger.warn(`Skipping Oracle table ${mapping.oracleTable}: ${msg}`);
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
}
