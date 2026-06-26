#!/usr/bin/env ts-node
/**
 * Diagnostic script for Order 160909 sync issue
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/diagnose-order-160909.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('='.repeat(80));
  console.log('ORDER 160909 DIAGNOSTIC REPORT');
  console.log('='.repeat(80));
  console.log();

  // 1. Check OrderSyncQueue
  console.log('1. CHECKING ORDER SYNC QUEUE...');
  const queueEntries = await prisma.orderSyncQueue.findMany({
    where: { odooOrderId: '160909' },
  });

  if (queueEntries.length === 0) {
    console.log('❌ Order 160909 NOT FOUND in OrderSyncQueue');
    console.log('   This order has not been ingested yet.');
    console.log('   RECOMMENDATION: Run POST /odoo-backup/fetch-orders or POST /ibq-backup/fetch-orders');
    console.log();
    
    // Check backup tables
    console.log('2. CHECKING BACKUP TABLES...');
    const backupOdoo = await prisma.backupOdooOrder.findFirst({
      where: { orderId: 160909 },
      orderBy: { fetchedAt: 'desc' },
    });
    
    const backupIbq = await prisma.backupIbqOrder.findFirst({
      where: { orderId: 160909 },
      orderBy: { fetchedAt: 'desc' },
    });
    
    if (backupOdoo) {
      console.log('✅ Found in BackupOdooOrder:');
      console.log(`   Order ID: ${backupOdoo.orderId}`);
      console.log(`   Order Name: ${backupOdoo.orderName}`);
      console.log(`   State: ${backupOdoo.state}`);
      console.log(`   Amount: ${backupOdoo.amountTotal}`);
      console.log(`   Date: ${backupOdoo.dateOrder}`);
      console.log(`   Branch ID: ${JSON.stringify(backupOdoo.branchId)}`);
      console.log(`   Fetched At: ${backupOdoo.fetchedAt}`);
      console.log();
      console.log('   RECOMMENDATION: Re-ingest from backup using POST /odoo-backup/reingest-from-backup');
    } else if (backupIbq) {
      console.log('✅ Found in BackupIbqOrder:');
      console.log(`   Order ID: ${backupIbq.orderId}`);
      console.log(`   Order Name: ${backupIbq.orderName}`);
      console.log(`   State: ${backupIbq.state}`);
      console.log(`   Amount: ${backupIbq.amountTotal}`);
      console.log(`   Date: ${backupIbq.dateOrder}`);
      console.log(`   Branch ID: ${JSON.stringify(backupIbq.branchId)}`);
      console.log(`   Fetched At: ${backupIbq.fetchedAt}`);
      console.log();
      console.log('   RECOMMENDATION: Re-ingest from backup using POST /ibq-backup/reingest-from-backup');
    } else {
      console.log('❌ Order 160909 NOT FOUND in backup tables either');
      console.log('   RECOMMENDATION: Fetch from source system (Odoo/IBQ)');
    }
  } else {
    console.log(`✅ Found ${queueEntries.length} entry(ies) in OrderSyncQueue\n`);
    
    for (const entry of queueEntries) {
      console.log('-'.repeat(80));
      console.log(`ENTRY: Order ${entry.odooOrderNumber} / Branch ${entry.branchCode}`);
      console.log('-'.repeat(80));
      console.log(`Status: ${entry.status}`);
      console.log(`isPaid: ${entry.isPaid}`);
      console.log(`isCancelled: ${entry.isCancelled}`);
      console.log(`isRefund: ${entry.isRefund}`);
      console.log(`Total Amount: ${entry.totalAmount}`);
      console.log(`Currency: ${entry.currency}`);
      console.log(`Region: ${entry.region}`);
      console.log(`Negative Inventory: ${entry.negativeInventoryFlag}`);
      console.log(`Sync Attempts: ${entry.syncAttempts}`);
      console.log(`Last Sync: ${entry.lastSyncAt}`);
      console.log(`Created: ${entry.createdAt}`);
      console.log(`Updated: ${entry.updatedAt}`);
      
      if (entry.validationErrors) {
        console.log(`Validation Errors: ${JSON.stringify(entry.validationErrors, null, 2)}`);
      }
      
      console.log();

      // Analyze the issue
      console.log('ANALYSIS:');
      if (entry.status === 'SKIPPED') {
        console.log('❌ Order was SKIPPED');
        
        if (!entry.isPaid) {
          console.log('   Reason: Order is not marked as paid');
          
          // Check backup for state
          if (entry.odooBackupOrderId) {
            const backup = await prisma.backupOdooOrder.findUnique({
              where: { id: entry.odooBackupOrderId },
            });
            
            if (backup) {
              console.log(`   Source State: "${backup.state}"`);
              console.log(`   Amount Total: ${backup.amountTotal}`);
              
              // Check if state is in paid states
              const PAID_STATES = ['paid', 'done', 'posted', 'invoiced', 'sale', 'invoice', 
                                    'confirmed', 'validated', 'sent', 'open', 'to invoice', 
                                    'to_invoice', 'progress', 'in_payment', 'in payment', 
                                    'processing', 'complete', 'completed', 'closed', 
                                    'finalized', 'finalised'];
              const state = (backup.state || '').toLowerCase().trim();
              
              if (PAID_STATES.includes(state)) {
                console.log('   ✅ State IS in supported paid states list');
                console.log('   🐛 BUG: Payment detection may have failed during ingestion');
              } else {
                console.log(`   ❌ State "${backup.state}" is NOT in supported paid states`);
                console.log('   RECOMMENDATION: Check if this state should be considered paid');
                console.log('   If yes, it may need to be added to PAID_ORDER_STATES in odoo-utils.ts');
              }
              
              // Check for payment data in rawJson
              const rawData = backup.rawJson as any;
              if (rawData?.statement_ids) {
                console.log(`   Payment Data (statement_ids): ${JSON.stringify(rawData.statement_ids)}`);
              }
              if (rawData?.payment_ids) {
                console.log(`   Payment Data (payment_ids): ${JSON.stringify(rawData.payment_ids)}`);
              }
            }
          }
        }
        
        if (entry.isCancelled) {
          console.log('   Reason: Order is cancelled');
          console.log('   RECOMMENDATION: Cancelled orders are intentionally skipped');
        }
        
        console.log();
        console.log('REMEDIATION:');
        if (!entry.isPaid && !entry.isCancelled) {
          console.log('   1. Use the diagnose endpoint: GET /sync/orders/160909/diagnose');
          console.log('   2. If the order should be paid, use: POST /sync/orders/retry-skipped');
          console.log('   3. Or re-ingest from backup: POST /odoo-backup/reingest-from-backup');
        }
      } else if (entry.status === 'PENDING') {
        console.log('✅ Order is PENDING - waiting to be processed');
        console.log('   Check if queue workers are running');
      } else if (entry.status === 'SYNCED') {
        console.log('✅ Order was successfully synced to Oracle');
      } else if (entry.status === 'FAILED') {
        console.log('❌ Order FAILED during sync');
        console.log('   Check FailedTransaction table for details');
      }
      
      console.log();
      
      // Check store configuration
      console.log('STORE CONFIGURATION CHECK:');
      const storeConfig = await prisma.storeConfiguration.findUnique({
        where: { branchCode: entry.branchCode },
      });
      
      if (!storeConfig) {
        console.log(`❌ No store configuration found for branch ${entry.branchCode}`);
      } else {
        console.log(`✅ Store configuration exists`);
        console.log(`   Branch Name: ${storeConfig.branchName}`);
        console.log(`   Active: ${storeConfig.isActive}`);
        console.log(`   Validation Status: ${storeConfig.validationStatus}`);
        
        if (!storeConfig.isActive) {
          console.log(`   ⚠️ WARNING: Store is INACTIVE`);
        }
        if (storeConfig.validationStatus === 'INVALID') {
          console.log(`   ⚠️ WARNING: Store configuration is INVALID`);
        }
      }
      
      console.log();
    }
  }

  console.log('='.repeat(80));
  console.log('DIAGNOSTIC COMPLETE');
  console.log('='.repeat(80));
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
