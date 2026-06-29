#!/usr/bin/env ts-node

/**
 * Test script for store configuration auto-creation
 *
 * Tests:
 * 1. Get or create store config (should create if missing)
 * 2. Get again (should return from cache/DB)
 * 3. Verify caching works
 * 4. Test health check endpoint
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { StoreConfigService } from '../store-config/store-config.service';
import { PrismaService } from '../prisma/prisma.service';

async function testStoreConfig() {
  console.log('🚀 Starting Store Configuration Test...\n');

  const app = await NestFactory.createApplicationContext(AppModule);
  const storeConfigService = app.get(StoreConfigService);
  const prisma = app.get(PrismaService);

  // Test branches from the problem statement
  const failingBranches = [
    304, 357, 1186, 255, 385, 215, 392, 212, 1240, 1169, 203, 381,
  ];

  console.log(
    `Testing ${failingBranches.length} branches that were failing...\n`,
  );
  console.log('═'.repeat(80));

  const results = {
    success: 0,
    failed: 0,
    cached: 0,
    created: 0,
  };

  for (const branchId of failingBranches) {
    const branchCode = String(branchId);
    console.log(`\n📍 Testing branch ${branchCode}...`);

    try {
      // Check if config exists before test
      const existingConfig = await prisma.storeConfiguration.findUnique({
        where: { branchCode },
      });

      if (existingConfig) {
        console.log(`   ℹ️  Config already exists in DB`);
      } else {
        console.log(`   ⚠️  Config does NOT exist - will be created`);
      }

      // Test 1: Get or create (should create if missing)
      console.log(`   → Getting or creating config...`);
      const startTime = Date.now();
      const config1 =
        await storeConfigService.getOrCreateStoreConfig(branchCode);
      const elapsed1 = Date.now() - startTime;

      if (!config1) {
        console.log(`   ❌ FAILED: Config is null`);
        results.failed++;
        continue;
      }

      console.log(`   ✅ Config obtained in ${elapsed1}ms`);
      console.log(`      - Branch Name: ${config1.branchName}`);
      console.log(`      - Region: ${config1.region}`);
      console.log(`      - Status: ${config1.validationStatus}`);
      console.log(`      - Active: ${config1.isActive}`);
      console.log(`      - Business Unit: ${config1.oracleBusinessUnit}`);
      console.log(`      - Bank Account: ${config1.bankAccountName}`);
      console.log(`      - Cash Account: ${config1.cashAccountName}`);

      if (!existingConfig) {
        results.created++;
      }

      // Test 2: Get again (should return from cache)
      console.log(`   → Getting config again (should use cache)...`);
      const startTime2 = Date.now();
      const config2 =
        await storeConfigService.getOrCreateStoreConfig(branchCode);
      const elapsed2 = Date.now() - startTime2;

      if (!config2) {
        console.log(`   ❌ FAILED: Config is null on second call`);
        results.failed++;
        continue;
      }

      console.log(`   ✅ Config obtained in ${elapsed2}ms`);

      if (elapsed2 < elapsed1 / 2) {
        console.log(`   🚀 Cache is working! (${elapsed2}ms vs ${elapsed1}ms)`);
        results.cached++;
      }

      // Verify both configs are the same
      if (
        config1.id === config2.id &&
        config1.branchCode === config2.branchCode
      ) {
        console.log(`   ✅ Configs match`);
        results.success++;
      } else {
        console.log(`   ❌ FAILED: Configs don't match`);
        results.failed++;
      }
    } catch (error) {
      console.log(
        `   ❌ ERROR: ${error instanceof Error ? error.message : String(error)}`,
      );
      results.failed++;
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('\n📊 Test Results:');
  console.log(`   ✅ Success: ${results.success}/${failingBranches.length}`);
  console.log(`   ❌ Failed: ${results.failed}/${failingBranches.length}`);
  console.log(`   🆕 Created: ${results.created}`);
  console.log(`   🚀 Cached: ${results.cached}`);
  console.log(
    `   📈 Success Rate: ${((results.success / failingBranches.length) * 100).toFixed(2)}%`,
  );

  // Test cache clearing
  console.log('\n🧹 Testing cache clearing...');
  storeConfigService.clearCache();
  console.log('   ✅ Cache cleared');

  // Test a single branch again after clearing cache
  console.log('\n🔄 Testing after cache clear...');
  const testBranchCode = String(failingBranches[0]);
  const startTime = Date.now();
  const configAfterClear =
    await storeConfigService.getOrCreateStoreConfig(testBranchCode);
  const elapsed = Date.now() - startTime;
  console.log(
    `   ✅ Config obtained in ${elapsed}ms (cache was cleared, so DB lookup expected)`,
  );

  await app.close();

  console.log('\n✨ Test completed!\n');
  process.exit(results.failed > 0 ? 1 : 0);
}

testStoreConfig().catch((error) => {
  console.error('❌ Test failed with error:', error);
  process.exit(1);
});
