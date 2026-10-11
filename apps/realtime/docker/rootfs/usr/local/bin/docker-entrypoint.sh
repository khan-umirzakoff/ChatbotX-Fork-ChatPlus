#!/bin/sh

set -eu

cd /app/apps/realtime

# ChatPLUS deployments historically set only BETTER_AUTH_URL on the realtime
# app; fall back to it so the builder origin is never the localhost default.
NEXT_PUBLIC_BUILDER_URL="${NEXT_PUBLIC_BUILDER_URL:-${BETTER_AUTH_URL:-http://localhost:3123}}"

# PartyKit dev reads vars from .env in the project directory; keep the file
# private to the container user instead of passing secrets on the command line.
umask 077
printf 'REALTIME_BROADCAST_SECRET=%s\nNEXT_PUBLIC_BUILDER_URL=%s\n' \
  "${REALTIME_BROADCAST_SECRET:?REALTIME_BROADCAST_SECRET is required}" \
  "$NEXT_PUBLIC_BUILDER_URL" > .env

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-node-snapshot"

# Workspace-pinned PartyKit (no download at startup). `exec` lets Docker
# signals reach PartyKit directly for graceful shutdowns.
exec pnpm exec partykit dev --port "${PORT:-1999}" --no-hotkeys
