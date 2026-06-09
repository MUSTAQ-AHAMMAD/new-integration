import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

// Map of route slug → Prisma delegate name
const TABLE_MAP: Record<string, keyof PrismaService> = {
  'fusion-credentials': 'fusionCredential',
  'vendhq-credentials': 'vendHqCredential',
  'outlet-config': 'outletIntegrationConfig',
  'fusion-bu-map': 'fusionBusinessUnitMap',
  'fusion-receipt-methods': 'fusionReceiptMethod',
  'fusion-sales-metadata': 'fusionSalesMetadata',
  'service-provider-journal-meta': 'serviceProviderJournalMeta',
  'sales-integration-status': 'salesIntegrationStatus',
  'vendhq-discount-items': 'vendHqDiscountItem',
  'vendhq-tax-meta': 'vendHqTaxMeta',
  'vendhq-outlets': 'vendHqOutlet',
  'vendhq-registers': 'vendHqRegister',
  'vendhq-service-providers': 'vendHqServiceProvider',
  'vendhq-item-meta': 'vendHqItemMeta',
  'fusion-invoice-headers': 'fusionInvoiceHeader',
  'fusion-invoice-lines': 'fusionInvoiceLine',
  'fusion-standard-receipts': 'fusionStandardReceipt',
  'fusion-misc-receipts': 'fusionMiscReceipt',
  'fusion-apply-receipts': 'fusionApplyReceipt',
  'fusion-journal-headers': 'fusionJournalHeader',
  'fusion-journal-lines': 'fusionJournalLine',
  'fusion-inv-txns': 'fusionInvTxn',
  'backup-sales': 'backupVendHqSale',
  'backup-line-items': 'backupVendHqLineItem',
  'backup-payments': 'backupVendHqPayment',
  'backup-promotions': 'backupVendHqPromotion',
};

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  getDelegate(table: string): any {
    const delegateName = TABLE_MAP[table];
    if (!delegateName) throw new BadRequestException(`Unknown table: ${table}`);
    return (this.prisma as any)[delegateName];
  }

  async list(
    table: string,
    options: { skip?: number; take?: number; region?: string },
  ) {
    const delegate = this.getDelegate(table);
    const where = options.region ? { region: options.region } : {};
    const [data, total] = await Promise.all([
      delegate.findMany({
        where,
        skip: options.skip ?? 0,
        take: options.take ?? 50,
        orderBy: { createdAt: 'desc' },
      }),
      delegate.count({ where }),
    ]);
    return { data, total, skip: options.skip ?? 0, take: options.take ?? 50 };
  }

  async getOne(table: string, id: string) {
    const delegate = this.getDelegate(table);
    const record = await delegate.findUnique({ where: { id } });
    if (!record)
      throw new NotFoundException(`Record ${id} not found in ${table}`);
    return record;
  }

  async create(table: string, body: Record<string, unknown>) {
    const delegate = this.getDelegate(table);
    // Strip id if provided so default cuid() is used
    const { id: _id, createdAt: _ca, updatedAt: _ua, ...data } = body as any;
    return delegate.create({ data });
  }

  async update(table: string, id: string, body: Record<string, unknown>) {
    await this.getOne(table, id);
    const delegate = this.getDelegate(table);
    const { id: _id, createdAt: _ca, ...data } = body as any;
    return delegate.update({ where: { id }, data });
  }

  async remove(table: string, id: string) {
    await this.getOne(table, id);
    const delegate = this.getDelegate(table);
    await delegate.delete({ where: { id } });
  }

  /** Returns the list of available admin tables with metadata */
  static tables() {
    return Object.keys(TABLE_MAP).map((slug) => ({
      slug,
      model: TABLE_MAP[slug],
    }));
  }
}
