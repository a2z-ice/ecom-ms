#!/usr/bin/env bash
# scripts/pin-image-digests.sh
# Resolves current SHA256 digests for all base images and updates Dockerfiles.
# Requires Docker daemon to be running.
#
# Usage: bash scripts/pin-image-digests.sh

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}==>${NC} $*"; }

# Images to pin: "tag|dockerfile|stage_name"
IMAGES=(
  "eclipse-temurin:21-jdk-alpine|ecom-service/Dockerfile|build"
  "eclipse-temurin:21-jre-alpine|ecom-service/Dockerfile|runtime"
  "python:3.12-slim|inventory-service/Dockerfile|both"
  "golang:1.25-alpine|csrf-service/Dockerfile|build"
  "gcr.io/distroless/static:nonroot|csrf-service/Dockerfile|runtime"
  "node:22-alpine|ui/Dockerfile|build"
  "nginx:1.27-alpine|ui/Dockerfile|runtime"
)

for entry in "${IMAGES[@]}"; do
  IFS='|' read -r tag dockerfile stage <<< "$entry"
  info "Pulling ${tag}..."
  docker pull "$tag" >/dev/null 2>&1
  digest=$(docker inspect --format='{{index .RepoDigests 0}}' "$tag" 2>/dev/null | sed 's/.*@//')
  if [[ -z "$digest" ]]; then
    echo "  WARNING: Could not resolve digest for ${tag}"
    continue
  fi
  pinned="${tag%%:*}@${digest}"
  info "  Resolved: ${tag} -> ${digest}"

  # Replace in Dockerfile: FROM <tag> -> FROM <tag>@sha256:...
  # Keep the tag as a comment for human readability
  filepath="${REPO_ROOT}/${dockerfile}"
  if grep -q "FROM ${tag}" "$filepath"; then
    sed -i.bak "s|FROM ${tag}|FROM ${pinned}  # ${tag}|g" "$filepath"
    rm -f "${filepath}.bak"
    info "  Updated ${dockerfile}"
  fi
done

echo ""
info "All base images pinned to SHA256 digests."
info "Review changes with: git diff */Dockerfile"
