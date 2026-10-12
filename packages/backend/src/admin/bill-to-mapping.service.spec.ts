import { Repository } from 'typeorm';
import { BillToMappingService } from './bill-to-mapping.service';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';

const meta = (o: Partial<FusionSalesMetadata>) =>
  ({
    id: 'm',
    billToName: 'KHURAISSQ',
    billToAccount: 83012n,
    siteNumber: '68003',
    businessUnit: 'AlQurashi-KSA',
    txnSource: 'Vend',
    txnType: 'Vend Invoice',
    subinventory: 'KHURAISSQ',
    region: 'SA',
    customerType: 'NORMAL',
    costCenterCode: '0120',
    ...o,
  }) as FusionSalesMetadata;

describe('BillToMappingService', () => {
  const template = meta({ id: 't1' });
  const tabby = meta({ id: 't2', customerType: 'TABBY', billToName: 'Tabby', siteNumber: '68009' });
  const store = {
    id: 's1',
    branchCode: '1191',
    branchName: 'RYDROSHN',
    region: 'SN',
    isActive: true,
  } as StoreConfiguration;

  let rows: FusionSalesMetadata[];
  let salesMeta: Record<string, jest.Mock>;
  let service: BillToMappingService;

  beforeEach(() => {
    rows = [template, tabby];
    salesMeta = {
      find: jest.fn(async (opts?: { where?: Partial<FusionSalesMetadata> }) =>
        rows.filter((r) =>
          Object.entries(opts?.where ?? {}).every(
            ([k, v]) => r[k as keyof FusionSalesMetadata] === v,
          ),
        ),
      ),
      findOne: jest.fn(async ({ where }: { where: Partial<FusionSalesMetadata> }) =>
        rows.find((r) =>
          Object.entries(where).every(
            ([k, v]) => r[k as keyof FusionSalesMetadata] === v,
          ),
        ) ?? null,
      ),
      create: jest.fn((x: FusionSalesMetadata) => x),
      save: jest.fn(async (x: FusionSalesMetadata) => {
        rows.push({ ...x, id: `new${rows.length}` } as FusionSalesMetadata);
        return x;
      }),
      update: jest.fn(),
    };
    const stores = {
      find: jest.fn(async () => [store]),
      findOne: jest.fn(async () => store),
    };
    service = new BillToMappingService(
      stores as unknown as Repository<StoreConfiguration>,
      salesMeta as unknown as Repository<FusionSalesMetadata>,
      { find: jest.fn(async () => []) } as unknown as Repository<FusionBusinessUnitMap>,
    );
  });

  it('reports a store with no Subinventory row as MISSING', async () => {
    const s = await service.status();
    expect(s.stores[0]).toMatchObject({ branchName: 'RYDROSHN', status: 'MISSING' });
    expect(s.templates.map((t) => t.id)).toEqual(['t1']);
  });

  it('copies the template onto Subinventory = store name with its account and site', async () => {
    const r = await service.apply({ stores: [{ storeId: 's1', templateId: 't1' }] });
    expect(r).toEqual({ created: 1, updated: 0, providerRowsCopied: 1 });
    const normal = rows.find((x) => x.region === 'SN' && x.customerType === 'NORMAL');
    expect(normal).toMatchObject({
      subinventory: 'RYDROSHN',
      billToAccount: 83012n,
      siteNumber: '68003',
      costCenterCode: '0120',
    });
    expect(rows.find((x) => x.region === 'SN' && x.customerType === 'TABBY'))
      .toMatchObject({ subinventory: 'RYDROSHN', siteNumber: '68009' });

    const s = await service.status();
    expect(s.stores[0]).toMatchObject({ status: 'MAPPED', via: 'SUBINVENTORY' });
  });

  it('never overwrites a delivery-platform row the store already has', async () => {
    rows.push(meta({ id: 'own', region: 'SN', subinventory: 'RYDROSHN', customerType: 'TABBY', siteNumber: 'KEEP' }));
    const r = await service.apply({ stores: [{ storeId: 's1', templateId: 't1' }] });
    expect(r.providerRowsCopied).toBe(0);
    expect(salesMeta.update).not.toHaveBeenCalled();
  });

  it("sets a region default with Subinventory '*' that unmapped stores resolve to", async () => {
    await service.apply({
      regionDefaults: [{ region: 'SN', templateId: 't1' }],
      includeProviders: false,
    });
    const s = await service.status();
    expect(s.stores[0]).toMatchObject({ status: 'REGION_DEFAULT' });
    expect(s.regions.find((r) => r.region === 'SN')?.regionDefault?.subinventory).toBe('*');
  });

  it('rejects a non-NORMAL template', async () => {
    await expect(
      service.apply({ stores: [{ storeId: 's1', templateId: 't2' }] }),
    ).rejects.toThrow('not a NORMAL bill-to row');
  });
});
