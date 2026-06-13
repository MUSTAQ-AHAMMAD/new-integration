import { Body, Controller, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { PaymentMappingService } from './payment-mapping.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('payment-mappings')
@Controller('payment-mappings')
export class PaymentMappingController {
  constructor(
    private readonly service: PaymentMappingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List payment method mappings' })
  list(@Query('sourceSystem') sourceSystem?: string) {
    return this.service.listMappings(sourceSystem);
  }

  @Get('export')
  @ApiOperation({ summary: 'Export payment method mappings as CSV' })
  async exportCsv(@Res() res: Response) {
    const rows = await this.prisma.paymentMethodMapping.findMany({
      orderBy: { sourcePaymentName: 'asc' },
    });
    const escape = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    const csv = [
      headers.map(escape).join(','),
      ...rows.map((r) => headers.map((h) => escape((r as Record<string, unknown>)[h])).join(',')),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payment-mappings.csv"');
    res.send(csv);
  }

  @Post()
  @ApiOperation({ summary: 'Create payment method mapping' })
  create(
    @Body()
    body: {
      sourceSystem: string;
      sourcePaymentName: string;
      oracleReceiptMethodId: number;
      oracleReceiptMethodName: string;
      oracleBankAccountId?: number;
    },
  ) {
    return this.service.createMapping(body);
  }

  @Put(':id/approve')
  @ApiOperation({ summary: 'Approve pending payment method mapping' })
  approve(@Param('id') id: string, @Body() body: { approvedBy: string }) {
    return this.service.approvePendingMapping(id, body.approvedBy);
  }
}
