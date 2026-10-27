# Built from the MONOREPO ROOT context (see docker-compose.yml `context: .`)
# because this app depends on the workspace package @nodedr-restaurant/types.
# Do not try to `docker build` this file with apps/backend as context.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# --- deps: install with full workspace visible so pnpm can link @nodedr-restaurant/types ---
# python3/make/g++/linux-headers/eudev-dev/libusb-dev/pkgconfig are for the
# `usb` package's native addon (direct-USB ESC/POS printing, see
# apps/backend/src/modules/orders/escpos-usb.ts). It ships a prebuilt
# linux-x64 musl binary, but empirically its install script doesn't reliably
# skip straight to that prebuild on Alpine — with no compiler present it
# falls through to `node-gyp rebuild` and fails outright (verified building
# this exact package in nodedr-pos, ported here unchanged). None of this is
# needed at runtime — see the small eudev-libs/libstdc++ runtime deps below
# instead of this whole toolchain.
FROM base AS deps
RUN apk add --no-cache openssl python3 make g++ linux-headers eudev-dev libusb-dev pkgconfig
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/types/package.json packages/types/package.json
RUN pnpm install --frozen-lockfile

# --- builder: compile types package, generate Prisma client, build Nest ---
FROM deps AS builder
COPY packages/types packages/types
COPY apps/backend apps/backend
RUN pnpm --filter @nodedr-restaurant/types build
RUN pnpm --filter @nodedr-restaurant/backend exec prisma generate
RUN pnpm --filter @nodedr-restaurant/backend build

# Docker CLI (optional in-container "update & restart" against mounted
# docker.sock — see src/system/update.service.ts). Pulled from the official
# docker:cli image rather than Alpine's community docker-cli package so the
# binary is guaranteed present/current across both amd64 and arm64 builds.
FROM docker:cli AS dockercli

# Fetches the docker-compose CLI plugin binary in its own throwaway stage —
# deliberately NOT via `apk add curl` in the runtime stage itself. Alpine's
# package resolver can pull in a newer transitive openssl than the one
# already pinned there, and the Prisma query engine binary (downloaded at
# `prisma generate` time in the builder stage, matched to a specific
# musl/openssl ABI) then fails at startup with "could not locate the Query
# Engine for runtime linux-musl..." — verified by hitting exactly this
# after first trying `apk add ... curl` inline below. Isolating the fetch
# here keeps the runtime stage's apk install byte-for-byte what it was
# before self-update existed.
FROM alpine:3.20 AS compose-fetch
ARG TARGETARCH=amd64
RUN apk add --no-cache curl \
  && case "$TARGETARCH" in \
       amd64) DARCH=x86_64 ;; \
       arm64) DARCH=aarch64 ;; \
       *) DARCH=$TARGETARCH ;; \
     esac \
  && curl -fsSL --retry 3 --retry-delay 2 \
     "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-${DARCH}" \
     -o /docker-compose \
  && chmod +x /docker-compose

# --- runtime: slim image, only what's needed to run ---
# Keeps the SAME directory depth as the workspace (/repo/apps/backend, not a
# flattened /app) — pnpm's per-package node_modules/.bin/* entries (prisma,
# nest, etc.) are symlinks with relative paths back into the root
# node_modules/.pnpm store, and flattening the tree breaks them silently
# (npx then can't find the local `prisma` binary and falls back to fetching
# an arbitrary "latest" version from the registry at container start).
FROM node:22-alpine AS runtime
# eudev-libs (libudev.so, used by `usb`'s libusb backend for device
# enumeration) and libstdc++ (the addon is a C++ build) are the only
# runtime-side additions for direct-USB printing — libusb itself is
# statically linked into the addon, so no separate libusb runtime package
# is needed (same verification nodedr-pos already did for this exact
# package). postgresql16-client (pg_dump/pg_restore) backs the Backup
# module (apps/backend/src/backup/) — version-pinned to match the
# postgres:16-alpine server in docker-compose.yml, since pg_dump's custom
# format is not guaranteed compatible across major versions.
RUN apk add --no-cache openssl eudev-libs libstdc++ postgresql16-client
RUN mkdir -p /usr/local/lib/docker/cli-plugins
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=compose-fetch /docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
WORKDIR /repo
ENV NODE_ENV=production
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=builder /repo/apps/backend/dist ./apps/backend/dist
COPY --from=builder /repo/apps/backend/prisma ./apps/backend/prisma
COPY --from=builder /repo/apps/backend/package.json ./apps/backend/package.json
COPY --from=builder /repo/packages/types/dist ./packages/types/dist
COPY --from=builder /repo/packages/types/package.json ./packages/types/package.json
COPY --from=builder /repo/packages/types/node_modules ./packages/types/node_modules

WORKDIR /repo/apps/backend
EXPOSE 4000
CMD ["sh", "prisma/start.sh"]
