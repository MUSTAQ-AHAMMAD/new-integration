import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { InventoryUploadService } from './inventory-upload.service';

/**
 * Admin view of inventory rows Oracle refused — chiefly NEGATIVE_INVENTORY
 * (the subinventory would go negative) — and the action to re-send them once
 * stock has been corrected in Oracle.
 *
 * Lives at /inventory-holds rather than /admin/... so it can never collide with
 * the generic /admin/:table routes.
 */
@ApiTags('inventory-holds')
@Controller('inventory-holds')
@Roles('ADMIN')
export class InventoryHoldsController {
  constructor(private readonly inventoryUpload: InventoryUploadService) {}

  @Get()
  @ApiOperation({ summary: 'List held / failed inventory transactions' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'region', required: false })
  @ApiQuery({ name: 'skip', required: false })
  @ApiQuery({ name: 'take', required: false })
  list(
    @Query('status') status?: string,
    @Query('region') region?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.inventoryUpload.listHolds({
      status,
      region: region || undefined,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Post('reprocess')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Re-send held inventory rows to Oracle (selected ids, or every row of the given status/region)',
  })
  reprocess(
    @Body()
    body: { ids?: string[]; region?: string; statuses?: string[] } = {},
  ) {
    return this.inventoryUpload.reprocess({
      ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
      region: body.region || undefined,
      statuses: Array.isArray(body.statuses)
        ? body.statuses.map(String)
        : undefined,
    });
  }
}
