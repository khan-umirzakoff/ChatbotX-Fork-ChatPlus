#!/bin/sh

set -eu

cd /app/apps/realtime

# ChatPLUS deployments historically set only BETTER_AUTH_URL on the realtime
# app; fall back to it so the builder origin is never left unset.
if [ -z "${NEXT_PUBLIC_BUILDER_URL:-}" ] && [ -n "${BETTER_AUTH_URL:-}" ]; then
  export NEXT_PUBLIC_BUILDER_URL="$BETTER_AUTH_URL"
fi

umask 077
# `exec` lets Docker signals reach the gateway directly for graceful shutdowns.
exec ./node_modules/.bin/tsx src/main.ts
