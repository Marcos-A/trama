#!/usr/bin/env bash
# Typecheck + Playwright suite (Node unit tests and headless Chromium) inside the Playwright
# Docker image, with no network: the tests never need it, and it proves nothing is sent out.
#
#   bash scripts/test.sh                 # everything
#   bash scripts/test.sh --project=unit  # extra args go to `playwright test`
#   SOAK_MINUTES=120 bash scripts/test.sh --project=soak  # long synthetic recording
#   SOAK_MINUTES=120 SOAK_CAPTURE=real bash scripts/test.sh --project=soak  # through real tab capture, hidden
#   CAPTURE_HIDDEN_S=600 bash scripts/test.sh --project=capture  # longer hidden stretch
#
# Under Xvfb: the `capture` project runs a headed browser (real tab capture records only silence
# when headless).
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="mcr.microsoft.com/playwright:v$(node -p 'require("./package.json").devDependencies["@playwright/test"]' 2>/dev/null \
  || sed -n 's/.*"@playwright\/test": "\([0-9.]*\)".*/\1/p' package.json)-noble"

docker run --rm --init --ipc=host --network none \
  -u "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" -e SOAK_MINUTES="${SOAK_MINUTES:-}" \
  -e SOAK_CAPTURE="${SOAK_CAPTURE:-}" -e CAPTURE_HIDDEN_S="${CAPTURE_HIDDEN_S:-}" \
  -v "$PWD:/work" -w /work \
  "$IMAGE" \
  bash -c 'npx tsc --noEmit && npx tsc --noEmit -p tests && xvfb-run -a -s "-screen 0 1920x1080x24" npx playwright test "$@"' -- "$@"
