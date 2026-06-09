import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { NotificationsService } from '../../notifications/notifications.service';
import { QUEUE_NAMES } from '../queues.module';

export interface NotificationJobData {
  type: 'ERROR_ALERT' | 'INVENTORY_ALERT' | 'DAILY_REPORT' | 'CUSTOM';
  subject: string;
  body: string;
  recipients?: string[];
}

@Processor(QUEUE_NAMES.NOTIFICATIONS)
export class NotificationsProcessor {
  private readonly logger = new Logger(NotificationsProcessor.name);

  constructor(private readonly notificationsService: NotificationsService) {}

  @Process('send')
  async handleSendNotification(job: Job<NotificationJobData>) {
    const { type, subject, body, recipients } = job.data;
    this.logger.log(`Processing notification job: ${type} - "${subject}"`);

    let resolvedRecipients = recipients ?? [];

    if (!recipients || recipients.length === 0) {
      switch (type) {
        case 'ERROR_ALERT':
          resolvedRecipients =
            await this.notificationsService.getErrorAlertRecipients();
          break;
        case 'INVENTORY_ALERT':
          resolvedRecipients =
            await this.notificationsService.getInventoryAlertRecipients();
          break;
        case 'DAILY_REPORT':
          resolvedRecipients =
            await this.notificationsService.getDailyReportRecipients();
          break;
        default:
          this.logger.warn(
            `No recipients resolved for notification type: ${type}`,
          );
          return;
      }
    }

    if (resolvedRecipients.length === 0) {
      this.logger.debug(
        `No active recipients for notification type ${type}, skipping`,
      );
      return;
    }

    this.notificationsService.sendNotification({
      subject,
      body,
      recipients: resolvedRecipients,
    });

    this.logger.log(
      `Notification "${subject}" dispatched to ${resolvedRecipients.length} recipient(s)`,
    );
  }
}
