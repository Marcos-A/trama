# Transcription spike (phase 2)

Branch `transcription`. Goal: choose an in-browser speech-recognition model and approach for
Catalan/Spanish meetings where speakers switch language freely (PLAN §1 phase 2, §7). Nothing
here is product UI yet: the harness is a dev page (`eval.html`), built only with
`TRAMA_EVAL=1`, never in the deploy image.

Status (2026-11-12): research done, harness built and tested on synthetic audio, server
measurements in [§4](#4-measurements-headless-chromium-on-the-server). Approach direction is
clear (forced `<|ca|>` decoding + our own per-span language tags); **the model choice waits
for a real mixed-language excerpt + reference** and the Mac WebGPU timings.

## 1. Shortlist

Every option below runs fully in the browser (Chrome/Edge); none sends audio anywhere.
Sizes are download sizes for the encoder + merged decoder in the format each device wants:
q4f16 for WebGPU, q8 for the WASM (CPU) fallback.

| Model | Params | WebGPU q4f16 / WASM q8 | Licence | Catalan | Spanish | Code-switching |
|---|---|---|---|---|---|---|
| Whisper base ([onnx-community](https://huggingface.co/onnx-community/whisper-base)) | 74 M | 142 MB (q4) / 77 MB | MIT | poor | fair | none; loops on hard audio |
| Whisper small ([onnx-community](https://huggingface.co/onnx-community/whisper-small)) | 244 M | 299 MB (q4) / 249 MB | MIT | fair | good | follows the audio, see §4 |
| Whisper large-v3-turbo ([onnx-community](https://huggingface.co/onnx-community/whisper-large-v3-turbo)) | 809 M | 564 MB / 1085 MB | MIT | CV 26 WER 19.2 %¹ | very good | drifts to the window's language, see §4 |
| **turbo fine-tuned for Catalan** ([duhow/whisper-large-v3-turbo-cat](https://huggingface.co/duhow/whisper-large-v3-turbo-cat)) | 809 M | same as turbo (we export, §3) | MIT | CV 26 WER 5.1 %¹ | unknown (Catalan-only LoRA; risk) | unknown |
| BSC [whisper-bsc-large-v3-cat](https://huggingface.co/BSC-LT/whisper-bsc-large-v3-cat), [ca-punctuated-3370h](https://huggingface.co/BSC-LT/whisper-large-v3-ca-punctuated-3370h) | 1.55 B | ≈ 1.0 GB / ≈ 1.9 GB (est., we export) | Apache-2.0 | 3CatParla / CV accents 3–5 % | not reported | not trained for it |
| **BSC [whisper-timestamped-cs](https://huggingface.co/BSC-LT/whisper-timestamped-cs)** (= langtech-veu; supersedes projecte-aina/whisper-large-v3-tiny-caesar) | 1.55 B | ≈ 1.0 GB / ≈ 1.9 GB (est., we export) | Apache-2.0 | good | good | **trained for ca/es switching** (2 h synthetic CAESAR-TINY); paper² CS WER 14.5–23.5 % vs. 21–32 % for large-v3 |

¹ Model card numbers, Common Voice 26 Catalan test (duhow ran both). ² [Interspeech 2025,
arXiv 2507.13875](https://arxiv.org/abs/2507.13875): best with the synthetic data and the
`<|ca|>` token forced; Spanish passages still come out in Spanish.

**Per-segment language:** no candidate outputs it. Whisper picks one language token per
30 s window, transformers.js does not even detect it (with no language it silently decodes as
English), and the BSC code-switching model is decoded with `<|ca|>` forced. So the language
of each passage is added by us, two ways, both in the harness:
- *audio*: one decoder step over `<|ca|>` / `<|es|>` only (a window, or each segment's audio);
- *text*: a Catalan-vs-Spanish scorer on the transcribed words (`src/transcription/lid.ts`),
  per clause, so a switch inside one Whisper segment is marked too. Free, and independent of
  the model.

**Considered and set aside:**
- *Chrome on-device Web Speech API* (`processLocally`): about 60 MB language packs, but one
  language per session, real-time only (a 2 h recording takes 2 h), and no documented
  Catalan pack. Worth one check on the Mac (`SpeechRecognition.available({langs:['ca-ES'],
  processLocally:true})`), not a candidate.
- *Parakeet-TDT-0.6B-v3* (NVIDIA, CC-BY-4.0): 25 EU languages, Catalan not among them.
- *Vosk* (Kaldi, Apache-2.0): small ca and es models, one language per recogniser, much lower
  accuracy than Whisper.
- *whisper.cpp in WASM*: same Whisper weights, CPU only (no WebGPU), needs cross-origin
  isolation for threads: slower than ONNX Runtime Web on WebGPU for the same quality.
- *Moonshine* and other English-first small models: no Catalan.

## 2. Changes each option needs (none applied; asking before any)

All candidates run on ONNX Runtime Web through transformers.js, so they share the list:

1. **CSP `'wasm-unsafe-eval'`** — required: ONNX Runtime compiles WebAssembly even when the
   model runs on WebGPU. Proposed scope: *only on the transcription worker's script responses*
   (`/assets/transcribe.worker-*.js`, `/assets/ort-wasm-simd-threaded*.mjs`), via a separate
   nginx `location` with its own header include. A dedicated worker takes its CSP from its own
   response, so the recording page keeps today's policy. The harness already runs this way
   (`vite.config.ts`, tested in `tests/e2e/transcription.spec.ts`). `connect-src 'self'` stays.
2. **Model files on our origin** — `/models/<id>/…` served by nginx from a read-only volume
   (`/srv/apps/trama-models`), not baked into the image. 0.6–1.9 GB per model and dtype;
   production needs one model in one or two dtypes. Paths versioned (`/models/<id>@<rev>/`) so
   they can be `Cache-Control: immutable`. No gzip on `.onnx` (quantised weights barely
   compress). Disk: 26 GB free on the server today.
3. **ONNX Runtime WASM** — 27 MB (6.8 MB gzipped) `ort-wasm-simd-threaded.asyncify.wasm`
   bundled by Vite into `/assets/` (transformers.js would otherwise fetch it from jsDelivr,
   which the CSP blocks). nginx must serve `.wasm` as `application/wasm` and `.mjs` as
   JavaScript (to check in `nginx:stable-alpine`'s `mime.types`).
4. **Bandwidth** — each browser downloads the model once (≈ 0.6 GB WebGPU / ≈ 1.1 GB WASM for
   turbo), then serves it from its cache. Caddy proxies GETs; `request_body` limits are
   unaffected.
5. **Browser caching** — the model must survive reloads: store it in OPFS (we already use it
   for recordings) or the Cache API, request `navigator.storage.persist()`, and check
   `storage.estimate()` against recording space (a 2 h recording is 1–3 GB, plus 0.5 GB
   decoded audio during transcription).
6. **Optional: cross-origin isolation** (`Cross-Origin-Opener-Policy: same-origin`,
   `Cross-Origin-Embedder-Policy: require-corp`) — only to give the WASM fallback threads
   (SharedArrayBuffer). WebGPU does not need it. All our subresources are same-origin, so
   nothing breaks, but it is a header change on the page; measured in §4 to decide whether it
   is worth it.
7. **Unchanged:** `Permissions-Policy` (no mic/camera), `connect-src 'self'`, no server-side
   processing, no new third-party origin.

## 3. Harness

| Piece | File |
|---|---|
| WebM audio demux (streaming, raw or repaired files) | `src/media/webm-audio.ts` |
| Opus decode (WebCodecs) → 16 kHz mono, gaps → silence | `src/transcription/decode.ts`, `resample.ts` |
| Whisper long-form + language modes | `src/transcription/whisper.ts` |
| Text language ID, per clause | `src/transcription/lid.ts` |
| WER per language, tag accuracy | `src/transcription/score.ts` |
| Worker / page | `src/transcription/transcribe.worker.ts`, `eval.html`, `src/eval/` |

**Modes compared** (each also scored with text-based labels on the same output):
- `forced-ca`, `forced-es` — every window decoded with that language token;
- `window-lid` — language detected per 30 s window (Whisper's own behaviour, restricted to
  ca/es), window decoded with it;
- `segment-lid` — `forced-ca`, then each segment's audio re-detected; segments heard as
  Spanish are decoded again with `<|es|>`.

Long-form follows OpenAI's algorithm (sequential 30 s windows, resume at a cut segment;
temperature fallback when the text loops). Encoder output is computed once per window and
reused for detection and decoding.

**Scoring:** the reference is plain text (or SRT/VTT/JSON) with `[ca]` / `[es]` where the
language changes, inline for switches inside a turn. One word alignment over the whole
excerpt (no timestamps needed): WER overall and per language (errors charged to the language
of the reference word, so Spanish translated into Catalan shows up as Spanish WER), and
language-tag accuracy over aligned words. Numbers are compared as written (`10` ≠ `deu`).

**Running it:**
```sh
bash scripts/fetch-models.sh                                   # stock Whisper ONNX → /srv/apps/trama-models
bash scripts/export-whisper-onnx.sh duhow/whisper-large-v3-turbo-cat   # fine-tunes without ONNX
TRAMA_EVAL=1 npx vite build --outDir dist-eval && TRAMA_EVAL=1 npx vite preview --outDir dist-eval
# → http://localhost:4173/eval.html  (?coi=1 for WASM threads)
bash scripts/test.sh --project=transcription                   # harness tests (headless)
TRAMA_MEASURE='onnx-community/whisper-small:q8:coi' bash scripts/test.sh --project=transcription -g measure
```
Test audio that must not enter the repo lives in `/srv/apps/trama-eval-data` (mounted
read-only by `test.sh`, served at `/eval-data/` by the eval build).

## 4. Measurements (headless Chromium on the server)

Server: 6 cores, no GPU (headless Chromium has no WebGPU adapter here), so these are WASM
numbers; WebGPU timings come from the Mac checklist (`docs/manual-tests.md`).

Run 2026-11-12, HeadlessChrome 158, `tests/e2e/transcription-measure.spec.ts`. Peak memory
is the summed PSS of all Chromium processes. RTF = processing time / audio time.

**Audio decode** (`long-2h-av.webm`: the 7 s VP9+Opus fixture looped to 1 h 59 min, 198 MB):
102 s for 7162 s of audio (**70× real time**), no gaps, peak 1.47 GB. The peak comes from
holding the 16 kHz float audio (460 MB) and concatenating it once; the real feature should
stream it to OPFS (or int16) instead.

**Models on WASM** (synthetic 31 s fixture: espeak-ng Catalan/Spanish turns, one switch
inside a turn). Robotic TTS, so WER only ranks models against each other; it says nothing
about real meetings.

| Model (q8, WASM) | Threads | Mode | RTF | Peak | WER all / ca / es |
|---|---|---|---|---|---|
| whisper-small | 1 | forced-ca | 2.05 | 2.0 GB | 64 / 70 / 58 % |
| whisper-small | 6 (`?coi=1`) | forced-ca | 1.15 | 2.0 GB | same |
| whisper-small | 6 | window-lid | 1.11 | 1.8 GB | 72 / 91 / 52 % |
| whisper-small | 1 / 6 | segment-lid | 14.6 / 5.7 | 1.8 GB | 69 / 85 / 52 % |
| whisper-large-v3-turbo | 6 | forced-ca | 3.47 | 4.1 GB | **33 / 42 / 23 %** |
| whisper-large-v3-turbo | 6 | window-lid | 3.18 | 2.9 GB | 55 / 85 / 23 % |

What this shows:
- **Window-level detection translates.** When a window is detected as Spanish, Whisper writes
  the Catalan in it *in Spanish*, fluently: turbo turned "Bon dia a tothom. Avui parlarem del
  pressupost…" into "Buen día a todos. Hoy hablaremos del presupuesto…". That breaks the core
  requirement and is invisible to a reader. Whisper's default behaviour (one language per
  window) is ruled out.
- **Forcing `<|ca|>` keeps each language as spoken** on both models: Spanish turns come out in
  Spanish ("Creo que deberíamos retrasar la primera fase dos semanas."), and turbo even kept
  the switch inside a turn ("…el equip encara no té tota la informació"). This matches the
  BSC paper (best results with `<|ca|>` forced). Some drift remains at switches (Spanish
  words in a Catalan span and the reverse).
- **Per-segment audio detection is expensive in this form:** Whisper's encoder always takes
  30 s of input, so each segment costs a full encoder pass (RTF ×3–7). It is only affordable
  for the few spans the text cannot decide.
- **Text labels alone are not enough** where the model's own output mixes languages ("però
  antes quiero…"): 50 % tag accuracy on turbo's output here, because the mixed spans carry
  contradictory words. Real speech should give cleaner text; the plan is text first, audio
  detection for weak spans.
- **Threads help ~1.8×** (cross-origin isolation). turbo on CPU is ~3.5× slower than real time
  (a 1 h meeting ≈ 3.5 h): WASM is a fallback only; WebGPU is required for turbo-sized models.
- Headless Chromium on the server has **no WebGPU adapter**, so WebGPU numbers come from the
  Mac checklist.

## 5. Open points

- Real-audio evaluation (5–10 min mixed excerpt + reference, kept out of the repo).
- Whether a Catalan-only fine-tune keeps Spanish passages in Spanish (risk: translating them).
- Whether audio language detection from a Catalan fine-tune is still usable, or the text
  labels must carry it.
- Exporting the fine-tunes: turbo-cat (≈ 8 GB RAM during export) fits this server only when
  it is otherwise quiet; the BSC large-v3 models (≈ 16 GB) need a bigger machine.
- Text language ID is a word list; if real audio shows it is the weak link, replace it with a
  character n-gram model trained on public Catalan/Spanish text.
