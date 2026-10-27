#!/bin/sh
set -e
cd /repo/apps/backend
if printf '%s' "$DATABASE_URL" | grep -q '^file:'; then
  mkdir -p "$(dirname "${DATABASE_URL#file:}")"
  node prisma/to-sqlite.mjs
  npx prisma generate --schema prisma/schema.sqlite.prisma
  npx prisma db push --schema prisma/schema.sqlite.prisma --skip-generate --accept-data-loss
else
  npx prisma migrate deploy
fi
exec node dist/src/main.js
