#!/usr/bin/env bash
# Build the toolbox Docker image locally (e.g. on the Pi, arm64).
#
#   TAG=ghcr.io/fogx/toolbox-for-firefly-iii:1.4.0-claude.1 scripts/build-docker.sh
#
# VITE_BASE sets the subpath the UI is served under (default /toolbox/, as in
# the home-finance-infra deployment). Set PUSH=1 to push the tag afterwards.
set -euo pipefail

cd "$(dirname "$0")/.."

TAG=${TAG:?set TAG, e.g. ghcr.io/fogx/toolbox-for-firefly-iii:1.4.0-claude.1}
VITE_BASE=${VITE_BASE:-/toolbox/}

echo "Building $TAG (VITE_BASE=$VITE_BASE) from $(git rev-parse --short HEAD)..."
docker build \
  --build-arg VITE_BASE="$VITE_BASE" \
  --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
  --label org.opencontainers.image.source=https://github.com/fogx/toolbox-for-firefly-iii \
  -t "$TAG" \
  .

if [ "${PUSH:-0}" = "1" ]; then
  docker push "$TAG"
fi
