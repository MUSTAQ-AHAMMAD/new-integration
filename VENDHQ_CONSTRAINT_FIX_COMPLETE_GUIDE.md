# VendHqItemMeta Unique Constraint Fix - Complete Guide

## Problem
You're getting this error when trying to push your Prisma schema:
```
⚠️  There might be data loss when applying the changes:
  • A unique constraint covering the columns `[itemId,region]` on the table `VendHqItemMeta` will be added. 
    If there are existing duplicate values, this will fail.
```

## Root Cause
The `VendHqItemMeta` table has duplicate records with the same `itemId + region` combination. 
The Prisma schema defines a unique constraint on these columns, but the database contains duplicates.

## Solution

There are **2 methods** to fix this:

### Method 1: Use the Existing Cleanup Script (Recommended)

This method uses the cleanup script that's already in the codebase.

#### Steps:

1. **Navigate to the backend directory:**
   ```bash
   cd packages/backend
   ```

2. **Ensure dependencies are installed:**
   ```bash
   npm install --legacy-peer-deps
   # or
   pnpm install
   ```

3. **Generate Prisma client:**
   ```bash
   npm run db:generate
   ```

4. **Run the duplicate cleanup script:**
   ```bash
   npm run db:clean-duplicates
   ```
   
   This will:
   - Find all duplicate `VendHqItemMeta` records (grouped by `itemId + region`)
   - Keep the most recent record for each combination (by `updatedAt` timestamp)
   - Delete all older duplicates
   - Show you exactly how many duplicates were removed

5. **Push the schema to apply the unique constraint:**
   ```bash
   npm run db:push
   ```

6. **Verify the fix:**
   ```bash
   npm run build
   ```

### Method 2: Use the Migration (Alternative)

This method applies a database migration that automatically cleans up duplicates.

#### Steps:

1. **Navigate to the backend directory:**
   ```bash
   cd packages/backend
   ```

2. **Run the migration:**
   ```bash
   npm run db:migrate:deploy
   ```
   
   The migration will:
   - Identify and keep the most recent record for each `itemId + region` pair
   - Delete all older duplicates
   - Add the unique constraint safely

3. **Verify the build:**
   ```bash
   npm run build
   ```

## What Was Fixed

1. **Created cleanup script**: `src/scripts/remove-vendhq-item-meta-duplicates.ts`
   - Available via `npm run db:clean-duplicates` command
   - Safely removes duplicates while keeping the most recent data

2. **Created migration**: `prisma/migrations/20260627161300_add_vendhq_item_meta_unique_constraint/`
   - Automates the cleanup process
   - Can be run as part of regular deployment

3. **Schema constraint**: The `@@unique([itemId, region])` constraint ensures:
   - No future duplicates can be created
   - Each item can only have one metadata record per region

## Prevention

To prevent this issue from happening again, the application code should use **upsert** operations instead of separate find + create:

```typescript
// ✅ Good - prevents race conditions
await prisma.vendHqItemMeta.upsert({
  where: {
    itemId_region: { itemId: item.id, region: 'AE' }
  },
  create: { ...itemData },
  update: { ...itemData }
});

// ❌ Bad - can create duplicates in concurrent scenarios
const existing = await prisma.vendHqItemMeta.findFirst({
  where: { itemId: item.id, region: 'AE' }
});
if (existing) {
  await prisma.vendHqItemMeta.update({ ... });
} else {
  await prisma.vendHqItemMeta.create({ ... });
}
```

## Troubleshooting

### Error: "prisma command not found"
```bash
npm install --legacy-peer-deps
```

### Error: "Cannot connect to database"
Make sure your database is running:
```bash
# If using Docker Compose:
docker compose up -d postgres

# Check database status:
docker compose ps
```

### Error: "DATABASE_URL environment variable not set"
Create a `.env` file in `packages/backend/` with:
```env
DATABASE_URL="******localhost:5432/integration_db"
DIRECT_DATABASE_URL="******localhost:5432/integration_db"
```

### Want to see duplicates before deletion?
Run this SQL query:
```sql
SELECT "itemId", region, COUNT(*) as count
FROM "VendHqItemMeta"
GROUP BY "itemId", region
HAVING COUNT(*) > 1
ORDER BY count DESC;
```

## Build Verification

After fixing the duplicates, verify everything works:

```bash
# 1. Run tests (if available)
npm test

# 2. Build the application
npm run build

# 3. Try another db:push to confirm no errors
npm run db:push
```

Expected output:
```
✅ The database is already in sync with the Prisma schema.
```

## Summary

✅ **Quick Fix**: Run `npm run db:clean-duplicates` then `npm run db:push`
✅ **Migration**: Run `npm run db:migrate:deploy`  
✅ **Prevention**: Use upsert operations in application code
✅ **Verification**: Run `npm run build` to confirm

## Need Help?

If you encounter any issues:
1. Check database connection in `.env` file
2. Ensure database is running (`docker compose ps`)
3. Verify Prisma client is generated (`npm run db:generate`)
4. Review logs for specific error messages

For more details, see:
- `VENDHQ_DUPLICATES_QUICK_FIX.md`
- `docs/VENDHQ_ITEM_META_DUPLICATES_FIX.md` (if exists)
