# ─────────────────────────────────────────
# Stage 1: Dependencies
# ─────────────────────────────────────────
FROM node:22-slim AS deps
RUN npm install -g "pnpm@^9"
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/dashboard/package.json ./packages/dashboard/
RUN pnpm install --no-frozen-lockfile

# ─────────────────────────────────────────
# Stage 2: Builder
# ─────────────────────────────────────────
FROM node:22-slim AS builder
RUN npm install -g "pnpm@^9"
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/backend/ ./packages/backend/
COPY packages/shared/ ./packages/shared/
WORKDIR /app/packages/backend
RUN pnpm exec prisma generate
RUN pnpm run build

# ─────────────────────────────────────────
# Stage 3: Production
# ─────────────────────────────────────────
FROM node:22-slim AS production
WORKDIR /app
ENV NODE_ENV=production

# Install Oracle Instant Client dependencies and tools
RUN apt-get update && apt-get install -y \
    wget \
    unzip \
    libaio1 \
    libaio-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Download and install Oracle Instant Client
RUN cd /opt && \
    wget --quiet --no-check-certificate \
    https://download.oracle.com/otn_software/linux/instantclient/2113000/instantclient-basic-linux.x64-21.13.0.0.0dbru.zip && \
    unzip -q instantclient-basic-linux.x64-21.13.0.0.0dbru.zip && \
    rm instantclient-basic-linux.x64-21.13.0.0.0dbru.zip && \
    mv instantclient_21_13 instantclient && \
    chmod -R 755 /opt/instantclient

# Set Oracle environment variables
ENV LD_LIBRARY_PATH=/opt/instantclient:$LD_LIBRARY_PATH
ENV PATH=/opt/instantclient:$PATH
ENV ORACLE_HOME=/opt/instantclient

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/backend/node_modules ./packages/backend/node_modules
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/prisma ./packages/backend/prisma
COPY packages/backend/package.json ./packages/backend/

RUN groupadd -r appgroup && useradd -r -g appgroup appuser
USER appuser

EXPOSE 3001

WORKDIR /app/packages/backend
# Apply any pending migrations before starting the API server.
# If the migration fails the container will exit, preventing a running API against
# a stale schema.  For zero-downtime deployments run the migration as a separate
# init step before routing traffic to this container.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main"]

# ─────────────────────────────────────────
# Stage 4: Development (hot-reload)
# ─────────────────────────────────────────
FROM node:22-slim AS development
RUN npm install -g "pnpm@^9"

# Install Oracle Instant Client dependencies
RUN apt-get update && apt-get install -y \
    wget \
    unzip \
    libaio1 \
    libaio-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Download and install Oracle Instant Client
RUN cd /opt && \
    wget --quiet --no-check-certificate \
    https://download.oracle.com/otn_software/linux/instantclient/2113000/instantclient-basic-linux.x64-21.13.0.0.0dbru.zip && \
    unzip -q instantclient-basic-linux.x64-21.13.0.0.0dbru.zip && \
    rm instantclient-basic-linux.x64-21.13.0.0.0dbru.zip && \
    mv instantclient_21_13 instantclient && \
    chmod -R 755 /opt/instantclient

ENV LD_LIBRARY_PATH=/opt/instantclient:$LD_LIBRARY_PATH
ENV PATH=/opt/instantclient:$PATH
ENV ORACLE_HOME=/opt/instantclient

WORKDIR /app
ENV NODE_ENV=development

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/dashboard/package.json ./packages/dashboard/
RUN pnpm install --no-frozen-lockfile
COPY packages/backend/ ./packages/backend/
COPY packages/shared/ ./packages/shared/
WORKDIR /app/packages/backend
RUN pnpm exec prisma generate

EXPOSE 3001

CMD ["sh", "-c", "set -e && pnpm exec prisma migrate deploy && pnpm dev"]