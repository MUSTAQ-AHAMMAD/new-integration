/**
 * ReadinessService — a single go/no-go preflight for a region before it is
 * turned live for daily invoicing.
 *
 * It checks the four things that actually stop a region from invoicing:
 *   1. Reference data is loaded (sales metadata, receipt methods, BU map,
 *      registers, customer accounts).
 *   2. Store configurations exist, are active, and validate.
 *   3. Oracle Fusion is reachable (SOAP + REST auth).
 *   4. Outlet gating is coherent (how many AUTOMATIC / MANUAL / NONE).
 *
 * Every failure is reported as a specific, actionable blocker or warning rather
 * than a bare boolean, so an operator knows exactly what to fix.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FusionBusinessUnitMap } from '../database/entities/fusion-business-unit-map.entity';
import { FusionCustomerAccount } from '../database/entities/fusion-customer-account.entity';
import { FusionReceiptMethod } from '../database/entities/fusion-receipt-method.entity';
import { FusionSalesMetadata } from '../database/entities/fusion-sales-metadata.entity';
import { OutletIntegrationConfig } from '../database/entities/outlet-integration-config.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { VendHqRegister } from '../database/entities/vend-hq-register.entity';
import { OracleSoapClient } from '../clients/oracle/oracle-soap.client';
import { OracleClient } from '../clients/oracle/oracle.client';

export interface ReadinessCheck {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
}

export interface ReadinessReport {
  region: string;
  ready: boolean;
  blockers: number;
  warnings: number;
  checks: ReadinessCheck[];
}

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(
    @InjectRepository(FusionSalesMetadata)
    private readonly salesMeta: Repository<FusionSalesMetadata>,
    @InjectRepository(FusionReceiptMethod)
    private readonly receiptMethods: Repository<FusionReceiptMethod>,
    @InjectRepository(FusionBusinessUnitMap)
    private readonly buMap: Repository<FusionBusinessUnitMap>,
    @InjectRepository(VendHqRegister)
    private readonly registers: Repository<VendHqRegister>,
    @InjectRepository(FusionCustomerAccount)
    private readonly customerAccounts: Repository<FusionCustomerAccount>,
    @InjectRepository(StoreConfiguration)
    private readonly stores: Repository<StoreConfiguration>,
    @InjectRepository(OutletIntegrationConfig)
    private readonly outlets: Repository<OutletIntegrationConfig>,
    private readonly soap: OracleSoapClient,
    private readonly rest: OracleClient,
  ) {}

  async checkRegion(region: string): Promise<ReadinessReport> {
    const checks: ReadinessCheck[] = [];

    // 1. Reference data --------------------------------------------------------
    const [meta, methods, bu, regs, custAccts] = await Promise.all([
      this.salesMeta.count({ where: { region } }),
      this.receiptMethods.count({ where: { region } }),
      this.buMap.count({ where: { region } }),
      this.registers.count({ where: { region } }),
      this.customerAccounts.count({ where: { region } }),
    ]);

    checks.push(
      this.threshold('Sales metadata', meta, 1, `${meta} rows for ${region}`),
    );
    checks.push(
      this.threshold('Receipt methods', methods, 1, `${methods} rows`),
    );
    checks.push(
      this.threshold(
        'Business-unit map',
        bu,
        1,
        bu ? `${bu} row(s)` : 'no FusionBusinessUnitMap — invoices post to org 0 (rejected)',
      ),
    );
    checks.push(
      this.threshold(
        'Registers (bank/cash accounts)',
        regs,
        1,
        regs ? `${regs} register(s)` : 'no VendHqRegister — receipts cannot resolve accounts',
      ),
    );
    checks.push(
      this.threshold(
        'Customer accounts',
        custAccts,
        1,
        custAccts
          ? `${custAccts} account(s)`
          : 'no FusionCustomerAccount — receipts post Unidentified and fail to apply',
      ),
    );

    // 2. Store configuration ---------------------------------------------------
    const activeStores = await this.stores.count({
      where: { region, isActive: true },
    });
    const invalidStores = await this.stores.count({
      where: { region, isActive: true, validationStatus: 'INVALID' as never },
    });
    const partialStores = await this.stores.count({
      where: { region, isActive: true, validationStatus: 'PARTIAL' as never },
    });
    if (activeStores === 0) {
      checks.push({
        name: 'Active stores',
        status: 'FAIL',
        detail:
          `No active StoreConfiguration for ${region}. Run POST /store-config/seed-region ` +
          `{"region":"${region}"} then review.`,
      });
    } else {
      checks.push({
        name: 'Active stores',
        status: invalidStores > 0 ? 'FAIL' : partialStores > 0 ? 'WARN' : 'PASS',
        detail:
          `${activeStores} active; ${invalidStores} INVALID, ${partialStores} need review`,
      });
    }

    // 3. Oracle reachability ---------------------------------------------------
    checks.push(await this.checkSoap());
    checks.push(await this.checkRest());

    // 4. Outlet gating ---------------------------------------------------------
    const outletRows = await this.outlets.find({
      where: { region },
      select: { integMode: true },
    });
    const modeCounts = outletRows.reduce<Record<string, number>>((acc, o) => {
      const m = (o.integMode ?? 'UNSET').toUpperCase();
      acc[m] = (acc[m] ?? 0) + 1;
      return acc;
    }, {});
    checks.push({
      name: 'Outlet gating',
      status: outletRows.length ? 'PASS' : 'WARN',
      detail: outletRows.length
        ? `AUTOMATIC ${modeCounts.AUTOMATIC ?? 0}, MANUAL ${modeCounts.MANUAL ?? 0}, NONE ${modeCounts.NONE ?? 0}`
        : `no OutletIntegrationConfig for ${region} — every outlet defaults to AUTOMATIC`,
    });

    const blockers = checks.filter((c) => c.status === 'FAIL').length;
    const warnings = checks.filter((c) => c.status === 'WARN').length;
    const report: ReadinessReport = {
      region,
      ready: blockers === 0,
      blockers,
      warnings,
      checks,
    };
    this.logger.log(
      `[${region}] readiness: ${report.ready ? 'READY' : 'BLOCKED'} ` +
        `(${blockers} blocker(s), ${warnings} warning(s))`,
    );
    return report;
  }

  private threshold(
    name: string,
    count: number,
    min: number,
    detail: string,
  ): ReadinessCheck {
    return { name, status: count >= min ? 'PASS' : 'FAIL', detail };
  }

  private async checkSoap(): Promise<ReadinessCheck> {
    try {
      await this.soap.ping();
      return { name: 'Oracle SOAP', status: 'PASS', detail: 'reachable' };
    } catch (err) {
      return {
        name: 'Oracle SOAP',
        status: 'FAIL',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkRest(): Promise<ReadinessCheck> {
    try {
      // A known item existence check exercises REST auth + the items resource.
      await this.rest.itemExists('__readiness_probe__');
      return { name: 'Oracle REST', status: 'PASS', detail: 'reachable' };
    } catch (err) {
      return {
        name: 'Oracle REST',
        status: 'WARN',
        detail:
          `items probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
