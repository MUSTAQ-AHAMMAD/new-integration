import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Roles } from '../auth/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import {
  AutomationSettingsDto,
  IntegrationSchedulerService,
} from './integration-scheduler.service';

/**
 * Admin control of the automatic integration: per-region schedule + cut-off,
 * on/off switches, health, a read-only dry run (optionally at a simulated
 * time, to test the cut-off) and a real "run now" that behaves exactly like
 * the scheduled run.
 */
@ApiTags('integration-automation')
@Controller('integration-automation')
@Roles('ADMIN')
export class AutomationController {
  constructor(private readonly scheduler: IntegrationSchedulerService) {}

  @Get('status')
  @ApiOperation({
    summary:
      'Per-region automation health, schedule, cut-off window and recent runs',
  })
  status() {
    return this.scheduler.status();
  }

  @Put(':region/settings')
  @ApiOperation({
    summary:
      'Update a region’s run time, cut-off, lookback, outlet mode and failure policy',
  })
  updateSettings(
    @Param('region') region: string,
    @Body() body: AutomationSettingsDto,
    @Req() req: Request,
  ) {
    return this.scheduler.updateSettings(region, body ?? {}, this.user(req));
  }

  @Post('master/enable')
  @HttpCode(HttpStatus.OK)
  async enableMaster() {
    await this.scheduler.setEnabled(null, true);
    return { ok: true };
  }

  @Post('master/disable')
  @HttpCode(HttpStatus.OK)
  async disableMaster() {
    await this.scheduler.setEnabled(null, false);
    return { ok: true };
  }

  @Post(':region/enable')
  @HttpCode(HttpStatus.OK)
  async enable(@Param('region') region: string) {
    await this.scheduler.setEnabled(region, true);
    return { ok: true };
  }

  @Post(':region/disable')
  @HttpCode(HttpStatus.OK)
  async disable(@Param('region') region: string) {
    await this.scheduler.setEnabled(region, false);
    return { ok: true };
  }

  @Get(':region/preview')
  @ApiOperation({
    summary:
      'Dry run — what a run at `at` (default now) would post and whether it would succeed. Writes nothing.',
  })
  @ApiQuery({
    name: 'at',
    required: false,
    description: 'ISO date-time to simulate (tests the cut-off)',
  })
  preview(@Param('region') region: string, @Query('at') at?: string) {
    return this.scheduler.preview(region, at || undefined);
  }

  @Post(':region/run-now')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Run the region now exactly as the scheduler would (cut-off window, outlet mode, failure policy). Posts to Oracle.',
  })
  runNow(@Param('region') region: string, @Req() req: Request) {
    return this.scheduler.runNow(region, this.user(req));
  }

  private user(req: Request): string {
    const u = (req as Request & { user?: JwtPayload }).user;
    return u?.email ?? u?.sub ?? 'admin';
  }
}
