#!/usr/bin/env bash
# Deploy script: runs on the GCP VM whenever a push to main lands.
# Invoked by webhook-server.mjs. Idempotent — safe to run by hand too.
set -euo pipefail

BRANCH="${DEPLOY_BRANCH:-main}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
SERVICE="${GRIDFORCE_SERVICE:-gridforce}"
DEPLOY_KEY="${DEPLOY_KEY:-/etc/gridforce/deploy_key}"
DEPLOY_KNOWN_HOSTS="${DEPLOY_KNOWN_HOSTS:-/etc/gridforce/known_hosts}"

if [ -z "${GIT_SSH_COMMAND:-}" ] && [ -r "$DEPLOY_KEY" ]; then
  export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o UserKnownHostsFile=$DEPLOY_KNOWN_HOSTS -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"
fi

cd "$REPO_DIR"

echo "==> deploy started at $(date -Iseconds)"
echo "==> repo: $REPO_DIR  branch: $BRANCH  service: $SERVICE"

echo "==> fetching"
git fetch --prune origin "$BRANCH"

echo "==> resetting to origin/$BRANCH"
git reset --hard "origin/$BRANCH"

echo "==> installing deps"
npm ci

echo "==> typechecking"
npm run typecheck

echo "==> building"
npm run build

echo "==> restarting $SERVICE"
sudo systemctl restart "$SERVICE"

echo "==> deploy completed at $(date -Iseconds)"
