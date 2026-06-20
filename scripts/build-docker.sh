#!/usr/bin/env bash
# Build & push the PII-scrubbing Docker image to ghcr.io.
# Run this on a host with Docker + buildx multi-arch (the WSL distro used
# by the Claude session did not have docker available, so this is left for
# the user to execute locally or on the Pi build host).
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d models/gliner2-pii ]; then
  echo "ERROR: models/gliner2-pii not present in build context."
  echo "Copy the FP32 ONNX model into ./models/gliner2-pii (config.json,"
  echo "gliner2_config.json, tokenizer*, onnx/encoder.onnx, onnx/classifier.onnx,"
  echo "onnx/span_rep.onnx, onnx/count_embed.onnx)."
  exit 1
fi

TAG=${TAG:-ghcr.io/fogx/toolbox-for-firefly-iii:1.3.0-scrub.1}
PLATFORMS=${PLATFORMS:-linux/arm64}

echo "Building $TAG for $PLATFORMS..."

# Multi-arch path (preferred):
if docker buildx version >/dev/null 2>&1; then
  docker buildx build \
    --platform "$PLATFORMS" \
    -t "$TAG" \
    --push \
    .
else
  # Fallback: single-arch build + push.
  docker build -t "$TAG" .
  docker push "$TAG"
fi
