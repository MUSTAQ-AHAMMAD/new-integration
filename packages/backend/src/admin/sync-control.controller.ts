import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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
  listAll() {
    return this.syncControl.listAll();
  }

  @Get(':serviceName')
  @ApiOperation({ summary: 'Get sync control status for a specific service' })
  getOne(@Param('serviceName') serviceName: string) {
    return this.syncControl.getOne(serviceName);
  }

  @Post(':serviceName/enable')
  @ApiOperation({ summary: 'Enable a sync service' })
  async enable(@Param('serviceName') serviceName: string) {
    await this.syncControl.enable(serviceName);
    return {
      success: true,
      message: `Sync service "${serviceName}" has been enabled`,
    };
  }

  @Post(':serviceName/disable')
  @ApiOperation({ summary: 'Disable a sync service' })
  async disable(@Param('serviceName') serviceName: string) {
    await this.syncControl.disable(serviceName);
    return {
      success: true,
      message: `Sync service "${serviceName}" has been disabled`,
    };
  }

  @Post(':serviceName/toggle')
  @ApiOperation({ summary: 'Toggle a sync service on/off' })
  async toggle(@Param('serviceName') serviceName: string) {
    const current = await this.syncControl.getOne(serviceName);
    if (!current) {
      return {
        success: false,
        message: `Sync service "${serviceName}" not found`,
      };
    }

    if (current.enabled) {
      await this.syncControl.disable(serviceName);
      return {
        success: true,
        enabled: false,
        message: `Sync service "${serviceName}" has been disabled`,
      };
    } else {
      await this.syncControl.enable(serviceName);
      return {
        success: true,
        enabled: true,
        message: `Sync service "${serviceName}" has been enabled`,
      };
    }
  }
}
