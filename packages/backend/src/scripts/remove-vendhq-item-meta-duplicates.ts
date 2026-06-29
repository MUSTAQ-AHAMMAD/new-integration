import { PrismaClient } from '@prisma/client';

/**
 * Script to remove duplicate VendHqItemMeta records before applying unique constraint.
 * Keeps the most recent record (by updatedAt) for each itemId + region combination.
 */
async function removeDuplicates() {
  const prisma = new PrismaClient();

  try {
    console.log('🔍 Finding duplicate VendHqItemMeta records...');

    // Find all duplicates grouped by itemId + region
    const duplicates = await prisma.$queryRaw<
      Array<{ itemId: string; region: string; count: bigint }>
    >`
      SELECT "itemId", region, COUNT(*) as count
      FROM "VendHqItemMeta"
      GROUP BY "itemId", region
      HAVING COUNT(*) > 1
    `;

    if (duplicates.length === 0) {
      console.log('✅ No duplicates found. Database is clean.');
      return;
    }

    console.log(`⚠️  Found ${duplicates.length} duplicate groups.`);

    let totalRecordsDeleted = 0;

    // For each duplicate group, delete all but the most recent record
    for (const dup of duplicates) {
      const { itemId, region } = dup;

      // Get all records for this itemId + region, ordered by updatedAt DESC
      const records = await prisma.vendHqItemMeta.findMany({
        where: { itemId, region },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      });

      // Keep the first (most recent) record, delete the rest
      const recordsToDelete = records.slice(1);

      console.log(
        `  Deleting ${recordsToDelete.length} duplicate(s) for itemId=${itemId}, region=${region}`,
      );

      for (const record of recordsToDelete) {
        await prisma.vendHqItemMeta.delete({
          where: { id: record.id },
        });
        totalRecordsDeleted++;
      }
    }

    console.log(
      `\n✅ Successfully removed ${totalRecordsDeleted} duplicate records.`,
    );
    console.log('You can now run: pnpm db:push');
  } catch (error) {
    console.error('❌ Error removing duplicates:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

removeDuplicates()
  .then(() => {
    console.log('\n✅ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
