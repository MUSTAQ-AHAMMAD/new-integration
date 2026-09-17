import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { FusionCredentialResolver } from './fusion-credential.resolver';
import {
  withTimeout,
  MODULE_INIT_TIMEOUT_MS,
} from '../../common/utils/timeout';
import { Semaphore } from '../../common/utils/semaphore';

export interface OracleInvoiceData {
  customerTransactionId?: string;
  billToCustomerNumber?: string;
  transactionNumber?: string;
  transactionDate?: string;
  currencyCode?: string;
  amount?: number;
  lines?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OracleInvoiceResult {
  invoiceId?: string;
  invoiceNumber?: string;
  status?: string;
  [key: string]: unknown;
}

export interface StagedInventoryTransaction {
  organizationId: number;
  itemNumber: string;
  subinventoryCode: string;
  /** Negative for an issue (sale), positive for a return/RMA. */
  transactionQuantity: number;
  transactionUom: string;
  transactionDate: string;
  transactionTypeName: string;
  transactionSourceName: string;
  sourceCode: string;
  sourceHeaderId: number;
  sourceLineId: number;
  transactionInterfaceId: number;
}

export interface OracleCreditMemoData {
  creditMemoNumber?: string;
  transactionDate?: string;
  amount?: number;
  reason?: string;
  relatedInvoiceNumber?: string;
  lines?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OracleCreditMemoResult {
  creditMemoId?: string;
  creditMemoNumber?: string;
  status?: string;
  [key: string]: unknown;
}

export interface OracleInventoryItem {
  ItemId?: number;
  ItemNumber: string;
  ItemDescription?: string;
  LongDescription?: string;
  PrimaryUOMCode?: string;
  PrimaryUOMValue?: string;
  UserItemTypeValue?: string;
  /** Oracle active-status field — value is "Active" or other codes */
  InventoryItemStatusCode?: string;
  /** Market / retail price as returned by Oracle (may be a string in some API versions) */
  MarketPrice?: number | string;
  OrganizationCode?: string;
  OrganizationId?: number;
  OutputTaxClassificationCodeValue?: string;
  LastUpdateDate?: string;
  CreationDate?: string;
  [key: string]: unknown;
}

export interface OracleOnHandQuantity {
  ItemNumber: string;
  OrganizationCode?: string;
  OrganizationId?: number;
  SubinventoryCode?: string;
  OnHandQuantity?: number;
  UOMCode?: string;
  [key: string]: unknown;
}

export interface OracleCashBankAccount {
  BankAccountId: number;
  BankAccountName?: string;
  BankName?: string;
  CurrencyCode?: string;
  ArUseAllowedFlag?: boolean;
  [key: string]: unknown;
}

/**
 * An AR invoice as Oracle holds it right now, read back by transaction number.
 * Field names are the camelCase of the `receivablesInvoices` REST attributes.
 */
export interface OracleLiveInvoice {
  transactionNumber: string | null;
  customerTransactionId: number | null;
  documentNumber: number | null;
  /** Oracle's own lifecycle state, e.g. "Complete" / "Incomplete". */
  status: string | null;
  transactionDate: string | null;
  accountingDate: string | null;
  currencyCode: string | null;
  transactionType: string | null;
  transactionSource: string | null;
  businessUnit: string | null;
  billToCustomerName: string | null;
  billToCustomerNumber: string | null;
  /** Oracle's invoice total. */
  enteredAmount: number | null;
  /** Still outstanding; 0 means fully receipted. */
  balanceAmount: number | null;
}

/**
 * A credit memo as Oracle currently holds it. balanceAmount is the key field:
 * a memo that still carries its full balance was created but never applied.
 */
export interface OracleLiveCreditMemo {
  transactionNumber: string | null;
  customerTransactionId: number | null;
  status: string | null;
  transactionDate: string | null;
  currencyCode: string | null;
  transactionType: string | null;
  businessUnit: string | null;
  billToCustomerName: string | null;
  billToCustomerNumber: string | null;
  /** Oracle's memo total (negative for a credit). */
  enteredAmount: number | null;
  /** Still unapplied. 0 means fully applied to an invoice. */
  balanceAmount: number | null;
}

export interface OracleLiveInvoiceLine {
  lineNumber: number | null;
  description: string | null;
  itemNumber: string | null;
  quantity: number | null;
  unitSellingPrice: number | null;
  lineAmount: number | null;
  taxClassificationCode: string | null;
  salesOrder: string | null;
  unitOfMeasure: string | null;
}

@Injectable()
export class OracleClient implements OnModuleInit {
  private readonly logger = new Logger(OracleClient.name);
  private http: AxiosInstance;
  private readonly circuitBreaker: CircuitBreakerService;
  /**
   * Global cap on concurrent inventory (and other bulk) REST calls to Oracle.
   * The POST phase fans out inventory issues across parallel stores AND within a
   * store; this keeps the aggregate load on Oracle bounded and tunable
   * (ORACLE_REST_CONCURRENCY).
   */
  private readonly restGate: Semaphore;

  constructor(
    private readonly configService: ConfigService,
    @Optional() circuitBreaker?: CircuitBreakerService,
    @Optional() private readonly credentialResolver?: FusionCredentialResolver,
  ) {
    this.circuitBreaker = circuitBreaker ?? new CircuitBreakerService();
    this.restGate = new Semaphore(
      Math.max(
        1,
        parseInt(
          this.configService.get<string>('ORACLE_REST_CONCURRENCY', '16'),
          10,
        ) || 16,
      ),
    );
    // Synchronous env-var initialisation — same pattern as OracleSoapClient.
    this.http = axios.create({
      baseURL: this.configService.get<string>('ORACLE_REST_BASE_URL'),
      timeout: 30_000,
      auth: {
        username: this.configService.get<string>('ORACLE_USERNAME', ''),
        password: this.configService.get<string>('ORACLE_PASSWORD', ''),
      },
    });
  }

  /**
   * When a {@link FusionCredentialResolver} is injected, re-initialises
   * the HTTP client with connection settings from the `FusionCredential`
   * database table (hostname + server → URL, username/password → auth).
   */
  async onModuleInit(): Promise<void> {
    if (!this.credentialResolver) return;
    try {
      const settings = await withTimeout(
        this.credentialResolver.resolveOracleConnectionSettings(),
        MODULE_INIT_TIMEOUT_MS,
        'OracleClient.onModuleInit',
      );
      if (!settings || settings.source === 'environment') return;

      this.http = axios.create({
        baseURL: settings.restBaseUrl,
        timeout: 30_000,
        auth: {
          username: settings.username,
          password: settings.password,
        },
      });
      this.logger.log(
        `Oracle REST client re-initialised with database credentials (${settings.restBaseUrl})`,
      );
    } catch (err) {
      this.logger.warn(
        `onModuleInit: failed to load DB credentials for Oracle REST client — ` +
          `continuing with env-var credentials: ${(err as Error).message}`,
      );
    }
  }

  async createInvoice(data: OracleInvoiceData): Promise<OracleInvoiceResult> {
    return this.circuitBreaker.execute('oracle:createInvoice', () =>
      this.withRetries(async () => {
        const response = await this.http.post('/receivables/invoices', data);
        return this.extractObject<OracleInvoiceResult>(response.data);
      }),
    );
  }

  /**
   * Resolves the Oracle inventory OrganizationId that owns a subinventory, via
   * the activeSubinventories REST resource. Cached per subinventory name.
   *
   * The legacy Java system used activeSubinventories the same way to map an
   * outlet's subinventory to its inventory organisation before posting a
   * transaction.
   */
  private readonly subinventoryOrgCache = new Map<string, number | null>();

  async resolveSubinventoryOrgId(
    subinventoryName: string,
  ): Promise<number | null> {
    const key = (subinventoryName ?? '').trim();
    if (!key) return null;
    if (this.subinventoryOrgCache.has(key)) {
      return this.subinventoryOrgCache.get(key) ?? null;
    }
    const orgId = await this.circuitBreaker.execute(
      'oracle:resolveSubinventoryOrg',
      () =>
        this.withRetries(async () => {
          const response = await this.http.get('activeSubinventories', {
            params: {
              q: `SecondaryInventoryName=${key}`,
              limit: 1,
              onlyData: true,
              fields: 'OrganizationId,SecondaryInventoryName',
            },
          });
          const data = this.isRecord(response.data) ? response.data : {};
          const items = Array.isArray(data['items']) ? data['items'] : [];
          const first = this.isRecord(items[0]) ? items[0] : null;
          const raw = first?.['OrganizationId'];
          return typeof raw === 'number'
            ? raw
            : raw != null
              ? Number(raw)
              : null;
        }),
    );
    this.subinventoryOrgCache.set(key, orgId);
    return orgId;
  }

  /**
   * Inserts one row into the inventoryStagedTransactions interface. Oracle's
   * transaction manager processes the interface asynchronously (ProcessStatus
   * moves 1→ processed/errored), exactly as the legacy integration relied on.
   *
   * NOTE: this uses inventoryStagedTransactions, not the Java's
   * inventoryTransactions — the latter is deprecated and returns 403 on the
   * current pod.
   */
  async createStagedInventoryTransaction(
    req: StagedInventoryTransaction,
  ): Promise<{ transactionInterfaceId: number | null; raw: unknown }> {
    return this.circuitBreaker.execute(
      'oracle:createStagedInventoryTransaction',
      () =>
        this.withRetries(async () => {
          const body = {
            OrganizationId: req.organizationId,
            ItemNumber: req.itemNumber,
            SubinventoryCode: req.subinventoryCode,
            TransactionQuantity: req.transactionQuantity,
            TransactionUnitOfMeasure: req.transactionUom,
            TransactionDate: req.transactionDate,
            TransactionTypeName: req.transactionTypeName,
            TransactionSourceName: req.transactionSourceName,
            SourceCode: req.sourceCode,
            SourceHeaderId: req.sourceHeaderId,
            SourceLineId: req.sourceLineId,
            TransactionInterfaceId: req.transactionInterfaceId,
            // 3 = process in the background via the transaction manager.
            TransactionMode: 3,
            ProcessStatus: 1,
            UseCurrentCostFlag: 'Y',
          };
          const response = await this.restGate.run(() =>
            this.http.post('inventoryStagedTransactions', body),
          );
          const data = this.isRecord(response.data) ? response.data : {};
          const idRaw = data['TransactionInterfaceId'];
          return {
            transactionInterfaceId:
              typeof idRaw === 'number'
                ? idRaw
                : idRaw != null
                  ? Number(idRaw)
                  : null,
            raw: response.data,
          };
        }),
    );
  }

  /**
   * Reads one row back out of the inventory staging interface.
   *
   * This is the other half of {@link createStagedInventoryTransaction}. That
   * call only queues the row (TransactionMode 3); Oracle's transaction manager
   * decides minutes later whether the issue actually succeeded, and a rejection
   * — insufficient quantity for a subinventory that does not allow negative
   * balances being the common one — is written onto the interface row rather
   * than returned to us. Without this read-back, a rejected issue is
   * indistinguishable from a successful one and the stock silently never moves.
   *
   * Three outcomes, and the caller must treat them differently:
   *   - `found: false`  → Oracle purged the row, which is what it does once the
   *                       transaction is processed. Success, but only after a
   *                       grace period; before that it may simply not be
   *                       visible yet.
   *   - error text set  → definitively rejected; the text is Oracle's reason.
   *   - neither         → still queued, ask again later.
   *
   * Field names differ slightly across pods, so every plausible spelling of the
   * error column is checked rather than trusting one.
   */
  async getStagedInventoryTransaction(transactionInterfaceId: number): Promise<{
    found: boolean;
    processStatus: number | null;
    errorExplanation: string | null;
    raw: unknown;
  }> {
    return this.circuitBreaker.execute(
      'oracle:getStagedInventoryTransaction',
      () =>
        this.withRetries(async () => {
          const response = await this.restGate.run(() =>
            this.http.get('inventoryStagedTransactions', {
              params: {
                q: `TransactionInterfaceId=${transactionInterfaceId}`,
                onlyData: true,
                limit: 1,
              },
            }),
          );
          const data = this.isRecord(response.data) ? response.data : {};
          const items = Array.isArray(data['items']) ? data['items'] : [];
          const row = items.find((i) => this.isRecord(i));
          if (!row || !this.isRecord(row)) {
            return {
              found: false,
              processStatus: null,
              errorExplanation: null,
              raw: response.data,
            };
          }

          const text = (...keys: string[]): string | null => {
            for (const key of keys) {
              const v = row[key];
              if (typeof v === 'string' && v.trim()) return v.trim();
            }
            return null;
          };
          const num = (key: string): number | null => {
            const v = row[key];
            if (typeof v === 'number') return v;
            if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
              return Number(v);
            }
            return null;
          };

          return {
            found: true,
            processStatus: num('ProcessStatus') ?? num('ProcessFlag'),
            errorExplanation: text(
              'ErrorExplanation',
              'ErrorMessage',
              'ErrorCode',
              'TransactionErrorExplanation',
            ),
            raw: row,
          };
        }),
    );
  }

  /**
   * Reads an AR invoice back out of Oracle by its transaction number — the
   * number the SOAP AutoInvoice call returned when we created it.
   *
   * This is what makes reconciliation trustworthy. The FusionInvoiceHeader rows
   * record what we *sent*; only Oracle knows what it *holds* now. An invoice
   * that was completed, credited, adjusted or deleted in Oracle after the push
   * is invisible to the stored audit trail but obvious here.
   *
   * Returns null when Oracle has no such invoice — the resource answers a
   * missing transaction number with HTTP 200 and an empty `items` array, not a
   * 404, so an empty result is a real answer rather than an error.
   */
  async getInvoiceByTransactionNumber(
    transactionNumber: string | number,
  ): Promise<OracleLiveInvoice | null> {
    return this.circuitBreaker.execute(
      'oracle:getInvoiceByTransactionNumber',
      () =>
        this.withRetries(async () => {
          const response = await this.restGate.run(() =>
            this.http.get('receivablesInvoices', {
              params: {
                q: `TransactionNumber=${transactionNumber}`,
                onlyData: true,
                limit: 1,
              },
            }),
          );
          const data = this.isRecord(response.data) ? response.data : {};
          const items = Array.isArray(data['items']) ? data['items'] : [];
          const first = items.find((i) => this.isRecord(i));
          if (!first || !this.isRecord(first)) return null;

          const str = (key: string): string | null =>
            typeof first[key] === 'string' ? first[key] : null;
          const numOrNull = (key: string): number | null => {
            const v = first[key];
            if (typeof v === 'number') return v;
            if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
              return Number(v);
            }
            return null;
          };

          return {
            transactionNumber: str('TransactionNumber'),
            customerTransactionId: numOrNull('CustomerTransactionId'),
            documentNumber: numOrNull('DocumentNumber'),
            status: str('InvoiceStatus'),
            transactionDate: str('TransactionDate'),
            accountingDate: str('AccountingDate'),
            currencyCode: str('InvoiceCurrencyCode'),
            transactionType: str('TransactionType'),
            transactionSource: str('TransactionSource'),
            businessUnit: str('BusinessUnit'),
            billToCustomerName: str('BillToCustomerName'),
            billToCustomerNumber: str('BillToCustomerNumber'),
            // Oracle's own total for the invoice, and how much of it is still
            // outstanding. A zero balance is proof the receipts landed and
            // applied — stronger evidence than matching receipt rows by number.
            enteredAmount: numOrNull('EnteredAmount'),
            balanceAmount: numOrNull('InvoiceBalanceAmount'),
          };
        }),
    );
  }

  /**
   * The invoice's lines as Oracle currently holds them.
   *
   * `totalResults` is requested so the caller gets a truthful line count even
   * when more lines exist than the page returns — silently comparing against a
   * truncated page would invent line mismatches that are not real.
   */
  async getInvoiceLines(
    customerTransactionId: string | number,
    limit = 200,
  ): Promise<{ totalCount: number; lines: OracleLiveInvoiceLine[] }> {
    return this.circuitBreaker.execute('oracle:getInvoiceLines', () =>
      this.withRetries(async () => {
        const response = await this.restGate.run(() =>
          this.http.get(
            `receivablesInvoices/${customerTransactionId}/child/receivablesInvoiceLines`,
            { params: { onlyData: true, totalResults: true, limit } },
          ),
        );
        const data = this.isRecord(response.data) ? response.data : {};
        const items = Array.isArray(data['items']) ? data['items'] : [];
        const totalRaw = data['totalResults'];
        const lines: OracleLiveInvoiceLine[] = items
          .filter((i): i is Record<string, unknown> => this.isRecord(i))
          .map((i) => ({
            lineNumber:
              typeof i['LineNumber'] === 'number' ? i['LineNumber'] : null,
            description:
              typeof i['Description'] === 'string' ? i['Description'] : null,
            itemNumber:
              typeof i['ItemNumber'] === 'string' ? i['ItemNumber'] : null,
            quantity: typeof i['Quantity'] === 'number' ? i['Quantity'] : null,
            unitSellingPrice:
              typeof i['UnitSellingPrice'] === 'number'
                ? i['UnitSellingPrice']
                : null,
            lineAmount:
              typeof i['LineAmount'] === 'number' ? i['LineAmount'] : null,
            taxClassificationCode:
              typeof i['TaxClassificationCode'] === 'string'
                ? i['TaxClassificationCode']
                : null,
            salesOrder:
              typeof i['SalesOrder'] === 'string' ? i['SalesOrder'] : null,
            unitOfMeasure:
              typeof i['UnitOfMeasure'] === 'string'
                ? i['UnitOfMeasure']
                : null,
          }));
        return {
          totalCount: typeof totalRaw === 'number' ? totalRaw : lines.length,
          lines,
        };
      }),
    );
  }

  /**
   * Reads the Revenue account combination Oracle booked on an invoice, used as
   * the template for a credit memo's own revenue distribution. Returns e.g.
   * "01-4011001-00-0177-01-01-00" where segment 4 is the store cost centre.
   */
  async getInvoiceRevenueAccount(
    customerTransactionId: string | number,
  ): Promise<string | null> {
    return this.circuitBreaker.execute('oracle:getInvoiceRevenueAccount', () =>
      this.withRetries(async () => {
        const response = await this.http.get(
          `receivablesInvoices/${customerTransactionId}/child/receivablesInvoiceDistributions`,
          { params: { onlyData: true, limit: 20 } },
        );
        const data = this.isRecord(response.data) ? response.data : {};
        const items = Array.isArray(data['items']) ? data['items'] : [];
        const revenue = items.find(
          (i) => this.isRecord(i) && i['AccountClass'] === 'Revenue',
        );
        const combo =
          revenue && this.isRecord(revenue)
            ? revenue['AccountCombination']
            : null;
        return typeof combo === 'string' ? combo : null;
      }),
    );
  }

  /**
   * Creates an AR credit memo through the receivablesCreditMemos REST resource.
   *
   * This is the path that actually works on the current pod: the SOAP
   * AutoInvoice service rejects credit memos because no Credit-Memo transaction
   * type exists on an imported batch source, but the REST resource creates them
   * directly with the `Manual` source (the same channel the Fusion UI uses). An
   * explicit Revenue distribution is supplied per line; Oracle derives the
   * receivable and tax accounts. Returns the Oracle-assigned memo number.
   */
  async createCreditMemoViaRest(payload: {
    businessUnit: string;
    billToCustomerNumber: string;
    currency: string;
    transactionDate: string;
    transactionType: string;
    reasonCode?: string;
    lines: Array<{
      lineNumber: number;
      description: string;
      quantityCredit: number;
      unitSellingPrice: number;
      itemNumber?: string;
      revenueAccount: string;
      amount: number;
    }>;
  }): Promise<{ transactionNumber: string; customerTransactionId: string }> {
    return this.circuitBreaker.execute('oracle:createCreditMemoRest', () =>
      this.withRetries(async () => {
        const body = {
          BusinessUnit: payload.businessUnit,
          // 'Manual' is the only credit-memo source the pod accepts via REST.
          TransactionSource: 'Manual',
          TransactionType: payload.transactionType,
          BillToCustomerNumber: payload.billToCustomerNumber,
          CreditMemoCurrency: payload.currency,
          TransactionDate: payload.transactionDate,
          // CreditReason must be a value from Oracle's credit-memo reason
          // lookup, not free text — an arbitrary string is rejected. Only send
          // it when the caller passes a code known to be valid; the free-text
          // refund reason goes on the line description instead.
          ...(payload.reasonCode ? { CreditReason: payload.reasonCode } : {}),
          receivablesCreditMemoLines: payload.lines.map((l) => ({
            LineNumber: l.lineNumber,
            LineDescription: l.description,
            LineQuantityCredit: l.quantityCredit,
            UnitSellingPrice: l.unitSellingPrice,
            ...(l.itemNumber ? { ItemNumber: l.itemNumber } : {}),
          })),
          receivablesCreditMemoDistributions: payload.lines.map((l) => ({
            CreditMemoLineNumber: l.lineNumber,
            AccountClass: 'Revenue',
            AccountCombination: l.revenueAccount,
            Amount: l.amount,
          })),
        };
        let response;
        try {
          response = await this.http.post('receivablesCreditMemos', body);
        } catch (err) {
          // Oracle returns the real reason in the 400 body; the default axios
          // message ("status code 400") hides it. Surface it so failures on the
          // Refunds page are actionable.
          const axiosErr = err as {
            response?: { status?: number; data?: unknown };
          };
          const oracleMsg =
            typeof axiosErr.response?.data === 'string'
              ? axiosErr.response.data
              : JSON.stringify(axiosErr.response?.data ?? {});
          throw new Error(
            `Oracle credit-memo REST create failed (HTTP ${axiosErr.response?.status ?? '?'}): ${oracleMsg.slice(0, 500)}`,
          );
        }
        const data = this.isRecord(response.data) ? response.data : {};
        const scalar = (v: unknown): string =>
          typeof v === 'string' || typeof v === 'number' ? String(v) : '';
        return {
          transactionNumber: scalar(data['TransactionNumber']),
          customerTransactionId: scalar(data['CustomerTransactionId']),
        };
      }),
    );
  }

  async createCreditMemo(
    data: OracleCreditMemoData,
  ): Promise<OracleCreditMemoResult> {
    return this.circuitBreaker.execute('oracle:createCreditMemo', () =>
      this.withRetries(async () => {
        const response = await this.http.post('/receivables/creditMemos', data);
        return this.extractObject<OracleCreditMemoResult>(response.data);
      }),
    );
  }

  async getInvoice(invoiceNumber: string): Promise<OracleInvoiceResult> {
    return this.circuitBreaker.execute('oracle:getInvoice', () =>
      this.withRetries(async () => {
        const response = await this.http.get(
          `/receivables/invoices/${invoiceNumber}`,
        );
        return this.extractObject<OracleInvoiceResult>(response.data);
      }),
    );
  }

  /**
   * Fetches inventory items from Oracle Fusion SCM.
   * Equivalent to Java FusionItemsToVendHQItemsIntegration / FusionItemsService.getFusionItems().
   * GET /fscmRestApi/resources/11.13.17.11/items
   */
  async getInventoryItems(params: {
    organizationCode?: string;
    /** Watermark — only items updated after this date are returned (mirrors Java lastRequestedDate). */
    lastUpdateDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<OracleInventoryItem[]> {
    return this.circuitBreaker.execute('oracle:getInventoryItems', () =>
      this.withRetries(async () => {
        // Build the semicolon-delimited "q" filter — mirrors Java FusionItemsService
        const qParts: string[] = [];
        if (params.lastUpdateDate) {
          // Oracle expects 'YYYY-MM-DD HH:mm:ss' (same format used by Java SimpleDateFormat)
          const oracleDate = this.formatOracleDate(params.lastUpdateDate);
          qParts.push(`LastUpdateDate>${oracleDate}`);
        }
        qParts.push('UserItemTypeValue=Finished Good');
        if (params.organizationCode)
          qParts.push(`OrganizationCode=${params.organizationCode}`);

        const query: Record<string, string | number> = {
          limit: params.limit ?? 500,
          offset: params.offset ?? 0,
          orderBy: 'LastUpdateDate',
          q: qParts.join(';'),
          fields: [
            'ItemId',
            'ItemClass',
            'OrganizationId',
            'OrganizationCode',
            'ItemNumber',
            'ItemDescription',
            'MarketPrice',
            'PrimaryUOMCode',
            'PrimaryUOMValue',
            'UserItemTypeValue',
            'InventoryItemStatusCode',
            'LongDescription',
            'OutputTaxClassificationCodeValue',
            'LastUpdateDate',
            'CreationDate',
          ].join(','),
        };

        // Relative path — ORACLE_REST_BASE_URL already ends in
        // /fscmRestApi/resources/<version>. An absolute path double-prefixes
        // it and 404s (which broke item sync entirely).
        const response = await this.http.get('items', { params: query });
        const data = this.isRecord(response.data) ? response.data : {};
        const items = Array.isArray(data['items'])
          ? (data['items'] as OracleInventoryItem[])
          : [];
        return items;
      }),
    );
  }

  /**
   * In-memory cache for {@link itemExists} lookups. Keyed by ItemNumber.
   * Cleared on process restart (which also happens on credential changes),
   * so a newly-created Oracle item is picked up after the next restart.
   */
  private readonly itemExistsCache = new Map<string, boolean>();

  /**
   * Returns true when an item with the given ItemNumber exists in Oracle's
   * item catalog. Used to pre-validate invoice lines: Oracle rejects the whole
   * AR invoice with AR_INVALID_INVENTORY_ITEM if any line references an item it
   * doesn't know, so callers skip/hold orders that contain unknown items.
   *
   * A single-item lookup (`q=ItemNumber=<n>`) is used deliberately — Oracle's
   * `items` resource rejects an unfiltered list with EGP-2776154, but accepts a
   * query filtered on ItemNumber. Results are cached to avoid repeat lookups of
   * the same SKU across an order batch.
   */
  async itemExists(
    itemNumber: string,
    organizationId?: number | null,
  ): Promise<boolean> {
    const item = (itemNumber ?? '').trim();
    if (!item) return false;

    // Scope to an inventory organization when one is known: an item can exist
    // in the master org yet not be assigned to the region's org, in which case
    // AR still rejects the invoice (AR_INVALID_INVENTORY_ITEM / AR-856749).
    const key = organizationId != null ? `${item}@${organizationId}` : item;
    const cached = this.itemExistsCache.get(key);
    if (cached !== undefined) return cached;

    const exists = await this.circuitBreaker.execute('oracle:itemExists', () =>
      this.withRetries(async () => {
        const q =
          organizationId != null
            ? `ItemNumber=${item};OrganizationId=${organizationId}`
            : `ItemNumber=${item}`;
        const response = await this.http.get('items', {
          params: {
            q,
            limit: 1,
            onlyData: true,
            fields: 'ItemNumber',
          },
        });
        const data = this.isRecord(response.data) ? response.data : {};
        const items = Array.isArray(data['items']) ? data['items'] : [];
        return items.length > 0;
      }),
    );

    this.itemExistsCache.set(key, exists);
    return exists;
  }

  private readonly itemIdCache = new Map<string, string | null>();

  /**
   * Oracle's numeric InventoryItemId for an item number.
   *
   * CreditMemoService identifies a line's item by id, while everything upstream
   * (Odoo, VendHQ, our own tables) only knows the item number. Returns null
   * when Oracle has no such item — the caller then sends a description-only
   * line rather than failing the whole memo, matching how the REST path already
   * handles unknown items. Cached per item number, including the misses.
   */
  async resolveItemId(itemNumber: string): Promise<string | null> {
    const item = (itemNumber ?? '').trim();
    if (!item) return null;

    const cached = this.itemIdCache.get(item);
    if (cached !== undefined) return cached;

    const id = await this.circuitBreaker.execute('oracle:resolveItemId', () =>
      this.withRetries(async () => {
        const response = await this.http.get('items', {
          params: {
            q: `ItemNumber=${item}`,
            limit: 1,
            onlyData: true,
            fields: 'ItemId',
          },
        });
        const data = this.isRecord(response.data) ? response.data : {};
        const items = Array.isArray(data['items']) ? data['items'] : [];
        const first = items.find((i) => this.isRecord(i));
        if (!first || !this.isRecord(first)) return null;
        const raw = first['ItemId'];
        return typeof raw === 'number' || typeof raw === 'string'
          ? String(raw)
          : null;
      }),
    );

    this.itemIdCache.set(item, id);
    return id;
  }

  /**
   * Reads a credit memo back out of Oracle by its transaction number.
   *
   * This is what makes "did the memo actually land?" answerable. Our own
   * RefundTracking row records what we *sent*; only Oracle knows what it
   * *holds*. A non-zero balance means the memo exists but is still sitting
   * on-account — i.e. created but not applied.
   *
   * Returns null when Oracle has no such memo: the resource answers an unknown
   * transaction number with HTTP 200 and an empty items array, so an empty
   * result is a real answer rather than an error.
   */
  async getCreditMemoByTransactionNumber(
    transactionNumber: string | number,
  ): Promise<OracleLiveCreditMemo | null> {
    return this.circuitBreaker.execute(
      'oracle:getCreditMemoByTransactionNumber',
      () =>
        this.withRetries(async () => {
          const response = await this.restGate.run(() =>
            this.http.get('receivablesCreditMemos', {
              params: {
                q: `TransactionNumber=${transactionNumber}`,
                onlyData: true,
                limit: 1,
              },
            }),
          );
          const data = this.isRecord(response.data) ? response.data : {};
          const items = Array.isArray(data['items']) ? data['items'] : [];
          const first = items.find((i) => this.isRecord(i));
          if (!first || !this.isRecord(first)) return null;

          const str = (key: string): string | null =>
            typeof first[key] === 'string' ? first[key] : null;
          const numOrNull = (key: string): number | null => {
            const v = first[key];
            if (typeof v === 'number') return v;
            if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
              return Number(v);
            }
            return null;
          };

          return {
            transactionNumber: str('TransactionNumber'),
            customerTransactionId: numOrNull('CustomerTransactionId'),
            status: str('CreditMemoStatus') ?? str('Status'),
            transactionDate: str('TransactionDate'),
            currencyCode: str('CreditMemoCurrency') ?? str('Currency'),
            transactionType: str('TransactionType'),
            businessUnit: str('BusinessUnit'),
            billToCustomerName: str('BillToCustomerName'),
            billToCustomerNumber: str('BillToCustomerNumber'),
            enteredAmount: numOrNull('EnteredAmount') ?? numOrNull('Amount'),
            balanceAmount:
              numOrNull('CreditMemoBalanceAmount') ??
              numOrNull('BalanceAmount'),
          };
        }),
    );
  }

  /**
   * Fetches AR-usable cash/bank accounts from Oracle Fusion Cash Management.
   * Used by the admin "refresh register accounts" utility to repopulate
   * VendHqRegister.bankAccountId / cashAccountId with the current Oracle IDs
   * (the remittance account passed on every receipt).
   *
   * NOTE: relative resource path — ORACLE_REST_BASE_URL already ends in
   * /fscmRestApi/resources/<version>. (Some older methods pass an absolute
   * /fscmRestApi/... path which double-prefixes; keep this relative.)
   */
  async getCashBankAccounts(
    params: { limit?: number; offset?: number } = {},
  ): Promise<OracleCashBankAccount[]> {
    return this.circuitBreaker.execute('oracle:getCashBankAccounts', () =>
      this.withRetries(async () => {
        const query: Record<string, string | number | boolean> = {
          limit: params.limit ?? 500,
          offset: params.offset ?? 0,
          onlyData: true,
          q: 'ArUseAllowedFlag=true',
          fields:
            'BankAccountId,BankAccountName,BankName,CurrencyCode,ArUseAllowedFlag',
        };
        const response = await this.http.get('cashBankAccounts', {
          params: query,
        });
        const data = this.isRecord(response.data) ? response.data : {};
        return Array.isArray(data['items'])
          ? (data['items'] as OracleCashBankAccount[])
          : [];
      }),
    );
  }

  /**
   * Fetches on-hand inventory quantities from Oracle Fusion.
   * Equivalent to Java FusionOnHandQtyFetch + FusionInvToVendHQInvIntegration.
   * GET /fscmRestApi/resources/11.13.18.05/inventoryOnhandQuantities
   */
  async getInventoryOnHand(params: {
    organizationCode?: string;
    itemNumber?: string;
    subinventoryCode?: string;
    limit?: number;
    offset?: number;
  }): Promise<OracleOnHandQuantity[]> {
    return this.circuitBreaker.execute('oracle:getInventoryOnHand', () =>
      this.withRetries(async () => {
        const queryParts: string[] = [];
        if (params.organizationCode)
          queryParts.push(`OrganizationCode=${params.organizationCode}`);
        if (params.itemNumber)
          queryParts.push(`ItemNumber=${params.itemNumber}`);
        if (params.subinventoryCode)
          queryParts.push(`SubinventoryCode=${params.subinventoryCode}`);

        const query: Record<string, string | number> = {
          limit: params.limit ?? 500,
          offset: params.offset ?? 0,
        };
        if (queryParts.length > 0) query['q'] = queryParts.join(';');

        // Relative path — see getInventoryItems note (absolute paths 404).
        const response = await this.http.get('inventoryOnhandQuantities', {
          params: query,
        });
        const data = this.isRecord(response.data) ? response.data : {};
        const items = Array.isArray(data['items'])
          ? (data['items'] as OracleOnHandQuantity[])
          : [];
        return items;
      }),
    );
  }

  /**
   * Formats a Date to the 'YYYY-MM-DD HH:mm:ss' string expected by Oracle REST API
   * query parameters (same format as Java SimpleDateFormat("YYYY-MM-dd HH:mm:ss")).
   */
  private formatOracleDate(date: Date): string {
    return date.toISOString().replace('T', ' ').substring(0, 19);
  }

  private async withRetries<T>(
    operation: () => Promise<T>,
    attempt = 1,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= 3) {
        this.logger.error('Oracle request failed after retries');
        throw error;
      }

      await this.delay(200 * 2 ** (attempt - 1));
      return this.withRetries(operation, attempt + 1);
    }
  }

  private extractObject<T>(payload: unknown): T {
    if (this.isRecord(payload)) {
      return payload as T;
    }

    throw new ServiceUnavailableException('Unexpected Oracle response payload');
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private async delay(ms: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
