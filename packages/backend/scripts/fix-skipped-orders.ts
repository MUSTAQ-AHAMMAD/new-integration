/**
 * Fix Skipped Orders Script
 * 
 * Updates all skipped orders to mark them as paid and set status to PENDING
 * so they can be processed by the sync pipeline.
 * 
 * Run: npx ts-node scripts/fix-skipped-orders.ts
 */

import { PrismaClient, SyncStatus, Prisma } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log('🔍 Checking skipped orders...\n');

    // Count skipped orders
    const skippedCount = await prisma.orderSyncQueue.count({
      where: {
        status: SyncStatus.SKIPPED,
        isPaid: false,
      },
    });

    console.log(`Found ${skippedCount} skipped orders marked as unpaid\n`);

    if (skippedCount === 0) {
      console.log('✅ No skipped orders to fix!');
      return;
    }

    // Show sample of orders to be updated
    const sample = await prisma.orderSyncQueue.findMany({
      where: {
        status: SyncStatus.SKIPPED,
        isPaid: false,
      },
      take: 5,
      select: {
        odooOrderNumber: true,
        branchCode: true,
        totalAmount: true,
      },
    });

    console.log('Sample of orders to be updated:');
    sample.forEach((order) => {
      console.log(
        `  - ${order.odooOrderNumber} (Branch: ${order.branchCode}, Amount: ${order.totalAmount})`,
      );
    });
    console.log('  ...\n');

    // Update all skipped orders
    console.log('🔄 Updating orders...\n');

    const result = await prisma.orderSyncQueue.updateMany({
      where: {
        status: SyncStatus.SKIPPED,
        isPaid: false,
        isCancelled: false, // Don't update cancelled orders
      },
      data: {
        isPaid: true,
        status: SyncStatus.PENDING,
        validationErrors: Prisma.JsonNull, // Clear validation errors
        syncAttempts: 0, // Reset sync attempts
      },
    });

    console.log(`✅ Successfully updated ${result.count} orders!`);
    console.log('\nOrders are now marked as paid and set to PENDING status.');
    console.log(
      'The automatic sync pipeline will process them within 5 minutes.\n',
    );
    console.log('Monitor progress at: http://localhost:3000/orders');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
