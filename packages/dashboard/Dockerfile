# ─────────────────────────────────────────
# Stage 1: Dependencies
# ─────────────────────────────────────────
FROM node:22-alpine AS deps
RUN npm install -g pnpm
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/dashboard/package.json ./packages/dashboard/
RUN pnpm install --frozen-lockfile

# ─────────────────────────────────────────
# Stage 2: Builder
# ─────────────────────────────────────────
FROM node:22-alpine AS builder
RUN npm install -g pnpm
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/dashboard/node_modules ./packages/dashboard/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY packages/dashboard/ ./packages/dashboard/

ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_API_URL=http://localhost:3001/api/v1
ENV NEXT_PUBLIC_WS_URL=http://localhost:3001

WORKDIR /app/packages/dashboard
RUN pnpm run build

# ─────────────────────────────────────────
# Stage 3: Production
# ─────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/packages/dashboard/public ./public
COPY --from=builder --chown=appuser:appgroup /app/packages/dashboard/.next/standalone ./
COPY --from=builder --chown=appuser:appgroup /app/packages/dashboard/.next/static ./.next/static

USER appuser

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]

# ─────────────────────────────────────────
# Stage 4: Development (hot-reload)
# ─────────────────────────────────────────
FROM node:22-alpine AS development
RUN npm install -g pnpm
WORKDIR /app
ENV NODE_ENV=development
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/dashboard/package.json ./packages/dashboard/
RUN pnpm install --frozen-lockfile
COPY packages/dashboard/ ./packages/dashboard/
WORKDIR /app/packages/dashboard

EXPOSE 3000

CMD ["pnpm", "dev"]
