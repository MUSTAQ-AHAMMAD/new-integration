import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationRole } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: Transporter | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const smtpHost = this.config.get<string>('SMTP_HOST');
    const smtpUser = this.config.get<string>('SMTP_USER');
    const smtpPass = this.config.get<string>('SMTP_PASS');

    if (smtpHost && smtpUser && smtpPass) {
      const smtpPort = this.config.get<number>('SMTP_PORT') ?? 587;
      // Use implicit TLS (secure) when port is 465; otherwise use STARTTLS
      const secure =
        this.config.get<string>('SMTP_SECURE') === 'true' || smtpPort === 465;
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure,
        auth: { user: smtpUser, pass: smtpPass },
      });
      this.logger.log(
        `SMTP transport configured (host: ${smtpHost}, port: ${smtpPort}, secure: ${secure})`,
      );
    } else {
      this.logger.warn(
        'SMTP not configured — email notifications will be logged only. ' +
          'Set SMTP_HOST, SMTP_USER and SMTP_PASS to enable delivery.',
      );
    }
  }

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
    role: NotificationRole;
    receiveErrorAlerts?: boolean;
    receiveDailyReports?: boolean;
    receiveInventoryAlerts?: boolean;
    receivePaymentAlerts?: boolean;
    receiveConfigAlerts?: boolean;
    escalationLevel?: number;
    backupRecipientId?: string;
  }) {
    return this.prisma.notificationRecipient.create({ data });
  }

  async updateRecipient(
    id: string,
    data: {
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

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

    if (!this.transporter) {
      // SMTP not configured — log only so the rest of the system keeps working
      this.logger.log(
        `[NO-SMTP] Notification "${params.subject}" → [${params.recipients.join(', ')}]`,
      );
      return;
    }

    const fromAddress =
      this.config.get<string>('SMTP_FROM') ?? 'noreply@integration.local';

    this.transporter
      .sendMail({
        from: fromAddress,
        to: params.recipients.join(', '),
        subject: params.subject,
        text: params.body,
        html: `<pre style="font-family:sans-serif">${this.escapeHtml(params.body)}</pre>`,
      })
      .then(() => {
        this.logger.log(
          `Email "${params.subject}" sent to [${params.recipients.join(', ')}]`,
        );
      })
      .catch((err: Error) => {
        this.logger.error(
          `Failed to send email "${params.subject}": ${err.message}`,
          err.stack,
        );
      });
  }
}
