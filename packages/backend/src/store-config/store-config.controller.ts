import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { StoreConfigService } from './store-config.service';

@ApiTags('store-config')
@Controller('store-config')
export class StoreConfigController {
  constructor(private readonly service: StoreConfigService) {}

  @Get()
  @ApiOperation({ summary: 'List store configurations' })
  list(@Query('activeOnly') activeOnly?: string) {
    return this.service.listStores(activeOnly === 'true');
  }

  @Get(':branchCode')
  @ApiOperation({ summary: 'Get store configuration by branch code (raw, no validation gate)' })
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
    return this.service.upsertStore({ branchCode, ...body } as Parameters<StoreConfigService['upsertStore']>[0]);
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
