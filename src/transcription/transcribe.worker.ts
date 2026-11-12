// Transcription worker: decodes a recording's audio to 16 kHz and runs Whisper on it.
// Nothing here makes a network request except same-origin model and runtime files.

import { env } from '@huggingface/transformers';
import { blobSource, decodeWebmAudio } from './decode.ts';
import { WhisperRunner, type LoadOptions, type Mode } from './whisper.ts';

export type Request =
  | { type: 'decode'; file: Blob }
  | { type: 'audio'; audio: Float32Array }
  | { type: 'load'; opts: LoadOptions }
  | { type: 'run'; mode: Mode };

export type Reply =
  | { type: 'decoded'; seconds: number; ms: number; gapS: number; inputRate: number; channels: number; peak: number[] }
  | { type: 'loaded'; ms: number; isolated: boolean; threads: number }
  | { type: 'progress'; stage: 'decode' | 'load' | 'run'; fraction: number; detail?: string }
  | { type: 'result'; result: Awaited<ReturnType<WhisperRunner['run']>> }
  | { type: 'error'; message: string };

let audio: Float32Array | null = null;
let runner: WhisperRunner | null = null;
const post = (r: Reply) => (self as unknown as Worker).postMessage(r);

self.onmessage = async (ev: MessageEvent<Request>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'decode') {
      const r = await decodeWebmAudio(blobSource(msg.file), (f) => post({ type: 'progress', stage: 'decode', fraction: f }));
      audio = r.audio;
      post({ type: 'decoded', seconds: audio.length / 16000, ms: r.ms, gapS: r.gapS, inputRate: r.inputRate, channels: r.channels, peak: peaks(audio) });
    } else if (msg.type === 'audio') {
      audio = msg.audio;
      post({ type: 'decoded', seconds: audio.length / 16000, ms: 0, gapS: 0, inputRate: 16000, channels: 1, peak: peaks(audio) });
    } else if (msg.type === 'load') {
      runner = null;
      runner = await WhisperRunner.load(msg.opts, (p) =>
        post({ type: 'progress', stage: 'load', fraction: p.total ? p.loaded / p.total : 0, detail: p.file }),
      );
      const wasm = env.backends.onnx as { wasm?: { numThreads?: number } };
      post({ type: 'loaded', ms: runner.loadMs, isolated: self.crossOriginIsolated, threads: wasm.wasm?.numThreads ?? 1 });
    } else if (msg.type === 'run') {
      if (!audio) throw new Error('no audio decoded yet');
      if (!runner) throw new Error('no model loaded');
      const result = await runner.run(audio, msg.mode, (done, total) => post({ type: 'progress', stage: 'run', fraction: done / total }));
      post({ type: 'result', result });
    }
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
};

/** Coarse level per second, for a sanity check that there is sound. */
function peaks(a: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 16000) {
    let m = 0;
    for (let j = i; j < Math.min(a.length, i + 16000); j++) m = Math.max(m, Math.abs(a[j]));
    out.push(Math.round(m * 1000) / 1000);
  }
  return out;
}
