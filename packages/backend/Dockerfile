# ─────────────────────────────────────────
# Stage 1: Dependencies
# ─────────────────────────────────────────
FROM node:22-alpine AS deps
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
FROM node:22-alpine AS builder
RUN npm install -g "pnpm@^9"
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/backend/node_modules ./packages/backend/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/backend/ ./packages/backend/
COPY packages/shared/ ./packages/shared/
WORKDIR /app/packages/backend
RUN pnpm exec prisma generate
RUN pnpm run build

# ─────────────────────────────────────────
# Stage 3: Production
# ─────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/packages/backend/dist ./dist
COPY --from=builder /app/packages/backend/node_modules ./node_modules
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/packages/backend/prisma ./prisma
COPY packages/backend/package.json ./

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3001

# Default CMD starts the API server.
# To run the dedicated worker process instead:
#   docker run <image> node dist/worker
CMD ["node", "dist/main"]

# ─────────────────────────────────────────
# Stage 4: Development (hot-reload)
# ─────────────────────────────────────────
FROM node:22-alpine AS development
RUN npm install -g "pnpm@^9"
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

# prisma db push syncs the schema to the DB on every dev restart without
# requiring versioned migration files. Use `migrate deploy` once migrations
# are introduced. The `set -e` flag ensures the container exits immediately
# if the schema push fails rather than starting the app against a bad schema.
CMD ["sh", "-c", "set -e && pnpm exec prisma db push --skip-generate && pnpm dev"]
