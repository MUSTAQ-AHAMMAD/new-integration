import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { StoreConfigService } from './store-config.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('store-config')
@Controller('store-config')
export class StoreConfigController {
  constructor(
    private readonly service: StoreConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List store configurations' })
  list(@Query('activeOnly') activeOnly?: string) {
    return this.service.listStores(activeOnly === 'true');
  }

  @Get('export')
  @ApiOperation({ summary: 'Export store configurations as CSV' })
  async exportCsv(@Res() res: Response) {
    const rows = await this.prisma.storeConfiguration.findMany({
      orderBy: { branchCode: 'asc' },
    });
    const escape = (v: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replaceAll('"', '""')}"`
        : s;
    };
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    const csv = [
      headers.map(escape).join(','),
      ...rows.map((r) =>
        headers.map((h) => escape((r as Record<string, unknown>)[h])).join(','),
      ),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="store-configurations.csv"',
    );
    res.send(csv);
  }

  @Get(':branchCode')
  @ApiOperation({
    summary: 'Get store configuration by branch code (raw, no validation gate)',
  })
  get(@Param('branchCode') branchCode: string) {
    return this.service.getRawConfig(branchCode);
  }

  @Post()
  @ApiOperation({ summary: 'Create store configuration' })
  create(@Body() body: Parameters<StoreConfigService['upsertStore']>[0]) {
    return this.service.upsertStore(body);
  }

  @Put(':branchCode')
  @ApiOperation({ summary: 'Update store configuration' })
  update(
    @Param('branchCode') branchCode: string,
    @Body() body: Partial<Parameters<StoreConfigService['upsertStore']>[0]>,
  ) {
    return this.service.upsertStore({ branchCode, ...body } as Parameters<
      StoreConfigService['upsertStore']
    >[0]);
  }

  @Delete(':branchCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete store configuration' })
  remove(@Param('branchCode') branchCode: string) {
    return this.service.deleteStore(branchCode);
  }

  @Post(':branchCode/validate')
  @ApiOperation({ summary: 'Validate store configuration' })
  validate(@Param('branchCode') branchCode: string) {
    return this.service.validateConfig(branchCode);
  }

  @Post('populate/all-branches')
  @ApiOperation({
    summary:
      'Populate StoreConfiguration for all branches (Option B) - creates configs for all branches found in backup tables',
  })
  async populateAllBranches() {
    return this.service.populateAllBranches();
  }

  @Post('populate/bank-cash-accounts')
  @ApiOperation({
    summary:
      'Populate missing bank/cash account IDs for all store configurations using VendHqRegister data by region',
  })
  async populateBankCashAccounts() {
    return this.service.populateBankCashAccountIds();
  }

  @Get('health/check')
  @ApiOperation({
    summary: 'Health check - verify store configurations for all branches',
  })
  async checkStoreConfigs() {
    // Get all unique branches from backup tables
    const odooBranches = await this.prisma.$queryRaw<
      Array<{ branchId: number; branchName: string | null }>
    >`
      SELECT DISTINCT "branchId"::int as "branchId", MAX("branchName") as "branchName"
      FROM "BackupOdooOrder"
      WHERE "branchId" IS NOT NULL
      GROUP BY "branchId"
      ORDER BY "branchId"
    `;

    const ibqBranches = await this.prisma.$queryRaw<
      Array<{ branchId: number; branchName: string | null }>
    >`
      SELECT DISTINCT "branchId"::int as "branchId", MAX("branchName") as "branchName"
      FROM "BackupIbqOrder"
      WHERE "branchId" IS NOT NULL
      GROUP BY "branchId"
      ORDER BY "branchId"
    `;

    // Merge and deduplicate
    const branchMap = new Map<
      number,
      { branchId: number; branchName: string | null }
    >();
    for (const branch of [...odooBranches, ...ibqBranches]) {
      if (!branchMap.has(branch.branchId)) {
        branchMap.set(branch.branchId, branch);
      }
    }

    const allBranches = Array.from(branchMap.values()).sort(
      (a, b) => a.branchId - b.branchId,
    );

    const results = [];
    for (const branch of allBranches) {
      const branchCode = String(branch.branchId);

      try {
        const config = await this.service.getOrCreateStoreConfig(branchCode);
        results.push({
          branchId: branch.branchId,
          branchCode,
          storeName: branch.branchName,
          hasConfig: true,
          configStatus: config.validationStatus,
          isActive: config.isActive,
          hasBankAccountId: config.bankAccountId !== null,
          hasCashAccountId: config.cashAccountId !== null,
          config: {
            branchName: config.branchName,
            region: config.region,
            taxRate: config.taxClassificationCode,
            currency: config.invoiceCurrencyCode,
            paymentTerms: config.paymentTermsName,
            businessUnit: config.oracleBusinessUnit,
            bankAccount: config.bankAccountName,
            cashAccount: config.cashAccountName,
            bankAccountId: config.bankAccountId,
            cashAccountId: config.cashAccountId,
          },
        });
      } catch (error) {
        results.push({
          branchId: branch.branchId,
          branchCode,
          storeName: branch.branchName,
          hasConfig: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const summary = {
      totalBranches: allBranches.length,
      configsFound: results.filter((r) => r.hasConfig).length,
      configsMissing: results.filter((r) => !r.hasConfig).length,
      configsValid: results.filter(
        (r) => r.hasConfig && r.configStatus === 'VALIDATED',
      ).length,
      configsPartial: results.filter(
        (r) => r.hasConfig && r.configStatus === 'PARTIAL',
      ).length,
      configsInvalid: results.filter(
        (r) => r.hasConfig && r.configStatus === 'INVALID',
      ).length,
      configsPending: results.filter(
        (r) => r.hasConfig && r.configStatus === 'PENDING',
      ).length,
      missingBankAccountId: results.filter(
        (r) => r.hasConfig && !r.hasBankAccountId,
      ).length,
      missingCashAccountId: results.filter(
        (r) => r.hasConfig && !r.hasCashAccountId,
      ).length,
      missingBothAccountIds: results.filter(
        (r) => r.hasConfig && !r.hasBankAccountId && !r.hasCashAccountId,
      ).length,
    };

    return {
      summary,
      branches: results,
    };
  }

  @Post('clear-cache')
  @ApiOperation({ summary: 'Clear store configuration cache' })
  clearCache(@Query('branchCode') branchCode?: string) {
    this.service.clearCache(branchCode);
    return {
      message: branchCode
        ? `Cache cleared for branch ${branchCode}`
        : 'Cache cleared for all branches',
    };
  }
}
