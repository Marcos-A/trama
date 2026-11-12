#!/usr/bin/env bash
# Downloads ONNX speech models from Hugging Face into a local models directory, in the layout
# transformers.js expects under `/models/` (served from our own origin; the page never fetches
# a third-party URL, and the CSP connect-src 'self' would refuse it anyway).
#
#   bash scripts/fetch-models.sh                         # default set into $TRAMA_MODELS_DIR
#   bash scripts/fetch-models.sh onnx-community/whisper-base q8
#
# Each model: config + tokenizer files, and the encoder / merged decoder for each dtype given
# (q8 = "_quantized", fp16, q4, q4f16, fp32 = no suffix). Skips files already present.
set -euo pipefail

DIR="${TRAMA_MODELS_DIR:-/srv/apps/trama-models}"
mkdir -p "$DIR"

suffix() {
  case "$1" in
    fp32) echo "" ;;
    q8) echo "_quantized" ;;
    *) echo "_$1" ;;
  esac
}

get() { # repo path
  local out="$DIR/$1/$2"
  [[ -s "$out" ]] && return 0
  mkdir -p "$(dirname "$out")"
  if curl -fsSL --retry 3 -o "$out.part" "https://huggingface.co/$1/resolve/main/$2"; then
    mv "$out.part" "$out"
    echo "  $(du -h "$out" | cut -f1)  $1/$2"
  else
    rm -f "$out.part"
    echo "  missing  $1/$2" >&2
    return 1
  fi
}

fetch() { # repo dtype...
  local repo="$1"
  shift
  echo "== $repo ($*)"
  for f in config.json generation_config.json preprocessor_config.json tokenizer.json tokenizer_config.json; do
    get "$repo" "$f"
  done
  for dtype in "$@"; do
    local s
    s="$(suffix "$dtype")"
    get "$repo" "onnx/encoder_model$s.onnx"
    get "$repo" "onnx/decoder_model_merged$s.onnx"
    # Large fp32 exports keep weights in a side file.
    if [[ "$dtype" == fp32 ]]; then get "$repo" "onnx/encoder_model.onnx_data" 2>/dev/null || true; fi
  done
}

if [[ $# -gt 0 ]]; then
  fetch "$@"
else
  fetch onnx-community/whisper-base q8
  fetch onnx-community/whisper-small q8
  fetch onnx-community/whisper-large-v3-turbo q4f16 q4 q8
fi
du -sh "$DIR"
