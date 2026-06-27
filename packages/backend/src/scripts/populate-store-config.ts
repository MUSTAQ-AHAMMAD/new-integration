/**
 * populate-store-config.ts
 *
 * Option B: Populate StoreConfiguration for All Branches
 *
 * This script creates StoreConfiguration records for all unique branches
 * found in the backup order tables (BackupOdooOrder and BackupIbqOrder).
 *
 * It maps:
 * - BackupOdooOrder.branchId → StoreConfiguration.odooBranchId + branchCode
 * - BackupOdooOrder.branchName → StoreConfiguration.branchName
 * - FusionSalesMetadata (matched by region) → Oracle configuration fields
 *
 * Usage:
 *   # From packages/backend directory:
 *   pnpm build
 *   node dist/scripts/populate-store-config.js
 *
 *   # Or with ts-node:
 *   npx ts-node src/scripts/populate-store-config.ts
 */

import { PrismaClient, ValidationStatus } from '@prisma/client';

interface BranchInfo {
  branchId: number;
  branchName: string | null;
  region: string | null;
  orderCount: number;
}

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log('════════════════════════════════════════');
    console.log('  Populate StoreConfiguration Script');
    console.log('  Option B: All Branches');
    console.log('════════════════════════════════════════\n');

    // ── Step 1: Get unique branches from BackupOdooOrder ──────────────────────
    console.log('Step 1: Analyzing BackupOdooOrder for unique branches...\n');

    const odooBranches = await prisma.$queryRaw<BranchInfo[]>`
      SELECT 
        "branchId"::int as "branchId",
        MAX("branchName") as "branchName",
        MAX(region) as region,
        COUNT(*)::int as "orderCount"
      FROM "BackupOdooOrder"
      WHERE "branchId" IS NOT NULL
      GROUP BY "branchId"
      ORDER BY "orderCount" DESC, "branchId"
    `;

    console.log(`Found ${odooBranches.length} unique branches in BackupOdooOrder:`);
    for (const branch of odooBranches) {
      console.log(
        `  - Branch ${branch.branchId}: ${branch.branchName || 'N/A'} ` +
          `(${branch.region || 'no region'}, ${branch.orderCount} orders)`,
      );
    }
    console.log();

    // ── Step 2: Get unique branches from BackupIbqOrder ───────────────────────
    console.log('Step 2: Analyzing BackupIbqOrder for unique branches...\n');

    const ibqBranches = await prisma.$queryRaw<BranchInfo[]>`
      SELECT 
        "branchId"::int as "branchId",
        MAX("branchName") as "branchName",
        MAX(region) as region,
        COUNT(*)::int as "orderCount"
      FROM "BackupIbqOrder"
      WHERE "branchId" IS NOT NULL
      GROUP BY "branchId"
      ORDER BY "orderCount" DESC, "branchId"
    `;

    console.log(
      `Found ${ibqBranches.length} unique branches in BackupIbqOrder:`,
    );
    for (const branch of ibqBranches) {
      console.log(
        `  - Branch ${branch.branchId}: ${branch.branchName || 'N/A'} ` +
          `(${branch.region || 'no region'}, ${branch.orderCount} orders)`,
      );
    }
    console.log();

    // ── Step 3: Merge and deduplicate branches ────────────────────────────────
    const branchMap = new Map<number, BranchInfo>();

    for (const branch of [...odooBranches, ...ibqBranches]) {
      const existing = branchMap.get(branch.branchId);
      if (!existing) {
        branchMap.set(branch.branchId, branch);
      } else {
        // Merge: prefer non-null values, sum order counts
        branchMap.set(branch.branchId, {
          branchId: branch.branchId,
          branchName: existing.branchName || branch.branchName,
          region: existing.region || branch.region,
          orderCount: existing.orderCount + branch.orderCount,
        });
      }
    }

    const allBranches = Array.from(branchMap.values()).sort(
      (a, b) => b.orderCount - a.orderCount,
    );

    console.log(`Step 3: Combined unique branches: ${allBranches.length}\n`);

    // ── Step 4: Get FusionSalesMetadata records ───────────────────────────────
    console.log('Step 4: Loading FusionSalesMetadata for Oracle config...\n');

    const fusionMetadata = await prisma.fusionSalesMetadata.findMany({
      orderBy: { billToName: 'asc' },
    });

    console.log(`Found ${fusionMetadata.length} FusionSalesMetadata records\n`);

    if (fusionMetadata.length === 0) {
      console.warn(
        '⚠ WARNING: No FusionSalesMetadata records found!\n' +
          '  You must populate FusionSalesMetadata first before running this script.\n' +
          '  Use: pnpm seed:csv data/fusion-sales-metadata.csv\n',
      );
      process.exit(1);
    }

    // ── Step 5: Create StoreConfiguration for each branch ─────────────────────
    console.log('Step 5: Creating StoreConfiguration records...\n');

    let created = 0;
    let skipped = 0;
    let updated = 0;

    for (const branch of allBranches) {
      const branchCode = String(branch.branchId);

      // Check if config already exists
      const existing = await prisma.storeConfiguration.findUnique({
        where: { branchCode },
      });

      if (existing) {
        console.log(
          `  ✓ Branch ${branchCode} (${branch.branchName || 'N/A'}): ` +
            `already configured, skipping`,
        );
        skipped++;
        continue;
      }

      // Find matching FusionSalesMetadata by region
      // Prefer exact region match, fall back to first available
      const metadata =
        fusionMetadata.find(
          (m) => branch.region && m.region === branch.region,
        ) ||
        fusionMetadata.find((m) => m.region === 'AE') || // Default to AE region
        fusionMetadata[0]; // Last resort: first record

      if (!metadata) {
        console.warn(
          `  ⚠ Branch ${branchCode}: no FusionSalesMetadata found, skipping`,
        );
        skipped++;
        continue;
      }

      // Create StoreConfiguration
      try {
        await prisma.storeConfiguration.create({
          data: {
            branchCode,
            branchName: branch.branchName || `Branch ${branchCode}`,
            odooBranchId: BigInt(branch.branchId),
            oracleOperatingUnitId: metadata.billToAccount,
            oracleBusinessUnit: metadata.businessUnit,
            billToSiteName: metadata.billToName,
            billToLocation: metadata.siteNumber || undefined,
            // Use FusionSalesMetadata fields if available
            bankAccountName: `BANK_${metadata.region}`,
            cashAccountName: `CASH_${metadata.region}`,
            paymentTermsName: 'IMMEDIATE',
            taxClassificationCode: undefined,
            transactionSource: metadata.txnSource,
            transactionType: metadata.txnType,
            invoiceCurrencyCode: 'AED',
            region: branch.region || metadata.region,
            isActive: true,
            validationStatus: ValidationStatus.PENDING,
            createdBy: 'SYSTEM_POPULATE_SCRIPT',
          },
        });

        console.log(
          `  ✓ Branch ${branchCode} (${branch.branchName || 'N/A'}): ` +
            `created using ${metadata.billToName} (${metadata.region})`,
        );
        created++;
      } catch (err) {
        console.error(
          `  ✗ Branch ${branchCode}: failed to create - ${err instanceof Error ? err.message : String(err)}`,
        );
        skipped++;
      }
    }

    console.log('\n════════════════════════════════════════');
    console.log('Summary:');
    console.log(`  Total branches found:     ${allBranches.length}`);
    console.log(`  Created:                  ${created}`);
    console.log(`  Skipped (already exists): ${skipped}`);
    console.log(`  Updated:                  ${updated}`);
    console.log('════════════════════════════════════════\n');

    if (created > 0) {
      console.log('✓ StoreConfiguration records created successfully!\n');
      console.log('Next steps:');
      console.log('  1. Review the created configurations in the admin UI');
      console.log('  2. Update bankAccountName and cashAccountName with actual values');
      console.log(
        '  3. Validate each configuration: POST /store-config/:branchCode/validate',
      );
      console.log(
        '  4. Mark configurations as active after validation completes\n',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('\n✗ Error:', err);
  process.exit(1);
});
