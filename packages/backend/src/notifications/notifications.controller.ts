import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationRole } from '../database/enums';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get('recipients')
  @ApiOperation({ summary: 'List notification recipients' })
  listRecipients(@Query('activeOnly') activeOnly?: string) {
    return this.service.listRecipients(activeOnly === 'true');
  }

  @Get('recipients/:id')
  @ApiOperation({ summary: 'Get a notification recipient' })
  getRecipient(@Param('id') id: string) {
    return this.service.getRecipient(id);
  }

  @Post('recipients')
  @ApiOperation({ summary: 'Create a notification recipient' })
  createRecipient(
    @Body()
    body: {
      email: string;
      name: string;
      role: NotificationRole;
      receiveErrorAlerts?: boolean;
      receiveDailyReports?: boolean;
      receiveInventoryAlerts?: boolean;
      receivePaymentAlerts?: boolean;
      receiveConfigAlerts?: boolean;
      escalationLevel?: number;
      backupRecipientId?: string;
    },
  ) {
    return this.service.createRecipient(body);
  }

  @Patch('recipients/:id')
  @ApiOperation({ summary: 'Update a notification recipient' })
  updateRecipient(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      role?: NotificationRole;
      receiveErrorAlerts?: boolean;
      receiveDailyReports?: boolean;
      receiveInventoryAlerts?: boolean;
      receivePaymentAlerts?: boolean;
      receiveConfigAlerts?: boolean;
      escalationLevel?: number;
      backupRecipientId?: string;
      isActive?: boolean;
    },
  ) {
    return this.service.updateRecipient(id, body);
  }

  @Delete('recipients/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a notification recipient' })
  async deleteRecipient(@Param('id') id: string) {
    await this.service.deleteRecipient(id);
  }
}
