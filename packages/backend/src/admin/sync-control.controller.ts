import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/roles.decorator';
import { SyncControlService } from '../sync/sync-control.service';

@ApiTags('admin')
@Controller('admin/sync-control')
@Roles('ADMIN')
export class SyncControlController {
  constructor(private readonly syncControl: SyncControlService) {}

  @Get()
  @ApiOperation({ summary: 'List all sync services and their control status' })
  listAll(@Query('region') region?: string) {
    return this.syncControl.listAll(region);
  }

  @Get(':serviceName')
  @ApiOperation({ summary: 'Get sync control status for a specific service' })
  getOne(
    @Param('serviceName') serviceName: string,
    @Query('region') region?: string,
  ) {
    return this.syncControl.getOne(serviceName, region);
  }

  @Post(':serviceName/enable')
  @ApiOperation({ summary: 'Enable a sync service' })
  async enable(
    @Param('serviceName') serviceName: string,
    @Query('region') region?: string,
  ) {
    await this.syncControl.enable(serviceName, region);
    const regionLabel = region ? ` (region=${region})` : '';
    return {
      success: true,
      message: `Sync service "${serviceName}"${regionLabel} has been enabled`,
    };
  }

  @Post(':serviceName/disable')
  @ApiOperation({ summary: 'Disable a sync service' })
  async disable(
    @Param('serviceName') serviceName: string,
    @Query('region') region?: string,
  ) {
    await this.syncControl.disable(serviceName, region);
    const regionLabel = region ? ` (region=${region})` : '';
    return {
      success: true,
      message: `Sync service "${serviceName}"${regionLabel} has been disabled`,
    };
  }

  @Post(':serviceName/toggle')
  @ApiOperation({ summary: 'Toggle a sync service on/off' })
  async toggle(
    @Param('serviceName') serviceName: string,
    @Query('region') region?: string,
  ) {
    const current = await this.syncControl.getOne(serviceName, region);
    if (!current) {
      const regionLabel = region ? ` (region=${region})` : '';
      return {
        success: false,
        message: `Sync service "${serviceName}"${regionLabel} not found`,
      };
    }

    const regionLabel = region ? ` (region=${region})` : '';
    if (current.enabled) {
      await this.syncControl.disable(serviceName, region);
      return {
        success: true,
        enabled: false,
        message: `Sync service "${serviceName}"${regionLabel} has been disabled`,
      };
    } else {
      await this.syncControl.enable(serviceName, region);
      return {
        success: true,
        enabled: true,
        message: `Sync service "${serviceName}"${regionLabel} has been enabled`,
      };
    }
  }
}
