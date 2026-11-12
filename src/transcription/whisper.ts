// Whisper long-form transcription in the browser with transformers.js (ONNX Runtime Web,
// WebGPU or WASM), with Catalan/Spanish language handling. Runs in a worker.
//
// transformers.js has no language detection: with no language it decodes as English. So we do
// it ourselves: one decoder step from <|startoftranscript|>, compared over <|ca|> and <|es|>
// only (Whisper otherwise drifts to Galician, Portuguese, Italian…). The encoder output is
// computed once per window and reused for detection and decoding.
//
// Modes (compared by the spike harness):
//   forced-ca / forced-es  every window decoded with that language token
//   window-lid             language detected per 30 s window, window decoded with it
//   segment-lid            forced-ca pass, then each segment's audio re-detected; segments
//                          detected as Spanish are decoded again on their own with <|es|>
// Every segment also gets text-based labels (lid.ts), split at clause level.
//
// Long-form: OpenAI's sequential algorithm. Decode a 30 s window with timestamps; if the last
// segment is cut off by the window edge, the next window starts at that segment's start.

import {
  AutoProcessor,
  AutoTokenizer,
  Tensor,
  WhisperForConditionalGeneration,
  env,
  type PreTrainedTokenizer,
  type Processor,
} from '@huggingface/transformers';
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { splitByLanguage, type Lang, type LangSpan } from './lid.ts';
import { SAMPLE_RATE } from './decode.ts';

// Everything from our own origin: models under /models/, ONNX Runtime's WASM from our bundle.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useWasmCache = false; // otherwise it imports the WASM glue from a blob: URL
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
if (onnx.wasm) {
  onnx.wasm.wasmPaths = { mjs: new URL(ortMjs, self.location.href).href, wasm: new URL(ortWasm, self.location.href).href };
  // Threads need cross-origin isolation (SharedArrayBuffer); without it ORT runs single-threaded.
  onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
}

export type Mode = 'forced-ca' | 'forced-es' | 'window-lid' | 'segment-lid';
export type Device = 'webgpu' | 'wasm';

export interface LoadOptions {
  model: string;
  device: Device;
  /** transformers.js dtype: q8, q4, q4f16, fp16, fp32. */
  dtype: string;
}

export interface Segment {
  start: number;
  end: number;
  lang: Lang;
  /** P(lang) from audio detection, when the mode detected it. */
  p?: number;
  text: string;
}

export interface RunStats {
  audioS: number;
  windows: number;
  encodeMs: number;
  lidMs: number;
  decodeMs: number;
  redecodes: number;
  /** Windows retried with sampling because the greedy text looped. */
  fallbacks: number;
  totalMs: number;
  /** Real-time factor: processing time / audio time (lower is faster). */
  rtf: number;
}

export interface RunResult {
  mode: Mode;
  segments: Segment[];
  /** Same text, labelled per clause from the text alone. */
  textSpans: LangSpan[];
  /** Raw decoder output per window, special tokens included (for inspection). */
  raw: string[];
  stats: RunStats;
}

const WINDOW = 30 * SAMPLE_RATE;
const TIME_PRECISION = 0.02;
const MAX_TOKENS = 224; // OpenAI's sample_len; a dense 30 s window needs ~150
const TEMPERATURES = [0, 0.4, 0.8];
const MAX_RATIO = 2.4;

interface Decoded {
  segments: { start: number; end: number; text: string }[];
  open: { start: number; text: string } | null;
  /** Ended with <|endoftext|> rather than running out of tokens. */
  ended: boolean;
  raw: string;
}

interface GenConfig {
  decoder_start_token_id: number;
  no_timestamps_token_id: number;
  eos_token_id: number | number[];
  lang_to_id: Record<string, number>;
  task_to_id: Record<string, number>;
}

export class WhisperRunner {
  private constructor(
    private readonly model: WhisperForConditionalGeneration,
    private readonly processor: Processor,
    private readonly tokenizer: PreTrainedTokenizer,
    private readonly gen: GenConfig,
    readonly loadMs: number,
  ) {}

  static async load(opts: LoadOptions, onProgress?: (p: { file: string; loaded: number; total: number }) => void): Promise<WhisperRunner> {
    const t0 = performance.now();
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === 'progress' && p.file && onProgress) onProgress({ file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    };
    const [model, processor, tokenizer] = await Promise.all([
      WhisperForConditionalGeneration.from_pretrained(opts.model, {
        device: opts.device,
        dtype: { encoder_model: opts.dtype, decoder_model_merged: opts.dtype } as never,
        progress_callback,
      }),
      AutoProcessor.from_pretrained(opts.model),
      AutoTokenizer.from_pretrained(opts.model),
    ]);
    const gen = (model as unknown as { generation_config: GenConfig }).generation_config;
    if (!gen.lang_to_id?.['<|ca|>'] || !gen.lang_to_id?.['<|es|>']) throw new Error('model has no <|ca|>/<|es|> tokens');
    return new WhisperRunner(model as WhisperForConditionalGeneration, processor, tokenizer, gen, performance.now() - t0);
  }

  private async features(audio: Float32Array): Promise<Tensor> {
    const { input_features } = await (this.processor as unknown as (a: Float32Array) => Promise<{ input_features: Tensor }>)(audio);
    return input_features;
  }

  private async encode(features: Tensor): Promise<Tensor | null> {
    const m = this.model as unknown as {
      _prepare_encoder_decoder_kwargs_for_generation?: (a: object) => Promise<{ encoder_outputs: Tensor }>;
      generation_config: object;
    };
    if (!m._prepare_encoder_decoder_kwargs_for_generation) return null;
    const r = await m._prepare_encoder_decoder_kwargs_for_generation({
      inputs_tensor: features,
      model_inputs: { input_features: features },
      model_input_name: 'input_features',
      generation_config: m.generation_config,
    });
    return r.encoder_outputs;
  }

  /** P(ca) vs P(es) from the first decoder step. */
  private async detect(features: Tensor, encoder: Tensor | null): Promise<{ lang: Lang; p: number }> {
    const sot = BigInt(this.gen.decoder_start_token_id);
    const decoder_input_ids = new Tensor('int64', BigInt64Array.from([sot]), [1, 1]);
    const inputs = encoder ? { encoder_outputs: encoder, decoder_input_ids } : { input_features: features, decoder_input_ids };
    const out = (await (this.model as unknown as (x: object) => Promise<{ logits: Tensor }>)(inputs)).logits;
    const logits = out.data as Float32Array;
    const vocab = out.dims[out.dims.length - 1];
    const row = logits.length - vocab; // last position
    const ca = logits[row + this.gen.lang_to_id['<|ca|>']];
    const es = logits[row + this.gen.lang_to_id['<|es|>']];
    const pCa = 1 / (1 + Math.exp(es - ca));
    return pCa >= 0.5 ? { lang: 'ca', p: pCa } : { lang: 'es', p: 1 - pCa };
  }

  /** Decodes one window (≤ 30 s) with timestamps; times relative to the window. */
  private async decodeWindow(features: Tensor, encoder: Tensor | null, lang: Lang, temperature: number): Promise<Decoded> {
    const out = (await this.model.generate({
      inputs: features,
      ...(encoder ? { encoder_outputs: encoder } : {}),
      language: lang,
      task: 'transcribe',
      return_timestamps: true,
      max_new_tokens: MAX_TOKENS,
      ...(temperature > 0 ? { do_sample: true, temperature, top_k: 0 } : {}),
    } as never)) as Tensor;
    const ids = Array.from((out?.data ?? []) as BigInt64Array, Number);
    if (ids.length === 0) throw new Error(`generate returned no tokens (dims ${out?.dims}, T=${temperature})`);
    const tsBegin = this.gen.no_timestamps_token_id + 1;
    const eos = Array.isArray(this.gen.eos_token_id) ? this.gen.eos_token_id : [this.gen.eos_token_id];
    const ended = ids.some((t) => eos.includes(t));
    const words = (t: number[]) => (t.length ? this.tokenizer.decode(t, { skip_special_tokens: true }).trim() : '');
    const raw = renderTokens(ids, tsBegin, this.gen.decoder_start_token_id, words, (id) => this.tokenizer.decode([id], { skip_special_tokens: false }));
    // Skip the prompt: <|sot|><|lang|><|transcribe|>
    const body = ids.slice(3).filter((t) => !eos.includes(t));
    const segments: { start: number; end: number; text: string }[] = [];
    let start: number | null = null;
    let text: number[] = [];
    for (const t of body) {
      if (t >= tsBegin) {
        const time = (t - tsBegin) * TIME_PRECISION;
        if (start === null) start = time;
        else if (text.length) {
          segments.push({ start, end: time, text: words(text) });
          start = null;
          text = [];
        } else start = time; // two timestamps in a row: the next segment starts here
      } else if (t < this.gen.decoder_start_token_id) text.push(t);
    }
    // Text with no closing timestamp: cut by the window edge, or the token budget ran out.
    const open = text.length ? { start: start ?? 0, text: words(text) } : null;
    return { segments: segments.filter((x) => x.text), open, ended, raw };
  }

  /**
   * Decodes a window greedily; if the text is repetitive (gzip ratio > 2.4, Whisper's
   * hallucination loops) or the token budget ran out, retries with sampling at rising
   * temperature, as OpenAI's transcribe() does. Keeps the least repetitive attempt.
   */
  private async transcribeWindow(features: Tensor, encoder: Tensor | null, lang: Lang, stats: RunStats): Promise<Decoded & { ratio: number }> {
    let best: (Decoded & { ratio: number }) | null = null;
    for (const temperature of TEMPERATURES) {
      if (temperature > 0) stats.fallbacks++;
      const d = await this.decodeWindow(features, encoder, lang, temperature);
      const text = [...d.segments.map((x) => x.text), d.open?.text ?? ''].join(' ');
      const ratio = await compressionRatio(text);
      if (!best || ratio < best.ratio) best = { ...d, ratio };
      if (ratio <= MAX_RATIO && d.ended) break;
    }
    return best!;
  }

  async run(audio: Float32Array, mode: Mode, onProgress?: (doneS: number, totalS: number) => void): Promise<RunResult> {
    const t0 = performance.now();
    const stats: RunStats = { audioS: audio.length / SAMPLE_RATE, windows: 0, encodeMs: 0, lidMs: 0, decodeMs: 0, redecodes: 0, fallbacks: 0, totalMs: 0, rtf: 0 };
    const segments: Segment[] = [];
    const raw: string[] = [];
    let seek = 0;
    while (seek < audio.length - SAMPLE_RATE * 0.2) {
      const win = audio.subarray(seek, Math.min(seek + WINDOW, audio.length));
      const isLast = seek + WINDOW >= audio.length;
      const offset = seek / SAMPLE_RATE;
      stats.windows++;
      if (rms(win) < 1e-4) {
        seek += win.length; // digital silence: nothing to say, and Whisper would invent text
        continue;
      }
      let t = performance.now();
      const feats = await this.features(win);
      const enc = await this.encode(feats);
      stats.encodeMs += performance.now() - t;

      let lang: Lang = mode === 'forced-es' ? 'es' : 'ca';
      let p: number | undefined;
      if (mode === 'window-lid') {
        t = performance.now();
        ({ lang, p } = await this.detect(feats, enc));
        stats.lidMs += performance.now() - t;
      }
      t = performance.now();
      const d = await this.transcribeWindow(feats, enc, lang, stats);
      raw.push(`${offset.toFixed(2)} ${d.raw}`);
      stats.decodeMs += performance.now() - t;
      const winS = win.length / SAMPLE_RATE;
      for (const s of d.segments) segments.push({ start: offset + s.start, end: offset + s.end, lang, p, text: s.text });
      // A segment cut by the window edge is decoded again from its start in the next window;
      // otherwise (last window, or no usable timestamp) its text is kept up to the window end.
      const resume = !isLast && d.open && d.ended && d.open.start >= 1 ? d.open.start : null;
      if (d.open && resume === null && d.ratio <= MAX_RATIO && d.open.text)
        segments.push({ start: offset + d.open.start, end: offset + winS, lang, p, text: d.open.text });
      seek += Math.round((resume ?? winS) * SAMPLE_RATE);
      onProgress?.(Math.min(seek, audio.length) / SAMPLE_RATE, stats.audioS);
    }

    if (mode === 'segment-lid') {
      for (const s of segments) {
        const a = Math.max(0, Math.floor((s.start - 0.2) * SAMPLE_RATE));
        const b = Math.min(audio.length, Math.ceil((s.end + 0.2) * SAMPLE_RATE));
        let t = performance.now();
        const feats = await this.features(audio.subarray(a, b));
        const enc = await this.encode(feats);
        stats.encodeMs += performance.now() - t;
        t = performance.now();
        const d = await this.detect(feats, enc);
        stats.lidMs += performance.now() - t;
        s.p = d.p;
        if (d.lang === 'es') {
          t = performance.now();
          const again = await this.transcribeWindow(feats, enc, 'es', stats);
          stats.decodeMs += performance.now() - t;
          stats.redecodes++;
          const text = [...again.segments.map((x) => x.text), again.open?.text ?? ''].join(' ').trim();
          if (text && again.ratio <= MAX_RATIO) s.text = text;
        }
        s.lang = d.lang;
      }
    }

    stats.totalMs = performance.now() - t0;
    stats.rtf = stats.totalMs / 1000 / stats.audioS;
    const textSpans = segments.flatMap((s) => splitByLanguage(s, s.lang));
    return { mode, segments, textSpans, raw, stats };
  }
}

/** Decoder output as text with <|timestamps|> and special tokens, for inspection. */
function renderTokens(ids: number[], tsBegin: number, firstSpecial: number, words: (t: number[]) => string, special: (id: number) => string): string {
  let out = '';
  let text: number[] = [];
  const flush = () => {
    if (text.length) out += ` ${words(text)} `;
    text = [];
  };
  for (const t of ids) {
    if (t >= tsBegin) {
      flush();
      out += `<|${((t - tsBegin) * TIME_PRECISION).toFixed(2)}|>`;
    } else if (t >= firstSpecial - 1) {
      flush();
      out += special(t);
    } else text.push(t);
  }
  flush();
  return out;
}

/** gzip-style compressibility of the text; Whisper's repetition loops score > 2.4. */
async function compressionRatio(text: string): Promise<number> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length < 50) return 1;
  const packed = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  return bytes.length / packed.byteLength;
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 4) s += a[i] * a[i];
  return Math.sqrt(s / Math.ceil(a.length / 4));
}
