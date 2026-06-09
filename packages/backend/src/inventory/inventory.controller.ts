import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InventoryService } from './inventory.service';

class NegativeInventoryQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  branchCode?: string;

  @ApiPropertyOptional({ type: Number, default: 50 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

class ReviewInventoryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reviewedBy!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reviewNote?: string;
}

class AlertHistoryQueryDto {
  @ApiPropertyOptional({ type: Number, default: 50 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

@ApiTags('inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('negative')
  @ApiOperation({ summary: 'List negative inventory records' })
  listNegativeInventory(@Query() query: NegativeInventoryQueryDto) {
    return this.inventoryService.listNegativeInventory(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get inventory alert statistics' })
  getInventoryStats() {
    return this.inventoryService.getInventoryStats();
  }

  @Get('alert-history')
  @ApiOperation({ summary: 'List inventory alert history' })
  getAlertHistory(@Query() query: AlertHistoryQueryDto) {
    return this.inventoryService.getAlertHistory(query.limit ?? 50);
  }

  @Put(':id/review')
  @ApiOperation({ summary: 'Mark a negative inventory record as reviewed' })
  markAsReviewed(@Param('id') id: string, @Body() body: ReviewInventoryDto) {
    return this.inventoryService.markAsReviewed(
      id,
      body.reviewedBy,
      body.reviewNote,
    );
  }
}
