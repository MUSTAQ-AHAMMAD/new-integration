import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import {
  BillToApplyRequest,
  BillToMappingService,
} from './bill-to-mapping.service';

/**
 * Admin "Bill-to Mapping": which active stores resolve a FusionSalesMetadata
 * bill-to (same matcher as the posting run), and a way to fix the gaps by
 * copying an existing bill-to onto a store or a region default.
 */
@ApiTags('admin')
@Controller('admin/bill-to-mapping')
@Roles('ADMIN')
export class BillToMappingController {
  constructor(private readonly service: BillToMappingService) {}

  @Get()
  @ApiOperation({ summary: 'Bill-to resolution status for every active store' })
  status(@Query('region') region?: string) {
    return this.service.status(region || undefined);
  }

  @Post('apply')
  @ApiOperation({
    summary: 'Copy existing bill-to rows onto stores or region defaults',
  })
  apply(@Body() body: BillToApplyRequest) {
    return this.service.apply(body ?? {});
  }
}
