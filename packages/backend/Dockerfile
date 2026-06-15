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
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# Install glibc compatibility + libaio so Oracle Instant Client shared libraries
# can be loaded when ORACLE_DB_THICK_MODE=true (Alpine uses musl by default).
RUN apk add --no-cache gcompat libaio

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/backend/node_modules ./packages/backend/node_modules
COPY --from=builder /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/prisma ./packages/backend/prisma
COPY packages/backend/package.json ./packages/backend/

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3001

WORKDIR /app/packages/backend
CMD ["node", "dist/main"]

# ─────────────────────────────────────────
# Stage 4: Development (hot-reload)
# ─────────────────────────────────────────
FROM node:22-alpine AS development
RUN npm install -g "pnpm@^9"
# Install glibc compatibility + libaio so Oracle Instant Client shared libraries
# can be loaded when ORACLE_DB_THICK_MODE=true (Alpine uses musl by default).
RUN apk add --no-cache gcompat libaio
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

CMD ["sh", "-c", "set -e && pnpm exec prisma db push --skip-generate && pnpm dev"]
