// WebM (Opus) → 16 kHz mono Float32, streaming: demux with webm-audio, decode with WebCodecs
// AudioDecoder, downmix and resample as frames arrive. Works in a worker. Gaps in the
// recording (dropped chunks) become silence, so segment times stay in step with the video.
//
// 2 h of 16 kHz mono float is ~460 MB; the spike keeps it in memory, the real feature will
// spill it to OPFS (see PLAN §7).

import { openWebmAudio } from '../media/webm-audio.ts';
import type { RepairSource } from '../media/webm-repair.ts';
import { Resampler } from './resample.ts';

export const SAMPLE_RATE = 16000;

export function blobSource(blob: Blob): RepairSource {
  return {
    size: blob.size,
    read: async (pos, len) => new Uint8Array(await blob.slice(pos, pos + len).arrayBuffer()),
  };
}

export interface DecodeResult {
  audio: Float32Array;
  /** Seconds of silence inserted for gaps in the recording. */
  gapS: number;
  inputRate: number;
  channels: number;
  ms: number;
}

export async function decodeWebmAudio(src: RepairSource, onProgress?: (fraction: number) => void): Promise<DecodeResult> {
  const t0 = performance.now();
  const { track, durationS, packets } = await openWebmAudio(src);
  if (!track) throw new Error('El fitxer no té pista d’àudio.');
  if (!track.codec) throw new Error(`Còdec d’àudio no compatible: ${track.codecId}`);

  const parts: Float32Array[] = [];
  let total = 0;
  const keep = (a: Float32Array) => {
    if (a.length) {
      parts.push(a);
      total += a.length;
    }
  };
  let rs: Resampler | null = null;
  let firstUs: number | null = null;
  let gapSamples = 0;
  let failure: unknown = null;

  const dec = new AudioDecoder({
    output: (ad) => {
      try {
        const sr = ad.sampleRate;
        rs ??= new Resampler(sr, SAMPLE_RATE);
        firstUs ??= ad.timestamp;
        const expected = rs.inputSamples;
        const at = Math.round(((ad.timestamp - firstUs) / 1e6) * sr);
        if (at - expected > sr * 0.05) {
          gapSamples += at - expected;
          keep(rs.pushSilence(at - expected));
        }
        const chans: Float32Array[] = [];
        for (let c = 0; c < ad.numberOfChannels; c++) {
          const a = new Float32Array(ad.numberOfFrames);
          ad.copyTo(a, { planeIndex: c, format: 'f32-planar' });
          chans.push(a);
        }
        keep(rs.push(chans));
      } catch (e) {
        failure = e;
      } finally {
        ad.close();
      }
    },
    error: (e) => {
      failure = e;
    },
  });
  dec.configure({
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    description: track.codecPrivate ?? undefined,
  });

  let lastReport = 0;
  for await (const p of packets()) {
    if (failure) break;
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.timeUs, data: p.data }));
    if (dec.decodeQueueSize > 64) await new Promise((r) => dec.addEventListener('dequeue', r, { once: true }));
    if (onProgress && durationS && p.timeUs - lastReport > 5e6) {
      lastReport = p.timeUs;
      onProgress(Math.min(1, p.timeUs / 1e6 / durationS));
    }
  }
  if (!failure) await dec.flush();
  dec.close();
  if (failure) throw failure;
  const resampler = rs as Resampler | null;
  if (resampler) keep(resampler.flush());

  const audio = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    audio.set(p, at);
    at += p.length;
  }
  return {
    audio,
    gapS: resampler ? gapSamples / resampler.inRate : 0,
    inputRate: resampler?.inRate ?? track.sampleRate,
    channels: track.channels,
    ms: performance.now() - t0,
  };
}
