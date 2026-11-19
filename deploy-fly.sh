#!/usr/bin/env bash
set -euo pipefail

# Fly.io deployment script for ARC STREETRACING
# Runs a single always-on Machine (--ha=false) so all players share the same 60 Hz rooms & escrow state.
# Usage:
#   APP_NAME="arc-streetracing-myname" REGION="fra" ./deploy-fly.sh

FLY_BIN="$(command -v flyctl || command -v fly || true)"
if [[ -z "${FLY_BIN}" ]]; then
  echo "Error: Fly CLI not found. Install it from https://fly.io/docs/flyctl/install/"
  exit 1
fi

APP_NAME="${APP_NAME:-arc-streetracing}"
REGION="${REGION:-fra}"
CORS_ORIGINS="${CORS_ORIGINS:-*}"

echo "Preparing Fly.io app '${APP_NAME}' (region=${REGION})..."

# Create app if it does not exist yet
if ! "${FLY_BIN}" status --app "${APP_NAME}" >/dev/null 2>&1; then
  "${FLY_BIN}" apps create "${APP_NAME}"
fi

# Deploy strictly 1 Machine (--ha=false) to keep in-memory WebSocket rooms unified
"${FLY_BIN}" deploy \
  --app "${APP_NAME}" \
  --primary-region "${REGION}" \
  --ha=false \
  --env "NODE_ENV=production" \
  --env "HOST=0.0.0.0" \
  --env "PORT=8080" \
  --env "CORS_ORIGINS=${CORS_ORIGINS}"

# Enforce single-machine count so rooms never split across VMs
"${FLY_BIN}" scale count 1 --app "${APP_NAME}" --region "${REGION}" --yes

APP_URL="https://${APP_NAME}.fly.dev"
WS_URL="wss://${APP_NAME}.fly.dev/ws"

echo ""
echo "Fly.io deployment complete!"
echo "  Game URL     : ${APP_URL}"
echo "  Health check : ${APP_URL}/api/health"
echo "  Vercel env   : VITE_WS_URL=${WS_URL}"
