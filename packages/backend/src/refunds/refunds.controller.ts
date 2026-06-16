import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { RefundsService } from './refunds.service';

class ListRefundsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 12, type: Number })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @ApiPropertyOptional({ type: Number })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(2000)
  year?: number;

  @ApiPropertyOptional({ type: Number, default: 50 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

class ReconcileRefundDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reconcileNote!: string;
}

class CreateManualCreditMemoDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  originalOrderId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  originalOrderNumber!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refundOrderId!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refundOrderNumber!: string;

  @ApiProperty({ type: Number })
  @Type(() => Number)
  @IsNumber()
  refundAmount!: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refundReason!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  @Type(() => Date)
  @IsDate()
  refundDate!: Date;
}

@ApiTags('refunds')
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refundsService: RefundsService) {}

  @Get()
  @ApiOperation({ summary: 'List refund tracking records' })
  listRefunds(@Query() query: ListRefundsQueryDto) {
    return this.refundsService.listRefunds(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get refund statistics' })
  getRefundStats() {
    return this.refundsService.getRefundStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get refund details' })
  getRefund(@Param('id') id: string) {
    return this.refundsService.getRefund(id);
  }

  @Put(':id/reconcile')
  @ApiOperation({ summary: 'Mark a refund as reconciled' })
  reconcileRefund(@Param('id') id: string, @Body() body: ReconcileRefundDto) {
    return this.refundsService.reconcileRefund(id, body.reconcileNote);
  }

  @Post('credit-memo')
  @ApiOperation({ summary: 'Create a manual credit memo entry' })
  createManualCreditMemo(@Body() body: CreateManualCreditMemoDto) {
    return this.refundsService.createManualCreditMemo(body);
  }
}
