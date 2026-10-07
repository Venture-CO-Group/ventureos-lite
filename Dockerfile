# syntax=docker/dockerfile:1
# =============================================================================
# Venture OS Lite — app image (Next.js 15 standalone).
#
# Three stages; the runtime layer carries only the standalone server.
# Migrations are NOT run from this image — the `migrate` compose service (built
# from Dockerfile.worker, which already ships the Prisma CLI) runs
# `prisma migrate deploy` + RLS to completion before app/worker start.
# =============================================================================

# ---- deps -------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder ----------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# The image build must never need production secrets. src/instrumentation.ts
# already skips the env gate during the build phase; this makes it explicit and
# also covers any module that reads config at import time.
ENV SKIP_ENV_VALIDATION=1
# Server Action ids are salted with the build's encryption key. Without a fixed
# key every build gets a random one, so EVERY action id changes on EVERY deploy
# and any tab left open across a deploy fails with "Failed to find Server
# Action" — which, to the person clicking, is a button that does nothing.
# Passed as a BuildKit secret (never a build arg, which `docker history` would
# show). Optional: with no secret the build falls back to a random key.
RUN --mount=type=secret,id=next_actions_key \
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$(cat /run/secrets/next_actions_key 2>/dev/null || true)" \
    sh -c 'npx prisma generate && npm run build'

# ---- runner -----------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache libc6-compat curl \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Generated PDFs and screenshots live on a shared volume, not in the image.
RUN mkdir -p /data/files && chown -R nextjs:nodejs /data/files

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
