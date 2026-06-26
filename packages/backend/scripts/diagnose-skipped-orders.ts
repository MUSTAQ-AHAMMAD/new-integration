#!/usr/bin/env tsx
/**
 * Diagnostic script to analyze skipped orders and identify their actual states.
 * This helps determine why orders are being marked as "Not Paid" and skipped from Oracle sync.
 */

import { PrismaClient, SyncStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Analyzing skipped orders...\n');

  // Get count of skipped orders
  const skippedCount = await prisma.orderSyncQueue.count({
    where: { status: SyncStatus.SKIPPED, isPaid: false },
  });
  
  console.log(`Total skipped orders (isPaid=false): ${skippedCount}\n`);

  // Get sample of skipped orders with their backup data
  const skippedOrders = await prisma.orderSyncQueue.findMany({
    where: {
      status: SyncStatus.SKIPPED,
      isPaid: false,
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      odooOrderId: true,
      odooOrderNumber: true,
      branchCode: true,
      isPaid: true,
      isCancelled: true,
      totalAmount: true,
      createdAt: true,
      odooBackupOrderId: true,
    },
  });

  console.log('📋 Sample of recent skipped orders:\n');
  
  for (const order of skippedOrders) {
    console.log(`Order: ${order.odooOrderNumber} (ID: ${order.odooOrderId})`);
    console.log(`  Branch: ${order.branchCode}`);
    console.log(`  Amount: ${order.totalAmount}`);
    console.log(`  isPaid: ${order.isPaid}, isCancelled: ${order.isCancelled}`);
    console.log(`  Created: ${order.createdAt}`);
    
    // Try to find backup data
    if (order.odooBackupOrderId) {
      const backup = await prisma.backupOdooOrder.findUnique({
        where: { id: order.odooBackupOrderId },
        select: {
          state: true,
          amountTotal: true,
          branchId: true,
        },
      });
      
      if (backup) {
        console.log(`  ⚠️  Backup state: "${backup.state}"`);
        console.log(`  Backup amount: ${backup.amountTotal}`);
      } else {
        console.log(`  ⚠️  No Odoo backup found`);
      }
    }
    
    // Check for IBQ backup
    const ibqBackup = await prisma.backupIbqOrder.findFirst({
      where: {
        OR: [
          { orderId: parseInt(order.odooOrderId, 10) || -1 },
          { orderName: order.odooOrderNumber },
        ],
      },
      select: {
        state: true,
        amountTotal: true,
      },
    });
    
    if (ibqBackup) {
      console.log(`  ⚠️  IBQ backup state: "${ibqBackup.state}"`);
    }
    
    console.log('');
  }

  // Get aggregated state statistics from backup tables
  console.log('\n📊 State distribution in BackupOdooOrder (last 1000 orders):\n');
  
  const stateDistribution = await prisma.$queryRaw<Array<{ state: string | null; count: bigint }>>`
    SELECT state, COUNT(*) as count
    FROM "BackupOdooOrder"
    GROUP BY state
    ORDER BY count DESC
    LIMIT 20
  `;
  
  for (const { state, count } of stateDistribution) {
    console.log(`  ${state || '(null)'}: ${count.toString()} orders`);
  }

  // Check IBQ orders too
  console.log('\n📊 State distribution in BackupIbqOrder (last 1000 orders):\n');
  
  const ibqStateDistribution = await prisma.$queryRaw<Array<{ state: string | null; count: bigint }>>`
    SELECT state, COUNT(*) as count
    FROM "BackupIbqOrder"
    GROUP BY state
    ORDER BY count DESC
    LIMIT 20
  `;
  
  for (const { state, count } of ibqStateDistribution) {
    console.log(`  ${state || '(null)'}: ${count.toString()} orders`);
  }

  // Get orders by branch 270 specifically (mentioned in the problem)
  console.log('\n📊 Orders for Branch 270:\n');
  
  const branch270Orders = await prisma.orderSyncQueue.findMany({
    where: {
      branchCode: '270',
      status: SyncStatus.SKIPPED,
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      odooOrderNumber: true,
      isPaid: true,
      totalAmount: true,
      createdAt: true,
      odooBackupOrderId: true,
    },
  });
  
  for (const order of branch270Orders) {
    console.log(`${order.odooOrderNumber} - isPaid: ${order.isPaid} - Amount: ${order.totalAmount}`);
    
    if (order.odooBackupOrderId) {
      const backup = await prisma.backupOdooOrder.findUnique({
        where: { id: order.odooBackupOrderId },
        select: { state: true },
      });
      console.log(`  State: "${backup?.state || 'unknown'}"`);
    }
  }

  console.log('\n✅ Diagnosis complete!\n');
  console.log('💡 Next steps:');
  console.log('   1. Review the states above to identify missing states');
  console.log('   2. Add missing states to PAID_ORDER_STATES in common/odoo-utils.ts');
  console.log('   3. Re-process skipped orders with POST /sync/orders/retry-skipped');
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
