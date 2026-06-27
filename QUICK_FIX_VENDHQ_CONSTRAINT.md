# Quick Fix for VendHqItemMeta Unique Constraint Error

## The Problem
```
⚠️ A unique constraint covering the columns [itemId,region] on the table VendHqItemMeta will be added. 
If there are existing duplicate values, this will fail.
```

## Quick Solution (3 Steps)

### Step 1: Clean Duplicates
```bash
cd packages/backend
npm run db:clean-duplicates
```

### Step 2: Apply Schema
```bash
npm run db:push
```

### Step 3: Verify Build
```bash
npm run build
```

## That's It! ✅

The cleanup script will:
- Find all duplicate records (same itemId + region)
- Keep the most recent record (by updatedAt timestamp)
- Delete all older duplicates
- Show you how many records were removed

After cleanup, the unique constraint will apply successfully.

## Alternative: Use Migration

If you prefer to use migrations:
```bash
cd packages/backend
npm run db:migrate:deploy
```

The migration automatically cleans duplicates and adds the constraint.

## Troubleshooting

**Database not running?**
```bash
docker compose up -d postgres
```

**Dependencies not installed?**
```bash
npm install --legacy-peer-deps
```

**Need to regenerate Prisma client?**
```bash
npm run db:generate
```

## For More Details

See `VENDHQ_CONSTRAINT_FIX_COMPLETE_GUIDE.md` for the complete guide with troubleshooting and prevention tips.
