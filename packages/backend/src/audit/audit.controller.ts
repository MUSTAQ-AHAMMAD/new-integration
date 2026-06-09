import { Controller, Get, Param, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';

class AuditSearchQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  orderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ type: Number, default: 50 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ type: Number, default: 0 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Search audit log entries' })
  search(@Query() query: AuditSearchQueryDto) {
    return this.auditService.search(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get audit statistics' })
  getStats() {
    return this.auditService.getStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single audit log entry' })
  getEntry(@Param('id') id: string) {
    return this.auditService.getEntry(id);
  }
}
