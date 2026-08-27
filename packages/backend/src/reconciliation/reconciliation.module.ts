import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BackupOdooOrder } from '../database/entities/backup-odoo-order.entity';
import { BackupOdooOrderLine } from '../database/entities/backup-odoo-order-line.entity';
import { BackupOdooOrderPayment } from '../database/entities/backup-odoo-order-payment.entity';
import { FusionInvoiceHeader } from '../database/entities/fusion-invoice-header.entity';
import { FusionInvoiceLine } from '../database/entities/fusion-invoice-line.entity';
import { FusionStandardReceipt } from '../database/entities/fusion-standard-receipt.entity';
import { FusionMiscReceipt } from '../database/entities/fusion-misc-receipt.entity';
import { OrderSyncQueue } from '../database/entities/order-sync-queue.entity';
import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

/**
 * Odoo ↔ Oracle reconciliation. Read-only: it compares the stored Odoo backup
 * against the Fusion audit rows written when each order was pushed, so running
 * it can never move money.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      BackupOdooOrder,
      BackupOdooOrderLine,
      BackupOdooOrderPayment,
      FusionInvoiceHeader,
      FusionInvoiceLine,
      FusionStandardReceipt,
      FusionMiscReceipt,
      OrderSyncQueue,
    ]),
  ],
  controllers: [ReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
