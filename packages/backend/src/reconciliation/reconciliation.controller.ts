import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  type BreakdownGroupBy,
  PROBLEM_STATUSES,
  ReconciliationRow,
  ReconciliationService,
} from './reconciliation.service';
import { RequireArea } from '../auth/require-area.decorator';

class ReconcileQueryDto {
  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-08-27' })
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  region?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branchCode?: string;

  @ApiPropertyOptional({
    description:
      'One store, matched on branch code, Odoo branch name or POS config name.',
  })
  @IsOptional()
  @IsString()
  store?: string;

  @ApiPropertyOptional({
    description: `One status, 'PROBLEMS' for everything needing attention, or 'ALL'.`,
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 0.01 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  tolerance?: number;

  @ApiPropertyOptional({ default: 50 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ default: 0 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ default: 2000 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  maxScan?: number;
}

const GROUP_BY_VALUES: BreakdownGroupBy[] = ['store', 'date', 'store-date'];

class BreakdownQueryDto extends ReconcileQueryDto {
  @ApiPropertyOptional({ enum: GROUP_BY_VALUES, default: 'store' })
  @IsOptional()
  @IsIn(GROUP_BY_VALUES)
  groupBy?: string;
}

type CsvValue = string | number | Date | null | undefined;

/** Escapes a value for CSV: quote it and double any embedded quotes. */
function csvCell(value: CsvValue): string {
  if (value == null) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

@ApiTags('reconciliation')
@Controller('reconciliation')
@RequireArea('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('statuses')
  @ApiOperation({ summary: 'Mismatch statuses and which count as problems' })
  statuses() {
    return {
      problemStatuses: PROBLEM_STATUSES,
      descriptions: {
        MATCHED: 'Odoo and Oracle agree on totals, payments and line count.',
        ORACLE_ERROR:
          'Oracle rejected the invoice; the error text is on the row.',
        MISSING_IN_ORACLE:
          'A syncable Odoo order with no invoice recorded in Oracle.',
        UNEXPECTED_IN_ORACLE:
          'A cancelled or unpaid Odoo order that nonetheless reached Oracle.',
        AMOUNT_MISMATCH: 'Invoice total differs from the Odoo order total.',
        PAYMENT_MISMATCH:
          'Linked Oracle receipts do not add up to the Odoo payments.',
        LINE_MISMATCH:
          'Odoo and the Oracle invoice carry a different line count.',
        NOT_SYNCABLE:
          'Cancelled or unpaid in Odoo and correctly absent from Oracle.',
      },
    };
  }

  @Get()
  @ApiOperation({
    summary: 'Compare Odoo orders against what was pushed to Oracle',
  })
  reconcile(@Query() query: ReconcileQueryDto) {
    return this.reconciliation.reconcile(query);
  }

  @Get('breakdown')
  @ApiOperation({
    summary:
      'The same comparison rolled up per store, per day, or per store-day',
  })
  breakdown(@Query() query: BreakdownQueryDto) {
    const groupBy: BreakdownGroupBy = GROUP_BY_VALUES.includes(
      query.groupBy as BreakdownGroupBy,
    )
      ? (query.groupBy as BreakdownGroupBy)
      : 'store';
    return this.reconciliation.breakdown(query, groupBy);
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="reconciliation.csv"')
  @ApiOperation({ summary: 'Download the filtered comparison as CSV' })
  async export(@Query() query: ReconcileQueryDto): Promise<string> {
    // Export is the whole filtered set, not the visible page — an export that
    // silently stopped at 50 rows would be worse than no export.
    const result = await this.reconciliation.reconcile({
      ...query,
      limit: 500,
      offset: 0,
      maxScan: query.maxScan ?? 20000,
    });

    const header = [
      'Odoo Order Ref',
      'Odoo Order Id',
      'Order Date',
      'Branch Code',
      'Branch Name',
      'POS Config',
      'Region',
      'Odoo State',
      'Status',
      'Odoo Total',
      'Oracle Total',
      'Amount Difference',
      'Odoo Untaxed',
      'Odoo Tax',
      'Odoo Discount',
      'Odoo Payments',
      'Oracle Receipts',
      'Payment Difference',
      'Odoo Lines',
      'Oracle Lines',
      'Oracle Invoice',
      'Oracle Txn Date',
      'Queue Status',
      'Issues',
    ].join(',');

    const line = (r: ReconciliationRow) =>
      [
        r.orderName,
        r.odoo.orderId,
        // Date only: a trading day is what an accountant reconciles against,
        // and a full timestamp turns into a mangled cell in Excel.
        r.odoo.orderDate ? r.odoo.orderDate.toISOString().slice(0, 10) : '',
        r.odoo.branchCode,
        r.odoo.branchName,
        r.odoo.posConfigName,
        r.odoo.region,
        r.odoo.state,
        r.status,
        r.odoo.total,
        r.oracle?.total ?? '',
        r.amountDifference ?? '',
        r.odoo.untaxed,
        r.odoo.tax,
        r.odoo.discount,
        r.odoo.paymentTotal,
        r.oracle?.receiptTotal ?? '',
        r.paymentDifference ?? '',
        r.odoo.lineCount,
        r.oracle?.lineCount ?? '',
        r.oracle?.invoiceNumber ?? '',
        r.oracle?.txnDate ? r.oracle.txnDate.toISOString().slice(0, 10) : '',
        r.queueStatus ?? '',
        r.issues.join(' | '),
      ]
        .map(csvCell)
        .join(',');

    return [header, ...result.rows.map(line)].join('\n');
  }

  @Get('orders/:orderName')
  @ApiOperation({
    summary: 'Line-level Odoo vs Oracle comparison for a single order',
  })
  detail(
    @Param('orderName') orderName: string,
    @Query('tolerance') tolerance?: string,
  ) {
    const parsed = tolerance != null ? Number(tolerance) : undefined;
    return this.reconciliation.orderDetail(
      orderName,
      Number.isFinite(parsed) ? parsed : undefined,
    );
  }
}
