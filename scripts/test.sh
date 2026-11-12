#!/usr/bin/env bash
# Typecheck + Playwright suite (Node unit tests and headless Chromium) inside the Playwright
# Docker image, with no network: the tests never need it, and it proves nothing is sent out.
#
#   bash scripts/test.sh                 # everything
#   bash scripts/test.sh --project=unit  # extra args go to `playwright test`
#
# Transcription tests use the ONNX models in $TRAMA_MODELS_DIR (default /srv/apps/trama-models,
# filled by scripts/fetch-models.sh), mounted read-only; without it those tests are skipped.
# Test audio outside the repo ($TRAMA_EVAL_DATA_DIR, default /srv/apps/trama-eval-data) is
# mounted read-only too; TRAMA_MEASURE=... runs the speed/memory matrix (transcription-measure).
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="mcr.microsoft.com/playwright:v$(node -p 'require("./package.json").devDependencies["@playwright/test"]' 2>/dev/null \
  || sed -n 's/.*"@playwright\/test": "\([0-9.]*\)".*/\1/p' package.json)-noble"

MODELS_DIR="${TRAMA_MODELS_DIR:-/srv/apps/trama-models}"
MODELS=()
[[ -d "$MODELS_DIR" ]] && MODELS=(-v "$MODELS_DIR:/models:ro" -e TRAMA_MODELS_DIR=/models)
DATA_DIR="${TRAMA_EVAL_DATA_DIR:-/srv/apps/trama-eval-data}"
[[ -d "$DATA_DIR" ]] && MODELS+=(-v "$DATA_DIR:/eval-data:ro" -e TRAMA_EVAL_DATA_DIR=/eval-data)

# Pass the measurement knobs through (TRAMA_MEASURE, TRAMA_MEASURE_AUDIO, …).
for v in ${!TRAMA_MEASURE@}; do MODELS+=(-e "$v=${!v}"); done

docker run --rm --init --ipc=host --network none \
  -u "$(id -u):$(id -g)" -e HOME=/tmp -e CI="${CI:-}" \
  "${MODELS[@]}" \
  -v "$PWD:/work" -w /work \
  "$IMAGE" \
  bash -c 'npx tsc --noEmit && npx tsc --noEmit -p tests && npx playwright test "$@"' -- "$@"
