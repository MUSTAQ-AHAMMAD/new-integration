import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { WebhookService } from './webhook.service';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post('odoo')
  @HttpCode(200)
  @SkipThrottle()
  @ApiOperation({ summary: 'Receive Odoo webhook events' })
  async receiveOdooEvent(
    @Body() payload: Record<string, unknown>,
    @Req() req: Request,
    @Headers('x-odoo-signature') signature?: string,
  ) {
    // req.rawBody is populated when NestJS is bootstrapped with rawBody: true
    const rawBody: Buffer =
      (req as Request & { rawBody?: Buffer }).rawBody ??
      Buffer.from(JSON.stringify(payload));

    return this.webhookService.processOdooEvent(payload, rawBody, signature);
  }
}
