#!/usr/bin/env bash
# Typecheck + Playwright suite (Node unit tests and headless Chromium) inside the Playwright
# Docker image, with no network: the tests never need it, and it proves nothing is sent out.
#
#   bash scripts/test.sh                 # everything
#   bash scripts/test.sh --project=unit  # extra args go to `playwright test`
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="mcr.microsoft.com/playwright:v$(node -p 'require("./package.json").devDependencies["@playwright/test"]' 2>/dev/null \
  || sed -n 's/.*"@playwright\/test": "\([0-9.]*\)".*/\1/p' package.json)-noble"

docker run --rm --init --ipc=host --network none \
  -u "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" \
  -v "$PWD:/work" -w /work \
  "$IMAGE" \
  bash -c 'npx tsc --noEmit && npx tsc --noEmit -p tests && npx playwright test "$@"' -- "$@"
