import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentMappingService } from './payment-mapping.service';

@ApiTags('payment-mappings')
@Controller('payment-mappings')
export class PaymentMappingController {
  constructor(private readonly service: PaymentMappingService) {}

  @Get()
  @ApiOperation({ summary: 'List payment method mappings' })
  list(@Query('sourceSystem') sourceSystem?: string) {
    return this.service.listMappings(sourceSystem);
  }

  @Post()
  @ApiOperation({ summary: 'Create payment method mapping' })
  create(
    @Body()
    body: {
      sourceSystem: string;
      sourcePaymentName: string;
      oracleReceiptMethodId: number;
      oracleReceiptMethodName: string;
      oracleBankAccountId?: number;
    },
  ) {
    return this.service.createMapping(body);
  }

  @Put(':id/approve')
  @ApiOperation({ summary: 'Approve pending payment method mapping' })
  approve(@Param('id') id: string, @Body() body: { approvedBy: string }) {
    return this.service.approvePendingMapping(id, body.approvedBy);
  }
}
