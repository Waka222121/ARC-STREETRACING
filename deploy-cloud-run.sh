#!/usr/bin/env bash
set -euo pipefail

# Google Cloud Run deployment script for Arc Streetracing (Single-Service Express + WebSocket /ws + Vite)
# Usage:
#   PROJECT_ID="my-gcp-project" REGION="europe-west3" ./deploy-cloud-run.sh

SERVICE_NAME="${SERVICE_NAME:-arc-streetracing}"
REGION="${REGION:-europe-west3}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
CORS_ORIGINS="${CORS_ORIGINS:-*}"

if [[ -z "${PROJECT_ID}" ]]; then
  echo "Error: Set PROJECT_ID or run 'gcloud config set project <YOUR_PROJECT_ID>' first."
  exit 1
fi

echo "Deploying '${SERVICE_NAME}' to Google Cloud Run (project=${PROJECT_ID}, region=${REGION})..."

gcloud run deploy "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --source=. \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=512Mi \
  --min-instances=1 \
  --max-instances=1 \
  --no-cpu-throttling \
  --timeout=3600 \
  --session-affinity \
  --set-env-vars="^|^NODE_ENV=production|CORS_ORIGINS=${CORS_ORIGINS}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" --project="${PROJECT_ID}" --region="${REGION}" --format='value(status.url)' 2>/dev/null || true)"
if [[ -n "${SERVICE_URL}" ]]; then
  WS_URL="${SERVICE_URL/https:\/\//wss:\/\/}/ws"
  echo ""
  echo "Deployment complete!"
  echo "  Health check : ${SERVICE_URL}/api/health"
  echo "  Vercel env   : VITE_WS_URL=${WS_URL}"
else
  echo "Deployment complete. Check health endpoint at <SERVICE_URL>/api/health"
fi
