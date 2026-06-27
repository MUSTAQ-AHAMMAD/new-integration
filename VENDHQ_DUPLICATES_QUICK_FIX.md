# Quick Fix for Prisma Push Error

## The Error
```
⚠️  There might be data loss when applying the changes:
  • A unique constraint covering the columns `[itemId,region]` on the table `VendHqItemMeta` will be added. If there are existing duplicate values, this will fail.

Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
```

## Quick Solution

**DO NOT use `--accept-data-loss` flag!** Instead, follow these steps:

### Step 1: Install dependencies (if needed)
```bash
cd packages/backend
npm install
# or if you have pnpm@9 installed
pnpm install
```

### Step 2: Clean duplicate records
```bash
cd packages/backend
pnpm db:clean-duplicates
```

This script will:
- Find all duplicate VendHqItemMeta records
- Keep the most recent record for each `itemId + region` combination
- Delete all older duplicates

### Step 3: Push the schema
```bash
pnpm db:push
```

The push should now succeed! ✅

## What Was Fixed

1. **Created a cleanup script** (`src/scripts/remove-vendhq-item-meta-duplicates.ts`)
   - Removes all duplicate records automatically
   - Available via `pnpm db:clean-duplicates` command

2. **Fixed the root cause** 
   - Updated `item-sync.service.ts` to use `upsert` instead of `findFirst` + `create`/`update`
   - This prevents race conditions that can create duplicates

3. **Documentation**
   - See `docs/VENDHQ_ITEM_META_DUPLICATES_FIX.md` for detailed information

## Need Help?

If you encounter any issues:
1. Check the database connection in `.env` file
2. Make sure you have the correct DATABASE_URL
3. Run `prisma generate` if you haven't already
4. Review the full documentation in `docs/VENDHQ_ITEM_META_DUPLICATES_FIX.md`
