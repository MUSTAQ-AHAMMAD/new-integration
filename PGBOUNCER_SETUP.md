# PgBouncer Configuration Guide

## Overview

By default, the development environment **bypasses PgBouncer** and connects directly to PostgreSQL. This simplifies setup and avoids connection pooling issues during development.

PgBouncer is still available as an **optional service** for those who want to test with connection pooling enabled.

## Default Setup (No PgBouncer)

All services connect directly to `postgres:5432`:

```bash
docker compose up -d
```

This will start:
- PostgreSQL (port 5432)
- Backend → connects to postgres:5432
- Worker → connects to postgres:5432
- Redis and other services

**PgBouncer is NOT started by default.**

## Using PgBouncer (Optional)

If you want to enable PgBouncer for testing:

### Step 1: Start PgBouncer with the profile

```bash
docker compose --profile pgbouncer up -d
```

This will start PgBouncer on port 5433.

### Step 2: Update environment variables

You need to manually update the DATABASE_URL in your services to use PgBouncer:

**Option A: Update docker-compose.yml (recommended for testing)**

In `docker-compose.yml`, change the DATABASE_URL for each service from:
```yaml
DATABASE_URL: postgresql://integration:${POSTGRES_PASSWORD:-integration_pass}@postgres:5432/integration_db
```

To:
```yaml
DATABASE_URL: postgresql://integration:${POSTGRES_PASSWORD:-integration_pass}@pgbouncer:5432/integration_db?pgbouncer=true&connection_limit=10
```

**Option B: Use environment variable override**

Create a `.env` file and set:
```env
DATABASE_URL=postgresql://integration:${POSTGRES_PASSWORD:-integration_pass}@pgbouncer:5432/integration_db?pgbouncer=true&connection_limit=10
```

### Step 3: Add PgBouncer dependency

Update the `depends_on` section in `docker-compose.yml` for backend, worker, and seeder:

```yaml
depends_on:
  postgres:
    condition: service_healthy
  pgbouncer:
    condition: service_started  # Add this
  redis-master:
    condition: service_healthy
```

### Step 4: Restart services

```bash
docker compose restart backend worker
```

## Why Bypass PgBouncer in Development?

1. **Simpler Setup**: No need to configure connection pooling during development
2. **Fewer Moving Parts**: Reduces complexity and potential points of failure
3. **Better Debugging**: Direct connection makes it easier to debug database issues
4. **Prisma Compatibility**: Some Prisma features work better with direct connections

## When to Use PgBouncer?

- **Production**: Always use PgBouncer in production for connection pooling
- **Load Testing**: When testing application behavior under high connection load
- **Specific Testing**: When you need to test PgBouncer-specific behavior

## Connection Limits

### Direct PostgreSQL Connection (Default)
- PostgreSQL configured with `max_connections=200`
- No connection pooling
- Each service manages its own connections

### With PgBouncer (Optional)
- PgBouncer: `MAX_CLIENT_CONN=300`, `DEFAULT_POOL_SIZE=25`
- Connection pooling enabled
- Better for high-concurrency scenarios

## Ports

- **5432**: PostgreSQL (direct connection)
- **5433**: PgBouncer (when enabled with `--profile pgbouncer`)

## Troubleshooting

### "Could not connect to postgres:5432"

This means PostgreSQL is not running. Start it with:
```bash
docker compose up -d postgres
```

### "Could not connect to pgbouncer:5432"

This means you're trying to use PgBouncer but it's not running. Either:
1. Start it with `docker compose --profile pgbouncer up -d`, or
2. Change DATABASE_URL to use `@postgres:5432` instead

### Prisma migrations failing

Ensure you're using `DIRECT_DATABASE_URL` for migrations:
```yaml
DIRECT_DATABASE_URL: ******postgres:5432/integration_db
```

This should always point to PostgreSQL directly, never through PgBouncer.
