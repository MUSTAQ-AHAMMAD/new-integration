import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ItemSyncService } from './item-sync.service';

@ApiTags('item-sync')
@Controller('item-sync')
export class ItemSyncController {
  constructor(private readonly itemSyncService: ItemSyncService) {}

  /**
   * Manually trigger item sync for all active credentials.
   * Mirrors the Java "triggerItemSyncNow" button in the ADF UI.
   */
  @Post('trigger')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger Oracle Fusion → VendHQ item sync for all regions',
  })
  async triggerAll() {
    await this.itemSyncService.runItemSync();
    return {
      ok: true,
      message: 'Item sync triggered for all active credentials',
    };
  }

  /**
   * Manually trigger item sync for a specific region.
   */
  @Post('trigger/:region')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger item sync for a specific region' })
  async triggerRegion(@Param('region') region: string) {
    const result = await this.itemSyncService.syncItemsForRegion(region);
    return { ok: true, ...result };
  }

  /**
   * Get latest item sync status records.
   */
  @Get('status')
  @ApiOperation({ summary: 'Get VendHQ item sync status' })
  async getStatus(@Query('region') region?: string) {
    return this.itemSyncService.getItemSyncStatus(region);
  }
}
