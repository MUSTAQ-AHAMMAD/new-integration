import { Body, Controller, Get, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNumber, Min } from 'class-validator';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service';

class UpdateAlertThresholdsDto {
  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  failureRateThreshold!: number;

  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  latencyThreshold!: number;
}

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get application settings' })
  getSettings() {
    return this.settingsService.getSettings();
  }

  @Get('alert-thresholds')
  @ApiOperation({ summary: 'Get current alert thresholds' })
  getAlertThresholds() {
    return this.settingsService.getAlertThresholds();
  }

  @Put('alert-thresholds')
  @ApiOperation({ summary: 'Update alert thresholds' })
  updateAlertThresholds(@Body() body: UpdateAlertThresholdsDto) {
    return this.settingsService.updateAlertThresholds(body);
  }

  @Get('sync-schedule')
  @ApiOperation({ summary: 'Get configured sync schedules' })
  getSyncSchedule() {
    return this.settingsService.getSyncSchedule();
  }

  @Get('retry-policy')
  @ApiOperation({ summary: 'Get retry policy settings' })
  getRetryPolicy() {
    return this.settingsService.getRetryPolicy();
  }
}
