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
}
