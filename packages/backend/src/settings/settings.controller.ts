import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';
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
  latencyThresholdMs!: number;

  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxQueueDepth!: number;

  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  alertCooldownMinutes!: number;
}

class UpdateRetryPolicyDto {
  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxRetries!: number;

  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  initialDelayMs!: number;

  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  backoffMultiplier!: number;

  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxDelayMs!: number;
}

class ValidateCronDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  expression!: string;
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

  @Post('sync-schedule/validate')
  @ApiOperation({
    summary: 'Validate a cron expression and preview upcoming run times',
  })
  validateCron(@Body() body: ValidateCronDto) {
    return this.settingsService.validateCron(body.expression);
  }

  @Get('retry-policy')
  @ApiOperation({ summary: 'Get retry policy settings' })
  getRetryPolicy() {
    return this.settingsService.getRetryPolicy();
  }

  @Put('retry-policy')
  @ApiOperation({ summary: 'Update retry policy settings' })
  updateRetryPolicy(@Body() body: UpdateRetryPolicyDto) {
    return this.settingsService.updateRetryPolicy(body);
  }
}
