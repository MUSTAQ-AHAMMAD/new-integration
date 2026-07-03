/**
 * Script to populate missing bank/cash account IDs in StoreConfiguration
 * 
 * This script reads VendHqRegister data by region and updates all
 * StoreConfiguration records that have null bankAccountId or cashAccountId.
 * 
 * Usage:
 *   npx ts-node src/scripts/populate-bank-cash-accounts.ts
 * 
 * Or via pnpm:
 *   pnpm populate:bank-cash-accounts
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { StoreConfigService } from '../store-config/store-config.service';
import { Logger } from '@nestjs/common';

async function main() {
  const logger = new Logger('PopulateBankCashAccounts');
  
  logger.log('🚀 Starting bank/cash account ID population script');
  logger.log('═══════════════════════════════════════════════════');

  // Create a minimal NestJS application context
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const storeConfigService = app.get(StoreConfigService);

    logger.log('\n📊 Analyzing store configurations...\n');
    
    const result = await storeConfigService.populateBankCashAccountIds();

    logger.log('\n✅ Population complete!');
    logger.log('═══════════════════════════════════════════════════');
    logger.log(`📈 Summary:`);
    logger.log(`   Total stores processed: ${result.totalStores}`);
    logger.log(`   ✅ Updated: ${result.updated}`);
    logger.log(`   ⏭️  Skipped: ${result.skipped}`);
    logger.log(`   ❌ Errors: ${result.errors.length}`);

    if (result.errors.length > 0) {
      logger.warn('\n⚠️  Errors encountered:');
      result.errors.forEach((error, i) => {
        logger.warn(`   ${i + 1}. ${error}`);
      });
    }

    if (result.updated === 0 && result.skipped === 0) {
      logger.log('\n✨ All store configurations already have account IDs!');
    } else if (result.updated > 0) {
      logger.log('\n💡 Next steps:');
      logger.log('   1. Verify the updated configurations in the dashboard');
      logger.log('   2. Run validation: POST /store-config/{branchCode}/validate');
      logger.log('   3. Test receipt creation with a sample order');
    }

  } catch (error) {
    logger.error('\n❌ Script failed with error:');
    logger.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      logger.error(error.stack);
    }
    process.exit(1);
  } finally {
    await app.close();
  }

  logger.log('\n👋 Script complete. Exiting...\n');
}

// Run the script
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
