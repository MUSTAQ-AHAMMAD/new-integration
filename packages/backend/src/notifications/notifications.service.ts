import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listRecipients(activeOnly = false) {
    return this.prisma.notificationRecipient.findMany({
      where: activeOnly ? { isActive: true } : undefined,
      orderBy: { name: 'asc' },
    });
  }

  async getRecipient(id: string) {
    return this.prisma.notificationRecipient.findUnique({ where: { id } });
  }

  async createRecipient(data: {
    email: string;
    name: string;
    role: string;
    receiveErrorAlerts?: boolean;
    receiveDailyReports?: boolean;
    receiveInventoryAlerts?: boolean;
  }) {
    return this.prisma.notificationRecipient.create({ data });
  }

  async updateRecipient(
    id: string,
    data: {
      name?: string;
      role?: string;
      receiveErrorAlerts?: boolean;
      receiveDailyReports?: boolean;
      receiveInventoryAlerts?: boolean;
      isActive?: boolean;
    },
  ) {
    return this.prisma.notificationRecipient.update({ where: { id }, data });
  }

  async deleteRecipient(id: string) {
    return this.prisma.notificationRecipient.delete({ where: { id } });
  }

  async getErrorAlertRecipients(): Promise<string[]> {
    const recipients = await this.prisma.notificationRecipient.findMany({
      where: { isActive: true, receiveErrorAlerts: true },
      select: { email: true },
    });
    return recipients.map((r) => r.email);
  }

  async getInventoryAlertRecipients(): Promise<string[]> {
    const recipients = await this.prisma.notificationRecipient.findMany({
      where: { isActive: true, receiveInventoryAlerts: true },
      select: { email: true },
    });
    return recipients.map((r) => r.email);
  }

  async getDailyReportRecipients(): Promise<string[]> {
    const recipients = await this.prisma.notificationRecipient.findMany({
      where: { isActive: true, receiveDailyReports: true },
      select: { email: true },
    });
    return recipients.map((r) => r.email);
  }

  sendNotification(params: {
    subject: string;
    body: string;
    recipients: string[];
  }): void {
    if (params.recipients.length === 0) {
      this.logger.debug(`No recipients for notification: ${params.subject}`);
      return;
    }

    // Log the notification; actual email dispatch is handled by the
    // notifications queue processor which uses nodemailer when SMTP is
    // configured. Without SMTP configured we just log.
    this.logger.log(
      `Notification queued: "${params.subject}" → [${params.recipients.join(', ')}]`,
    );
  }
}
