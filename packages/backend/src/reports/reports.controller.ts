import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ReportsService } from './reports.service';
import type { ReportQueryDto } from './report-query';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get('datasets')
  @ApiOperation({
    summary: 'List reportable datasets and their fields (for the report builder)',
  })
  datasets() {
    return this.service.datasets();
  }

  @Post('query')
  @ApiOperation({
    summary: 'Run a flexible report query (aggregate or records mode)',
  })
  query(@Body() dto: ReportQueryDto) {
    return this.service.run(dto);
  }

  @Post('export')
  @ApiOperation({ summary: 'Export a report query result as CSV' })
  async export(@Body() dto: ReportQueryDto, @Res() res: Response) {
    const csv = await this.service.exportCsv(dto);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="report-${dto.dataset ?? 'export'}.csv"`,
    );
    res.send(csv);
  }
}
