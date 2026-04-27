#!/bin/sh
# Coolify (and most managed hosts) bind-mount the persistent volume on /data
# at runtime, which masks the build-time `chown nextjs:nodejs /data` and
# leaves the directory owned by root. Without this fixup, better-sqlite3
# fails with SQLITE_CANTOPEN because the nextjs user (uid 1001) can't write.
# Repair ownership on every boot, then drop privileges to nextjs.
set -e

if [ -d /data ]; then
  chown -R nextjs:nodejs /data 2>/dev/null || true
fi

exec gosu nextjs:nodejs "$@"
