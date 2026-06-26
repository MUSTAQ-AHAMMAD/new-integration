/**
 * Verification Script for Oracle Sync Fix
 * 
 * This script verifies all points in the ORACLE_SYNC_FIX_GUIDE.md checklist:
 * 1. Backend service can start successfully
 * 2. New orders are being marked as isPaid=true
 * 3. Previously skipped orders can be re-queued
 * 4. Oracle sync processor is configured properly
 * 5. Orders can sync to Oracle (check queue statuses)
 * 6. No new errors in failed transactions
 * 
 * Run: npx ts-node scripts/verify-oracle-sync-fix.ts
 */

import { PrismaClient, SyncStatus } from '@prisma/client';
import { normalizeOrderForIngestion, RawOdooOrderFields } from '../src/common/odoo-utils';

async function main() {
  const prisma = new PrismaClient();
  
  console.log('🔍 Oracle Sync Fix Verification\n');
  console.log('='.repeat(60));
  
  try {
    // Point 1: Check database connection (simulates backend service health)
    console.log('\n✓ Point 1: Backend Service Health Check');
    console.log('-'.repeat(60));
    await prisma.$queryRaw`SELECT 1`;
    console.log('✅ Database connection successful');
    
    // Point 2: Verify new orders are marked as isPaid=true
    console.log('\n✓ Point 2: New Order Paid Status Logic');
    console.log('-'.repeat(60));
    
    // Test with various order states
    const testOrders: Array<{ state: string; expectedPaid: boolean }> = [
      { state: 'paid', expectedPaid: true },
      { state: 'done', expectedPaid: true },
      { state: 'posted', expectedPaid: true },
      { state: 'invoiced', expectedPaid: true },
      { state: 'sale', expectedPaid: true },
      { state: 'invoice', expectedPaid: true },
      { state: 'confirmed', expectedPaid: true },
      { state: 'validated', expectedPaid: true },
      { state: 'sent', expectedPaid: true },
      { state: 'draft', expectedPaid: true }, // Should be paid (API pre-filters)
      { state: 'cancel', expectedPaid: false }, // Should NOT be paid
      { state: 'cancelled', expectedPaid: false }, // Should NOT be paid
    ];
    
    let allTestsPassed = true;
    for (const test of testOrders) {
      const mockOrder: RawOdooOrderFields = {
        id: 999999,
        name: 'TEST-ORDER',
        branch_id: [1, 'Test Branch'],
        date_order: new Date().toISOString(),
        amount_total: 100,
        state: test.state,
      };
      
      const normalized = normalizeOrderForIngestion(mockOrder);
      if (!normalized) {
        console.log(`  ❌ Failed to normalize order with state: ${test.state}`);
        allTestsPassed = false;
        continue;
      }
      
      const passed = normalized.isPaid === test.expectedPaid;
      const icon = passed ? '✅' : '❌';
      console.log(`  ${icon} State '${test.state}': isPaid=${normalized.isPaid} (expected: ${test.expectedPaid})`);
      
      if (!passed) allTestsPassed = false;
    }
    
    if (allTestsPassed) {
      console.log('\n✅ All order state tests passed!');
      console.log('   New orders are correctly marked as paid (except cancelled)');
    } else {
      console.log('\n❌ Some tests failed - review odoo-utils.ts logic');
    }
    
    // Point 3: Check skipped orders that can be re-queued
    console.log('\n✓ Point 3: Previously Skipped Orders');
    console.log('-'.repeat(60));
    
    const skippedOrdersStats = await prisma.orderSyncQueue.groupBy({
      by: ['status'],
      _count: true,
      where: {
        status: { in: [SyncStatus.SKIPPED, SyncStatus.PENDING, SyncStatus.SYNCED] },
      },
    });
    
    console.log('Order Queue Status Distribution:');
    skippedOrdersStats.forEach((stat) => {
      console.log(`  - ${stat.status}: ${stat._count} orders`);
    });
    
    const retryableSkipped = await prisma.orderSyncQueue.count({
      where: {
        status: SyncStatus.SKIPPED,
        isPaid: true,
        isCancelled: false,
      },
    });
    
    console.log(`\n${retryableSkipped > 0 ? '⚠️' : '✅'} ${retryableSkipped} skipped orders can be re-queued`);
    if (retryableSkipped > 0) {
      console.log('   Run: POST /api/v1/sync/orders/retry-skipped');
    }
    
    // Point 4: Check Oracle sync processor configuration
    console.log('\n✓ Point 4: Oracle Sync Processor Configuration');
    console.log('-'.repeat(60));
    
    // Check if SyncJob table exists and has recent jobs
    const recentJobs = await prisma.syncJob.count({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
        },
      },
    });
    
    console.log(`Recent sync jobs (last 24h): ${recentJobs}`);
    
    // Check queue stats
    const pendingOrders = await prisma.orderSyncQueue.count({
      where: { status: SyncStatus.PENDING },
    });
    
    const processingOrders = await prisma.orderSyncQueue.count({
      where: { status: SyncStatus.PROCESSING },
    });
    
    console.log(`Current queue status:`);
    console.log(`  - PENDING: ${pendingOrders}`);
    console.log(`  - PROCESSING: ${processingOrders}`);
    
    if (pendingOrders > 0 || processingOrders > 0) {
      console.log('✅ Oracle sync processor has work queued');
    } else {
      console.log('ℹ️  No orders currently queued for processing');
    }
    
    // Point 5: Check synced orders
    console.log('\n✓ Point 5: Orders Pushing to Oracle');
    console.log('-'.repeat(60));
    
    const syncedOrders = await prisma.orderSyncQueue.count({
      where: { status: SyncStatus.SYNCED },
    });
    
    const recentSynced = await prisma.orderSyncQueue.count({
      where: {
        status: SyncStatus.SYNCED,
        lastSyncAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
        },
      },
    });
    
    console.log(`Total synced orders: ${syncedOrders}`);
    console.log(`Recently synced (last 24h): ${recentSynced}`);
    
    if (recentSynced > 0) {
      console.log('✅ Orders are successfully syncing to Oracle');
    } else {
      console.log('⚠️  No orders synced in the last 24 hours');
    }
    
    // Point 6: Check for new errors in failed transactions
    console.log('\n✓ Point 6: Failed Transactions Check');
    console.log('-'.repeat(60));
    
    const failedCount = await prisma.failedTransaction.count();
    const recentFailed = await prisma.failedTransaction.count({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
        },
      },
    });
    
    console.log(`Total failed transactions: ${failedCount}`);
    console.log(`Recent failures (last 24h): ${recentFailed}`);
    
    if (recentFailed === 0) {
      console.log('✅ No new errors in failed transactions');
    } else {
      console.log(`⚠️  ${recentFailed} recent failures - review logs`);
      
      // Show sample of recent errors
      const recentErrors = await prisma.failedTransaction.findMany({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          errorType: true,
          errorMessage: true,
          createdAt: true,
        },
      });
      
      console.log('\nRecent errors:');
      recentErrors.forEach((err) => {
        console.log(`  - [${err.createdAt.toISOString()}] ${err.errorType}: ${err.errorMessage?.substring(0, 100)}`);
      });
    }
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('VERIFICATION SUMMARY');
    console.log('='.repeat(60));
    console.log('✅ Database connection working');
    console.log(`${allTestsPassed ? '✅' : '❌'} Order paid status logic verified`);
    console.log(`${retryableSkipped === 0 ? '✅' : '⚠️'} Skipped orders status: ${retryableSkipped} retryable`);
    console.log(`${pendingOrders > 0 || processingOrders > 0 ? '✅' : 'ℹ️'} Queue processor has work`);
    console.log(`${recentSynced > 0 ? '✅' : '⚠️'} Recent sync activity: ${recentSynced} orders`);
    console.log(`${recentFailed === 0 ? '✅' : '⚠️'} Recent failures: ${recentFailed}`);
    
    console.log('\n' + '='.repeat(60));
    console.log('Next Steps:');
    if (retryableSkipped > 0) {
      console.log('1. Run POST /api/v1/sync/orders/retry-skipped to re-process skipped orders');
    }
    if (recentFailed > 0) {
      console.log('2. Review failed transactions: GET /api/v1/sync/failed-transactions');
    }
    console.log('3. Monitor dashboard at http://localhost:3000/orders');
    console.log('4. Check skipped orders page at http://localhost:3000/skipped-orders');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('\n❌ Verification error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
