# syntax=docker/dockerfile:1.7

# ---- base ----
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# ---- deps ----
FROM base AS deps
# better-sqlite3 ships prebuilt binaries for linux-x64; build tools are a fallback if a prebuild
# isn't available for the current Node version.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- builder ----
FROM base AS builder
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN --mount=type=cache,id=next,target=/app/.next/cache \
    pnpm build

# ---- runner ----
FROM node:24-slim AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# sqlite3 + rclone for the nightly backup scheduled task; curl for health/poll triggers.
# gosu lets the entrypoint repair /data ownership as root then drop to nextjs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends sqlite3 rclone curl ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# Persistent volume mount target. Coolify mounts a named volume here at
# runtime, which masks this build-time chown — the entrypoint fixes it
# back up on each boot.
RUN mkdir -p /data && chown -R nextjs:nodejs /data

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Container starts as root (briefly) so the entrypoint can chown /data;
# it then exec's the app as nextjs via gosu. Don't set USER here.
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
