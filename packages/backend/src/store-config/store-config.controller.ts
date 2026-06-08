import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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
  @ApiOperation({ summary: 'Get store configuration by branch code' })
  get(@Param('branchCode') branchCode: string) {
    return this.service.getValidatedConfig(branchCode);
  }

  @Post()
  @ApiOperation({ summary: 'Create or update store configuration' })
  upsert(@Body() body: Parameters<StoreConfigService['upsertStore']>[0]) {
    return this.service.upsertStore(body);
  }

  @Post(':branchCode/validate')
  @ApiOperation({ summary: 'Validate store configuration' })
  validate(@Param('branchCode') branchCode: string) {
    return this.service.validateConfig(branchCode);
  }
}
