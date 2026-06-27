# VendHqItemMeta Duplicate Records Fix

## Problem
When running `prisma db push`, you may encounter an error:

```
⚠️  There might be data loss when applying the changes:
  • A unique constraint covering the columns `[itemId,region]` on the table `VendHqItemMeta` will be added. If there are existing duplicate values, this will fail.

Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
```

This error occurs because:
1. The Prisma schema defines a unique constraint on `[itemId, region]` for the `VendHqItemMeta` model
2. The database contains duplicate records that violate this constraint
3. Prisma cannot apply the constraint until the duplicates are removed

## Solution

We've created a script that automatically removes duplicate records while keeping the most recent one for each `itemId + region` combination.

### Steps to Fix

1. **Run the duplicate cleanup script:**
   ```bash
   cd packages/backend
   pnpm db:clean-duplicates
   ```

   This script will:
   - Find all duplicate `VendHqItemMeta` records grouped by `itemId + region`
   - For each group, keep the most recent record (by `updatedAt`, then `createdAt`, then `id`)
   - Delete all older duplicate records

2. **After cleaning, push the schema:**
   ```bash
   pnpm db:push
   ```

   The push should now succeed since all duplicates have been removed.

### What the Script Does

The script (`src/scripts/remove-vendhq-item-meta-duplicates.ts`):
- Queries the database to find duplicate records
- Sorts records by `updatedAt DESC`, `createdAt DESC`, `id DESC`
- Keeps the first (most recent) record
- Deletes all other duplicates
- Reports the number of records removed

### Manual Cleanup (Alternative)

If you prefer to clean up duplicates manually, you can use this SQL query:

```sql
WITH duplicates AS (
  SELECT 
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "itemId", region 
      ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    ) AS row_num
  FROM "VendHqItemMeta"
)
DELETE FROM "VendHqItemMeta"
WHERE id IN (
  SELECT id FROM duplicates WHERE row_num > 1
);
```

## Prevention

To prevent duplicate records in the future, always use upsert operations when creating/updating `VendHqItemMeta` records:

```typescript
await prisma.vendHqItemMeta.upsert({
  where: {
    itemId_region: {
      itemId: 'some-item-id',
      region: 'AE',
    },
  },
  create: {
    // create data
  },
  update: {
    // update data
  },
});
```

The `@@unique([itemId, region])` constraint ensures this combination is unique at the database level.
