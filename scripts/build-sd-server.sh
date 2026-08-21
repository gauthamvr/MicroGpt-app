#!/usr/bin/env bash
# Build libsd-server.so via Docker and drop it into jniLibs.
#
# Usage: bash scripts/build-sd-server.sh
#
# Requires: Docker daemon running. On Windows, start Docker Desktop first.
# First run takes ~20-30 min (NDK + OpenCL deps + sd.cpp build). Cached
# layers make subsequent rebuilds much faster.
#
# Two recipes exist:
#   Dockerfile.sd-server.full  self-contained, builds everything
#   Dockerfile.sd-server       fast path, starts FROM sd-opencl-builder:latest
# This script picks the fast one when that base image is already present.
#
# Verify alignment after with: npm run check-16k

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="$REPO_ROOT/build-output"
JNI_TARGET="modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a/libsd-server.so"

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running."
  echo "  On Windows: start Docker Desktop, wait for the whale icon to settle, then re-run."
  exit 1
fi

mkdir -p "$OUT_DIR"

if docker image inspect sd-opencl-builder:latest >/dev/null 2>&1; then
  DOCKERFILE="scripts/Dockerfile.sd-server"
  echo "==> Found sd-opencl-builder:latest — using the incremental recipe"
else
  DOCKERFILE="scripts/Dockerfile.sd-server.full"
  echo "==> No sd-opencl-builder:latest locally — using the from-scratch recipe"
fi

echo "==> Building Docker image from $DOCKERFILE"
docker build -f "$DOCKERFILE" -t microgpt-sd-server:latest .

echo "==> Extracting compiled binary via docker cp"
# The binary is baked into the image at /work/output/libsd-server.so.
# A volume mount would overlay that path and hide the file, so use
# `docker cp` from a temporary container instead.
CID=$(docker create microgpt-sd-server:latest)
trap "docker rm -f $CID >/dev/null 2>&1 || true" EXIT
docker cp "$CID:/work/output/libsd-server.so" "$OUT_DIR/libsd-server.so"
docker rm -f "$CID" >/dev/null
trap - EXIT

if [[ ! -f "$OUT_DIR/libsd-server.so" ]]; then
  echo "ERROR: $OUT_DIR/libsd-server.so missing after build"
  exit 1
fi

echo "==> Installing to $JNI_TARGET"
# jniLibs/ is gitignored, so it does not exist in a fresh clone.
mkdir -p "$(dirname "$JNI_TARGET")"
cp -f "$OUT_DIR/libsd-server.so" "$JNI_TARGET"

echo ""
echo "==> Alignment audit"
node scripts/check-16k-alignment.js "$JNI_TARGET"

echo ""
echo "Done. Run 'npm run check-16k' anytime to re-audit all native libs."
