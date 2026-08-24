#!/bin/sh

set -eu

cd /app/apps/realtime

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-node-snapshot"

: "${REALTIME_BROADCAST_SECRET:?REALTIME_BROADCAST_SECRET is required}"
: "${BETTER_AUTH_URL:?BETTER_AUTH_URL is required}"

# Use the workspace-pinned PartyKit version instead of downloading an
# unpinned package at container startup. `exec` also lets Docker signals reach
# PartyKit directly for graceful shutdowns.
exec pnpm exec partykit dev \
  --port "${PORT:-1999}" \
  --no-hotkeys \
  --var \
  "REALTIME_BROADCAST_SECRET=$REALTIME_BROADCAST_SECRET" \
  "BETTER_AUTH_URL=$BETTER_AUTH_URL"
