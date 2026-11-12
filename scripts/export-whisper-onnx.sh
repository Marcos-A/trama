#!/usr/bin/env bash
# Exports a Hugging Face Whisper checkpoint (PyTorch/safetensors) to the ONNX layout
# transformers.js loads: encoder_model*.onnx + decoder_model_merged*.onnx, quantised.
# For fine-tunes published without ONNX (BSC/AINA Catalan models, duhow turbo-cat…).
#
#   bash scripts/export-whisper-onnx.sh duhow/whisper-large-v3-turbo-cat            # q8 q4f16 q4
#   bash scripts/export-whisper-onnx.sh BSC-LT/whisper-timestamped-cs q4f16
#
# Uses the conversion scripts of transformers.js 3.8.1 (the last release that ships them;
# the ONNX layout is unchanged in 4.x) in a throwaway Python container, CPU only. Output goes
# to $TRAMA_MODELS_DIR/<model id>/.
#
# Memory: the fp32 export holds the model ~2–3×. Turbo (809 M params) peaks around 8 GB; a
# full large-v3 (1.55 B) needs ~16 GB, more than this server has free: run it on a bigger
# machine (any with Docker) and copy the result into the models directory.
set -euo pipefail

MODEL="${1:?model id, e.g. duhow/whisper-large-v3-turbo-cat}"
shift
MODES="${*:-q8 q4f16 q4}"
DIR="${TRAMA_MODELS_DIR:-/srv/apps/trama-models}"
mkdir -p "$DIR" "$DIR/.cache"

INNER=$(cat <<'SH'
set -euo pipefail
cd /tmp
python -m venv v && . v/bin/activate
pip install -q --index-url https://download.pytorch.org/whl/cpu torch==2.6.0
python -c '
import os, urllib.request
os.makedirs("scripts", exist_ok=True)
open("scripts/__init__.py", "w").close()
for f in ["convert.py", "quantize.py", "float16.py", "utils.py", "requirements.txt"]:
    urllib.request.urlretrieve(f"https://raw.githubusercontent.com/huggingface/transformers.js/3.8.1/scripts/{f}", f"scripts/{f}")
'
# optimum is pinned to a git commit upstream; fetch that commit as an archive (no git here).
sed -i 's#optimum@git+https://github.com/huggingface/optimum.git@\([0-9a-f]*\)#optimum @ https://github.com/huggingface/optimum/archive/\1.zip#' scripts/requirements.txt
pip install -q -r scripts/requirements.txt
python -m scripts.convert --quantize --modes $MODES --model_id "$MODEL" --output_parent_dir /out --skip_validation
SH
)

docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e HF_HOME=/cache -e MODEL="$MODEL" -e MODES="$MODES" \
  -v "$DIR:/out" -v "$DIR/.cache:/cache" python:3.12-slim bash -c "$INNER"
echo "== exported to $DIR/$MODEL"
ls -la "$DIR/$MODEL" "$DIR/$MODEL/onnx"
