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
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository } from 'typeorm';
import { Response } from 'express';
import { StoreConfigSeederService } from './store-config-seeder.service';
import { StoreConfigService } from './store-config.service';
import { BackupIbqOrder } from '../database/entities/backup-ibq-order.entity';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { StoreConfiguration } from '../database/entities/store-configuration.entity';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ValidationStatus } from '../database/enums';

@ApiTags('store-config')
@Controller('store-config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StoreConfigController {
  constructor(
    private readonly service: StoreConfigService,
    private readonly seeder: StoreConfigSeederService,
    @InjectRepository(StoreConfiguration)
    private readonly stores: Repository<StoreConfiguration>,
    @InjectRepository(BackupOdooOrder)
    private readonly odooOrders: Repository<BackupOdooOrder>,
    @InjectRepository(BackupIbqOrder)
    private readonly ibqOrders: Repository<BackupIbqOrder>,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List store configurations' })
  list(@Query('activeOnly') activeOnly?: string) {
    return this.service.listStores(activeOnly === 'true');
  }

  @Get('export')
  @ApiOperation({ summary: 'Export store configurations as CSV' })
  async exportCsv(@Res() res: Response) {
    const rows = await this.stores.find({
      order: { branchCode: 'ASC' },
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
        headers
          .map((h) => escape((r as unknown as Record<string, unknown>)[h]))
          .join(','),
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

  @Post('seed-region')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Bulk-provision StoreConfiguration for every eligible outlet in a region ' +
      'from reference data (outlet config + sales metadata + registers). Pass ' +
      '{ dryRun: true } to preview. Omit region to seed all regions.',
  })
  async seedRegion(@Body() body: { region?: string; dryRun?: boolean }) {
    const reports = await this.seeder.seedRegion(body?.region, {
      dryRun: body?.dryRun ?? false,
    });
    return {
      dryRun: body?.dryRun ?? false,
      regions: reports.length,
      totals: {
        created: reports.reduce((s, r) => s + r.created, 0),
        updated: reports.reduce((s, r) => s + r.updated, 0),
        skipped: reports.reduce((s, r) => s + r.skipped, 0),
        needsReview: reports.reduce((s, r) => s + r.needsReview, 0),
      },
      reports,
    };
  }

  @Post('repair-auto-created')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Re-resolve PENDING/PARTIAL store configurations with name-first matching ' +
      '(outlet config region → own sales metadata → own register accounts), ' +
      'repairing rows auto-created with borrowed accounts or a mislabelled ' +
      'region. Pass { dryRun: true } to preview.',
  })
  repairAutoCreated(@Body() body?: { dryRun?: boolean }) {
    return this.service.repairAutoCreatedConfigs({
      dryRun: body?.dryRun ?? false,
    });
  }

  @Post('populate/all-branches')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Populate StoreConfiguration for all branches (Option B) - creates configs for all branches found in backup tables',
  })
  async populateAllBranches() {
    return this.service.populateAllBranches();
  }

  @Post('populate/bank-cash-accounts')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Populate missing bank/cash account IDs for all store configurations using VendHqRegister data by region',
  })
  async populateBankCashAccounts() {
    return this.service.populateBankCashAccountIds();
  }

  @Post('batch/populate-accounts')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Atomically populate bank/cash accounts with backup and rollback support',
  })
  batchPopulateAccounts(
    @Body() _body?: { dryRun?: boolean; autoRollbackOnError?: boolean },
  ) {
    // This endpoint uses the BatchOperationsService which will be injected
    // For now, return a message that it's available
    return {
      message: 'This endpoint requires BatchOperationsService to be registered',
      suggestion: 'Use POST /store-config/populate/bank-cash-accounts for now',
    };
  }

  @Post('batch/rollback/:backupId')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Rollback store configurations from a backup',
  })
  rollbackFromBackup(@Param('backupId') backupId: string) {
    return {
      message: 'Rollback endpoint - requires BatchOperationsService',
      backupId,
    };
  }

  @Get('batch/backups')
  @Roles('ADMIN', 'OPERATOR')
  @ApiOperation({
    summary: 'List configuration backups',
  })
  listBackups(@Query('limit') _limit?: string) {
    return {
      message: 'Backups list endpoint - requires BatchOperationsService',
    };
  }

  @Post('batch/backup')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Create a manual backup',
  })
  createBackup(@Body() body: { reason: string }) {
    return {
      message: 'Create backup endpoint - requires BatchOperationsService',
      reason: body.reason,
    };
  }

  @Get('health/check')
  @ApiOperation({
    summary: 'Health check - verify store configurations for all branches',
  })
  async checkStoreConfigs() {
    // Get all unique branches from backup tables
    const aggregate = async (
      repo: Repository<ObjectLiteral>,
    ): Promise<Array<{ branchId: number; branchName: string | null }>> => {
      const rows = await repo
        .createQueryBuilder('o')
        .select('o.branchId', 'branchId')
        .addSelect('MAX(o.branchName)', 'branchName')
        .where('o.branchId IS NOT NULL')
        .groupBy('o.branchId')
        .orderBy('o.branchId', 'ASC')
        .getRawMany<{ branchId: number | string; branchName: string | null }>();
      return rows.map((r) => ({
        branchId: Number(r.branchId),
        branchName: r.branchName,
      }));
    };

    const odooBranches = await aggregate(this.odooOrders);
    const ibqBranches = await aggregate(this.ibqOrders);

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
        (r) => r.hasConfig && r.configStatus === ValidationStatus.VALIDATED,
      ).length,
      configsPartial: results.filter(
        (r) => r.hasConfig && r.configStatus === ValidationStatus.PARTIAL,
      ).length,
      configsInvalid: results.filter(
        (r) => r.hasConfig && r.configStatus === ValidationStatus.INVALID,
      ).length,
      configsPending: results.filter(
        (r) => r.hasConfig && r.configStatus === ValidationStatus.PENDING,
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
