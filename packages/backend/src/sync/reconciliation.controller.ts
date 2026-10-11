import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ReconciliationService } from './reconciliation.service';

/**
 * Reconciliation reports (read-only):
 *   GET /reconciliation/summary         Odoo sales ↔ what was posted to Oracle,
 *                                       per store × store-local day, with
 *                                       order-level exceptions.
 *   GET /reconciliation/odoo-vs-backup  Live Odoo API ↔ the backup tables,
 *                                       order by order.
 */
@ApiTags('reconciliation')
@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Odoo vs Oracle reconciliation per store and business day',
  })
  @ApiQuery({ name: 'region', required: true })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  @ApiQuery({ name: 'branchCode', required: false })
  summary(
    @Query('region') region?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('branchCode') branchCode?: string,
  ) {
    if (!region?.trim()) throw new BadRequestException('region is required');
    return this.reconciliation.reconcile({
      region,
      startDate: startDate ?? '',
      endDate: endDate ?? '',
      branchCode: branchCode || undefined,
    });
  }

  @Get('odoo-vs-backup')
  @ApiOperation({
    summary: 'Live Odoo API vs stored backup, compared order by order',
  })
  @ApiQuery({ name: 'region', required: true })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  odooVsBackup(
    @Query('region') region?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    if (!region?.trim()) throw new BadRequestException('region is required');
    return this.reconciliation.odooVsBackup({
      region,
      startDate: startDate ?? '',
      endDate: endDate ?? '',
    });
  }
}
