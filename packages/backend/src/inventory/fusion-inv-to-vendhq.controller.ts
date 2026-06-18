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
import { FusionInvToVendHqService } from './fusion-inv-to-vendhq.service';

@ApiTags('inventory-sync')
@Controller('inventory-sync')
export class FusionInvToVendHqController {
  constructor(private readonly fusionInvService: FusionInvToVendHqService) {}

  /**
   * Manually trigger Oracle → VendHQ inventory sync for all regions.
   * Mirrors the Java "triggerInventorySyncNow" button in the ADF UI.
   */
  @Post('trigger')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Trigger Oracle Fusion on-hand → VendHQ inventory sync for all regions',
  })
  async triggerAll() {
    await this.fusionInvService.runInventorySync();
    return {
      ok: true,
      message: 'Inventory sync triggered for all active credentials',
    };
  }

  /**
   * Manually trigger inventory sync for a specific region.
   */
  @Post('trigger/:region')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger inventory sync for a specific region' })
  async triggerRegion(@Param('region') region: string) {
    const result = await this.fusionInvService.syncInventoryForRegion(region);
    return { ok: true, ...result };
  }

  /**
   * Get recent inventory transaction records.
   */
  @Get('transactions')
  @ApiOperation({
    summary: 'List recent inventory push transactions (FusionInvTxn)',
  })
  async getTransactions(
    @Query('region') region?: string,
    @Query('limit') limit = '100',
  ) {
    return this.fusionInvService.getInventoryTransactions(
      region,
      Number(limit),
    );
  }
}
