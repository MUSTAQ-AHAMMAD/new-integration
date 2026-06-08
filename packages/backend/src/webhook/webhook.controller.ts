import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WebhookService } from './webhook.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post('odoo')
  @HttpCode(200)
  @ApiOperation({ summary: 'Receive Odoo webhook events' })
  async receiveOdooEvent(
    @Body() payload: Record<string, unknown>,
    @Headers('x-odoo-signature') signature?: string,
  ) {
    return this.webhookService.processOdooEvent(payload, signature);
  }
}
