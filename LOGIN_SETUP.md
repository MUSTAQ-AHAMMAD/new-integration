# Login Setup Guide

## Problem Resolved ✅
The login was failing with "admin / admin" credentials because:
1. The `.env` file was missing
2. The auth controller was enforcing strict email validation

## Solution Applied

### Changes Made:
1. ✅ Created `.env` file in `packages/backend/` with admin credentials
2. ✅ Updated auth controller to accept both email and username formats
3. ✅ Set default credentials to `admin@example.com / admin`

### Current Login Credentials

You can now log in with **either** format:

**Option 1: Email format (default)**
- **Email**: `admin@example.com`
- **Password**: `admin`

**Option 2: Username format (also works now)**
- **Email**: `admin` (field name is "email" but accepts any string now)
- **Password**: `admin`

## Configuration

The admin credentials are set in `packages/backend/.env`:
```bash
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=admin
```

You can customize these values to your preference. Both email formats and simple usernames are now accepted.

## Restart Required

After updating the `.env` file, restart the backend service for changes to take effect:
```bash
# If running with docker-compose
docker-compose restart backend

# If running with npm/pnpm
cd packages/backend
pnpm run dev
```

## Security Recommendations

For production environments:
- ⚠️ Change the default password to something strong (at least 12 characters)
- ⚠️ Use a real admin email address
- ⚠️ Set a secure JWT_SECRET (64+ random characters)
- ⚠️ Update the ADMIN_PASSWORD environment variable immediately

Example secure configuration:
```bash
ADMIN_EMAIL=admin@yourcompany.com
ADMIN_PASSWORD=YourSecureP@ssw0rd!2024
JWT_SECRET=a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2
```

## Testing

1. Navigate to the dashboard login page (usually `http://localhost:3000/login`)
2. Enter: `admin@example.com` (or just `admin`)
3. Password: `admin`
4. Click "Sign in"

You should now be logged in successfully!

