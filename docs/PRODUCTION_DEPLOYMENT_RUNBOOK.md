# Production Deployment Runbook

**Version:** 2.0  
**Last Updated:** 2026-07-02  
**Status:** Production Ready

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Infrastructure Setup](#infrastructure-setup)
3. [Initial Deployment](#initial-deployment)
4. [Upgrade Deployment](#upgrade-deployment)
5. [Rollback Procedure](#rollback-procedure)
6. [Configuration Management](#configuration-management)
7. [Health Checks](#health-checks)
8. [Monitoring and Alerts](#monitoring-and-alerts)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### System Requirements

**Backend Service:**
- Node.js: v18.x or v20.x
- CPU: 4+ cores recommended
- RAM: 8GB minimum, 16GB recommended
- Storage: 100GB+ SSD for database and logs

**Database:**
- PostgreSQL: v14.x or v15.x
- RAM: 16GB+ recommended
- Storage: 500GB+ SSD with automatic backups
- Extensions: `uuid-ossp`, `pg_trgm`

**Cache:**
- Redis: v7.x
- RAM: 4GB+ recommended
- Persistence: AOF enabled

**External Dependencies:**
- Oracle Fusion ERP API access
- VendHQ POS API credentials (per region)
- SMTP server for email alerts

### Network Requirements

**Outbound Connections:**
- Oracle Fusion SOAP endpoint (port 443)
- Oracle Fusion REST endpoint (port 443)
- VendHQ API: `https://api.vendhq.com` (port 443)
- Odoo/IBQ API endpoints (port 443)

**Inbound Connections:**
- API: Port 3000 (HTTP)
- Metrics: Port 9090 (Prometheus)
- BullMQ Dashboard: Port 3000 (via /admin/queues)

---

## Infrastructure Setup

### 1. PostgreSQL Setup

#### Installation

```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y postgresql-15 postgresql-contrib-15

# Start service
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

#### Database Creation

```sql
-- Connect as postgres user
psql -U postgres

-- Create database
CREATE DATABASE integration_middleware;

-- Create application user
CREATE USER integration_user WITH PASSWORD 'your-secure-password';

-- Grant privileges
GRANT ALL PRIVILEGES ON DATABASE integration_middleware TO integration_user;

-- Enable required extensions
\c integration_middleware
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
```

#### Connection Pool Configuration

Edit `/etc/postgresql/15/main/postgresql.conf`:

```ini
max_connections = 200
shared_buffers = 4GB
effective_cache_size = 12GB
maintenance_work_mem = 1GB
checkpoint_completion_target = 0.9
wal_buffers = 16MB
default_statistics_target = 100
random_page_cost = 1.1
effective_io_concurrency = 200
work_mem = 20MB
min_wal_size = 1GB
max_wal_size = 4GB
max_worker_processes = 8
max_parallel_workers_per_gather = 4
max_parallel_workers = 8
```

Restart PostgreSQL:

```bash
sudo systemctl restart postgresql
```

### 2. Redis Setup

#### Installation

```bash
# Ubuntu/Debian
sudo apt-get install -y redis-server

# Start service
sudo systemctl start redis
sudo systemctl enable redis
```

#### Configuration

Edit `/etc/redis/redis.conf`:

```ini
# Persistence
appendonly yes
appendfsync everysec

# Memory
maxmemory 4gb
maxmemory-policy allkeys-lru

# Network
bind 127.0.0.1
port 6379
requirepass your-secure-redis-password
```

Restart Redis:

```bash
sudo systemctl restart redis
```

### 3. Node.js Setup

```bash
# Install Node.js 20.x via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20

# Verify installation
node --version  # Should be v20.x.x
npm --version   # Should be 10.x.x
```

### 4. pnpm Installation

```bash
npm install -g pnpm@latest
pnpm --version  # Should be 8.x.x or 9.x.x
```

---

## Initial Deployment

### Step 1: Clone Repository

```bash
cd /opt
git clone https://github.com/MUSTAQ-AHAMMAD/new-integration.git
cd new-integration
```

### Step 2: Install Dependencies

```bash
# Install all workspace dependencies
pnpm install

# Generate Prisma client
cd packages/backend
pnpm db:generate
```

### Step 3: Configure Environment Variables

Create `packages/backend/.env`:

```bash
# Copy example
cp .env.example .env

# Edit with production values
nano .env
```

**Required Environment Variables:**

```env
# Database
DATABASE_URL="******localhost:5432/integration_middleware?schema=public"

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your-redis-password

# Application
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# JWT Authentication
JWT_SECRET=your-secure-jwt-secret-minimum-32-characters
JWT_EXPIRES_IN=7d

# Admin Credentials
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=secure-admin-password

# Oracle Fusion (Fallback - prefer database credentials)
ORACLE_REST_BASE_URL=https://your-oracle-instance.oraclecloud.com
ORACLE_USERNAME=oracle_user
ORACLE_PASSWORD=oracle_password

# VendHQ (Legacy - prefer database credentials)
VENDHQ_DOMAIN_PREFIX=your-domain
VENDHQ_ACCESS_TOKEN=your-access-token

# Odoo
ODOO_BASE_URL=https://your-odoo-instance.com
ODOO_API_KEY=your-odoo-api-key

# Email Alerts
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASSWORD=smtp-password
SMTP_FROM=Integration Alerts <noreply@example.com>
ALERT_EMAIL_RECIPIENT=ops-team@example.com

# Optional: Batch Sizes
BATCH_SIZE=50
MIN_BATCH_SIZE=5
VENDHQ_PAGE_SIZE=200
```

### Step 4: Run Database Migrations

```bash
cd packages/backend

# Run migrations
pnpm db:migrate:deploy

# Verify migrations
psql -U integration_user -d integration_middleware -c "\dt"
```

Expected output: ~60 tables including:
- OrderSyncQueue
- BackupVendHqSale
- FusionInvoiceHeader
- FusionSalesMetadata
- VendHqCredential
- FusionCredential
- etc.

### Step 5: Build Application

```bash
cd packages/backend
pnpm build

# Verify build output
ls -la dist/
```

Expected output: `main.js`, `worker.js`, and other compiled files.

### Step 6: Configure Process Manager (PM2)

Install PM2:

```bash
npm install -g pm2
```

Create `ecosystem.config.js` in project root:

```javascript
module.exports = {
  apps: [
    {
      name: 'integration-backend',
      script: './packages/backend/dist/main.js',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '2G',
    },
    {
      name: 'integration-worker',
      script: './packages/backend/dist/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '2G',
    },
  ],
};
```

### Step 7: Start Services

```bash
# Create logs directory
mkdir -p logs

# Start with PM2
pm2 start ecosystem.config.js

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
```

### Step 8: Verify Deployment

```bash
# Check PM2 status
pm2 status

# Check logs
pm2 logs integration-backend --lines 50

# Test health endpoint
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "ok",
  "info": {
    "database": { "status": "up" },
    "redis": { "status": "up" }
  },
  "details": { ... }
}
```

---

## Upgrade Deployment

### Step 1: Backup Database

```bash
# Create backup directory
mkdir -p /opt/backups

# Backup database
pg_dump -U integration_user integration_middleware > /opt/backups/integration_$(date +%Y%m%d_%H%M%S).sql

# Backup .env file
cp packages/backend/.env /opt/backups/.env.$(date +%Y%m%d_%H%M%S)
```

### Step 2: Pull Latest Code

```bash
cd /opt/new-integration

# Stash local changes
git stash

# Pull latest
git pull origin main

# Apply stashed changes (if any)
git stash pop
```

### Step 3: Install Dependencies

```bash
# Update dependencies
pnpm install

# Regenerate Prisma client
cd packages/backend
pnpm db:generate
```

### Step 4: Run Migrations

```bash
# Run new migrations
pnpm db:migrate:deploy
```

### Step 5: Build Application

```bash
pnpm build
```

### Step 6: Reload Services

```bash
# Reload with zero downtime
pm2 reload ecosystem.config.js

# Verify status
pm2 status

# Check logs
pm2 logs --lines 50
```

### Step 7: Verify Upgrade

```bash
# Test health endpoint
curl http://localhost:3000/health

# Check version (if endpoint exists)
curl http://localhost:3000/version

# Monitor logs for errors
pm2 logs integration-backend --lines 100
```

---

## Rollback Procedure

### Option 1: Code Rollback

```bash
cd /opt/new-integration

# Find previous commit
git log --oneline -10

# Rollback to previous version
git checkout <previous-commit-hash>

# Rebuild
cd packages/backend
pnpm install
pnpm build

# Reload services
pm2 reload ecosystem.config.js
```

### Option 2: Database Rollback

**⚠️ WARNING:** Database rollback can result in data loss. Use with caution.

```bash
# Stop services
pm2 stop all

# Restore database from backup
psql -U integration_user integration_middleware < /opt/backups/integration_YYYYMMDD_HHMMSS.sql

# Restart services
pm2 start ecosystem.config.js
```

### Option 3: Full Rollback

```bash
# Stop services
pm2 stop all

# Restore code
git checkout <previous-commit-hash>

# Restore database
psql -U integration_user integration_middleware < /opt/backups/integration_YYYYMMDD_HHMMSS.sql

# Restore .env
cp /opt/backups/.env.YYYYMMDD_HHMMSS packages/backend/.env

# Rebuild
cd packages/backend
pnpm install
pnpm build

# Start services
pm2 start ecosystem.config.js
```

---

## Configuration Management

### FusionSalesMetadata Configuration

Configure customer types and Oracle parameters per region:

```bash
# Access admin panel
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin-password"}'

# Create metadata entry
curl -X POST http://localhost:3000/api/v1/fusion/metadata \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "region": "AE",
    "customerType": "RETAIL",
    "billToCustomerName": "Retail Customer - UAE",
    "billToLocation": "DXB-RETAIL-SITE",
    "billToAccountNumber": "CUST-AE-RETAIL",
    "businessUnit": "BU-UAE",
    "transactionSource": "VendHQ POS",
    "transactionType": "PASA CONSULTING SALE"
  }'
```

### FusionReceiptMethod Configuration

Configure payment methods per region:

```bash
curl -X POST http://localhost:3000/api/v1/fusion/receipt-methods \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "region": "AE",
    "receiptMethodName": "Cash",
    "receiptMethodId": 1001,
    "remittanceBankAccountId": 2001
  }'
```

### Store Configuration

Configure bank accounts and GL codes per outlet/register:

```bash
# Auto-populate for all branches
curl -X POST http://localhost:3000/api/v1/store-config/populate/all-branches \
  -H "Authorization: ******"

# Update specific register
curl -X PATCH http://localhost:3000/api/v1/store-config/<config-id> \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{
    "bankAccountName": "UAE Bank Account - Main",
    "cashAccountName": "UAE Cash Account"
  }'
```

---

## Health Checks

### Application Health

```bash
# Health endpoint
curl http://localhost:3000/health

# Expected: 200 OK with database and Redis status
```

### Database Health

```bash
# Check connections
psql -U integration_user -d integration_middleware -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'integration_middleware';"

# Check table sizes
psql -U integration_user -d integration_middleware -c "SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size FROM pg_tables WHERE schemaname = 'public' ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC LIMIT 10;"
```

### Redis Health

```bash
# Check Redis
redis-cli -a your-redis-password ping

# Expected: PONG

# Check memory usage
redis-cli -a your-redis-password INFO memory
```

### Queue Health

```bash
# Check BullMQ queues
curl http://localhost:3000/api/v1/queues/status \
  -H "Authorization: ******"

# Expected: Queue counts for order-sync, inventory-sync, retry, notifications
```

---

## Monitoring and Alerts

### Prometheus Metrics

Access metrics at: `http://localhost:3000/metrics`

**Key Metrics:**
- `integration_orders_total` - Total orders processed
- `integration_orders_by_status` - Orders by status
- `integration_sync_job_duration_seconds` - Sync job duration
- `vendhq_sync_duration_seconds` - VendHQ sync duration
- `vendhq_sync_soap_call_duration_seconds` - SOAP call latency
- `integration_queue_waiting` - Queue backlog
- `integration_stalled_orders_total` - Stalled orders

### Log Monitoring

```bash
# Follow backend logs
pm2 logs integration-backend --lines 100

# Follow worker logs
pm2 logs integration-worker --lines 100

# Search for errors
pm2 logs integration-backend --err --lines 50
```

### Alert Configuration

Alerts are sent via email when:
- Sync jobs fail > 3 times in a row
- Oracle SOAP errors occur
- Database connection fails
- Queue backlog exceeds threshold

Configure alert recipient in `.env`:

```env
ALERT_EMAIL_RECIPIENT=ops-team@example.com
```

---

## Troubleshooting

### Service Won't Start

```bash
# Check PM2 logs
pm2 logs --err --lines 100

# Check environment variables
cat packages/backend/.env

# Test database connection
psql -U integration_user -d integration_middleware -c "SELECT 1;"

# Test Redis connection
redis-cli -a your-redis-password ping
```

### High Memory Usage

```bash
# Check PM2 memory usage
pm2 status

# Restart specific app
pm2 restart integration-backend

# Increase max_memory_restart in ecosystem.config.js
```

### Sync Jobs Not Running

```bash
# Check SyncControl status
curl http://localhost:3000/api/v1/sync-control \
  -H "Authorization: ******"

# Enable sync if disabled
curl -X PATCH http://localhost:3000/api/v1/sync-control \
  -H "Authorization: ******" \
  -H "Content-Type: application/json" \
  -d '{"isSyncEnabled":true}'
```

### Oracle SOAP Errors

See [TROUBLESHOOTING_PLAYBOOK.md](./TROUBLESHOOTING_PLAYBOOK.md) for detailed Oracle error resolution.

---

## Contact

**Support:** integration-support@example.com  
**Documentation:** https://github.com/MUSTAQ-AHAMMAD/new-integration  
**Runbook Version:** 2.0  
**Last Updated:** 2026-07-02
