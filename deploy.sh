#!/usr/bin/env bash
# Deploy the domino game to Cloud Run.
#
#   ./deploy.sh              # build + deploy, print the public URL
#   REGION=europe-west1 ./deploy.sh
#
# Flags that matter for this app are explained in README.md ("Cloud Run").
set -euo pipefail

SERVICE="${SERVICE:-domino}"
REGION="${REGION:-europe-west1}"
GCLOUD="${GCLOUD:-$HOME/google-cloud-sdk/bin/gcloud}"

# The CLI's managed Python venv can be broken (pyOpenSSL/cryptography mismatch:
# "module 'lib' has no attribute 'GEN_EMAIL'"). Point it at a real 3.10+ Python.
export CLOUDSDK_PYTHON="${CLOUDSDK_PYTHON:-/opt/homebrew/bin/python3}"

die() { echo "✗ $*" >&2; exit 1; }
note() { echo "• $*"; }

command -v "$GCLOUD" >/dev/null 2>&1 || [ -x "$GCLOUD" ] || die "gcloud not found at $GCLOUD"

# ---------------------------------------------------------------- preflight
ACCOUNT="$("$GCLOUD" auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)"
[ -n "$ACCOUNT" ] || die "not logged in. Run:  \"$GCLOUD\" auth login"
note "account: $ACCOUNT"

PROJECT="$("$GCLOUD" config get-value project 2>/dev/null | tr -d '\n')"
if [ -z "$PROJECT" ] || [ "$PROJECT" = "(unset)" ]; then
  die "no project set. Run:  gcloud config set project YOUR_PROJECT_ID   (create one at https://console.cloud.google.com/projectcreate)"
fi
note "project: $PROJECT  region: $REGION"

BILLING="$("$GCLOUD" beta billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null || echo unknown)"
if [ "$BILLING" = "False" ]; then
  die "billing is not enabled on $PROJECT. Cloud Run needs a billing account (the free tier still applies). Link one at https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT"
elif [ "$BILLING" = "unknown" ]; then
  note "could not read billing state — continuing, the deploy will tell you if it is off"
else
  note "billing: enabled"
fi

note "enabling required APIs (idempotent, may take a minute)…"
"$GCLOUD" services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "$PROJECT"

# ---------------------------------------------------------------- deploy
note "building and deploying (Cloud Build does the image build; no local Docker needed)…"
"$GCLOUD" run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 \
  --memory 256Mi \
  --concurrency 200 \
  --timeout 3600 \
  --min-instances 1 \
  --max-instances 1 \
  --set-env-vars NODE_ENV=production

URL="$("$GCLOUD" run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo
echo "✓ deployed"
echo "  $URL"
echo
echo "Cloud Run injects PORT, the container binds all interfaces, and TLS is terminated"
echo "for you — so the client's ws:// becomes wss:// automatically. Host and guest both"
echo "open the URL above; the invite link in the lobby is built from it."
echo
echo "Runtime flags baked in, and why:"
echo "  --timeout 3600     a WebSocket stream is an HTTP request and dies at the service"
echo "                     timeout; 3600s is the maximum."
echo "  --min/max-instances 1  rooms live in memory, and Cloud Run's session affinity is"
echo "                     best-effort — two sockets can land on different instances and"
echo "                     see different rooms. One instance removes that whole class of bug."
echo "  --concurrency 200  many sockets share one instance instead of scaling out."
