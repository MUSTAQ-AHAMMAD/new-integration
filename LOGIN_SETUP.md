# Login Setup Guide

## Problem
The login was failing with "admin / admin" credentials because:
1. The `.env` file was missing
2. The system requires a valid **email address** format (not just "admin")

## Solution

The backend `.env` file has been created with admin credentials. You have two options:

### Option 1: Use "admin" as email (requires code change)
Current setup in `.env`:
```bash
ADMIN_EMAIL=admin
ADMIN_PASSWORD=admin
```

To make this work, you need to remove the email validation from the auth controller.

### Option 2: Use a valid email format (recommended)
Update the `.env` file to use a valid email:
```bash
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=admin
```

Then log in with:
- **Email**: `admin@example.com`
- **Password**: `admin`

## Quick Fix

To apply the recommended fix (Option 2), run:
```bash
cd packages/backend
# Edit .env file
sed -i 's/ADMIN_EMAIL=admin$/ADMIN_EMAIL=admin@example.com/' .env
```

Or manually edit `packages/backend/.env` and change:
```
ADMIN_EMAIL=admin
```
to:
```
ADMIN_EMAIL=admin@example.com
```

## Restart Required

After updating the `.env` file, restart the backend service for changes to take effect:
```bash
# If running with docker-compose
docker-compose restart backend

# If running with npm/pnpm
cd packages/backend
pnpm run dev
```

## Security Note

For production environments:
- Change the default password to something strong
- Use a real admin email address
- Set a secure JWT_SECRET (64+ random characters)
