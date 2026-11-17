// Keeps the MP4's audio on the WebM's recorded timeline (PLAN §7, src/media/webm-to-mp4.ts).
//
// Chrome's MediaRecorder stamps each 60 ms Opus packet with capture (wall-clock) time, and the
// video frames the same way, so the WebM stays in sync even when the tab's audio clock and the
// system clock disagree, or when the audio has a gap. Decoding throws those stamps away: the
// decoded audio comes out back to back (Chrome's decoder and Mediabunny count samples, and
// Mediabunny only re-syncs once it is a whole packet off), and the encoder lays it back to back
// again, so in the MP4 the sound follows its sample count while the picture keeps the WebM's
// frame times. Any skew becomes drift.
//
// The fix runs in Mediabunny's `audio.process` hook. The packet stamps are read alongside the
// conversion with an EncodedPacketSink, one packet at a time, and each decoded frame is mapped to
// the stamp of the packet it came from by counting frames (Opus packets say how many they hold;
// container durations are not trusted). Before each decoded chunk goes to the encoder, the
// output's end is compared with where that chunk was recorded:
//  - source ahead by more than the dead band (a gap, or an audio clock running slow): silence is
//    inserted, so the chunk lands where it was recorded;
//  - source behind by more than the dead band (an audio clock running fast): frames are dropped;
//  - otherwise the chunk goes through as it is. Packet stamps jitter by ~10 ms; the 20 ms dead
//    band leaves that alone.
// Each cut gets a short fade (a crossfade when dropping), so it does not click.
//
// Why pad and trim rather than resample: what has to be fixed in practice is gaps (tab audio
// stalling or the recorder skipping), where silence is the right answer and stretching is not;
// the clock skew seen on Macs is so small that a correction is due every few minutes at most.
// Only headless Chromium's fake audio device is far enough off (0.1–3 %) to correct often.
//
// Streaming: nothing is held beyond the current chunk and packet; silence comes from one shared
// buffer of zeros, so a long gap costs no memory.

import { AudioSample, EncodedPacketSink, type InputAudioTrack } from 'mediabunny';

export interface RetimeStats {
  /** Silence inserted, in seconds, and how many times. */
  paddedS: number;
  pads: number;
  /** Audio dropped, in seconds, and how many times. */
  trimmedS: number;
  trims: number;
}

export interface RetimeOptions {
  /** Errors up to this size (seconds) are left alone. */
  deadBandS?: number;
  /** Length of the fades at each cut (seconds). */
  fadeS?: number;
}

/** Where each decoded frame was recorded, from the packets' timestamps. */
export interface RecordedTimeline {
  /** Recorded time (s, file timeline) of the audio `decodedS` into the decoded track; never called going backwards. */
  timeAt(decodedS: number): Promise<number>;
  close(): void;
}

export interface PacketTiming {
  timestamp: number;
  /** Frames the packet decodes to. */
  frames: number;
}

/**
 * Timeline over packets in decode order: each packet's first frame sits at its timestamp. The
 * decoder drops `preskip` frames at the start (Opus pre-skip; Chrome writes 0), so decoded
 * frame F is stream frame F + preskip.
 */
export function packetTimeline(
  packets: AsyncIterator<PacketTiming>,
  sampleRate: number,
  preskip = 0,
): RecordedTimeline {
  let start = 0; // first stream frame of `current`
  let current: PacketTiming | null = null;
  let done = false;
  return {
    async timeAt(decodedS) {
      const at = Math.round(decodedS * sampleRate) + preskip;
      while (!done && (current === null || at >= start + current.frames)) {
        const next = await packets.next();
        if (next.done) {
          done = true;
          break;
        }
        if (current) start += current.frames;
        current = next.value;
      }
      if (!current) return decodedS; // no packets: nothing to map to
      // Past the last packet the timeline just runs on from it.
      return current.timestamp + (at - start) / sampleRate;
    },
    close() {
      void packets.return?.();
    },
  };
}

/** Frames in an Opus packet at 48 kHz, from its TOC byte (RFC 6716 §3.1); null if malformed. */
export function opusPacketFrames(data: Uint8Array): number | null {
  if (data.length === 0) return null;
  const toc = data[0];
  const config = toc >> 3;
  const ms = config < 12 ? [10, 20, 40, 60][config % 4] : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4];
  const code = toc & 3;
  const count = code === 0 ? 1 : code === 3 ? (data.length > 1 ? data[1] & 0x3f : 0) : 2;
  return count ? ms * 48 * count : null;
}

/** The recorded timeline of a WebM audio track, read packet by packet as the conversion goes. */
export async function trackTimeline(track: InputAudioTrack): Promise<RecordedTimeline> {
  const sampleRate = await track.getSampleRate();
  const opus = (await track.getCodec()) === 'opus';
  let preskip = 0;
  if (opus) {
    const description = (await track.getDecoderConfig())?.description;
    if (description) {
      const head = ArrayBuffer.isView(description)
        ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
        : new Uint8Array(description);
      if (head.length >= 12) preskip = head[10] | (head[11] << 8); // OpusHead pre-skip, at 48 kHz
      preskip = Math.round((preskip * sampleRate) / 48000);
    }
  }
  const packets = new EncodedPacketSink(track).packets();
  async function* timings(): AsyncGenerator<PacketTiming> {
    try {
      for await (const p of packets) {
        const opusFrames = opus ? opusPacketFrames(p.data) : null;
        const frames = opusFrames !== null ? Math.round((opusFrames * sampleRate) / 48000) : Math.round(p.duration * sampleRate);
        yield { timestamp: p.timestamp, frames };
      }
    } finally {
      await packets.return?.();
    }
  }
  return packetTimeline(timings(), sampleRate, preskip);
}

/**
 * An `audio.process` hook that puts each decoded chunk where `timeline` says it was recorded,
 * minus `startS` (the conversion's start timestamp). Returns the hook and its running totals.
 */
export function retimer(
  timeline: RecordedTimeline,
  startS: number,
  { deadBandS = 0.02, fadeS = 0.0025 }: RetimeOptions = {},
): { process: (sample: AudioSample) => Promise<AudioSample | AudioSample[] | null>; stats: RetimeStats } {
  const stats: RetimeStats = { paddedS: 0, pads: 0, trimmedS: 0, trims: 0 };
  let inFrames = 0; // decoded frames seen so far, at `rate`
  let outStartS: number | null = null;
  let outFrames = 0; // frames sent on, at `rate`
  let rate = 0;
  let zeros = new Float32Array(0);

  // New samples keep the decoder's layout (Chrome gives interleaved f32), so the encoder is never
  // fed a mix; any other format becomes planar f32.
  let format: 'f32' | 'f32-planar' = 'f32-planar';
  /** A sample from planar channel data. */
  const make = (planes: Float32Array[], frames: number, sampleRate: number, timestamp: number) => {
    const channels = planes.length;
    const data = new Float32Array(frames * channels);
    if (format === 'f32') {
      for (let c = 0; c < channels; c++) for (let i = 0; i < frames; i++) data[i * channels + c] = planes[c][i];
    } else {
      planes.forEach((p, c) => data.set(p.subarray(0, frames), c * frames));
    }
    return new AudioSample({ data, format, numberOfChannels: channels, sampleRate, timestamp });
  };
  /** Silence, in samples of up to 1 s over one shared buffer of zeros (the same in either layout). */
  const silence = (frames: number, channels: number, sampleRate: number, timestamp: number) => {
    const chunk = sampleRate; // 1 s per sample, all over the same zeros
    if (zeros.length < chunk * channels) zeros = new Float32Array(chunk * channels);
    const out: AudioSample[] = [];
    for (let done = 0; done < frames; done += chunk) {
      const n = Math.min(chunk, frames - done);
      const data = zeros.subarray(0, n * channels);
      out.push(new AudioSample({ data, format, numberOfChannels: channels, sampleRate, timestamp: timestamp + done / sampleRate }));
    }
    return out;
  };
  const planesOf = (sample: AudioSample) =>
    Array.from({ length: sample.numberOfChannels }, (_, c) => {
      const p = new Float32Array(sample.numberOfFrames);
      sample.copyTo(p, { planeIndex: c, format: 'f32-planar' });
      return p;
    });

  async function process(sample: AudioSample): Promise<AudioSample | AudioSample[] | null> {
    const sr = sample.sampleRate;
    const n = sample.numberOfFrames;
    if (rate && sr !== rate) throw new DOMException(`audio sample rate changed (${rate} → ${sr} Hz)`, 'NotSupportedError');
    rate = sr;
    format = sample.format === 'f32' ? 'f32' : 'f32-planar';
    // In seconds, not frames: `process` sees samples after any resampling to the encoder's rate.
    const recordedS = (await timeline.timeAt(inFrames / sr)) - startS;
    inFrames += n;
    if (outStartS === null) outStartS = recordedS;
    const outS = outStartS + outFrames / sr;
    const errorS = recordedS - outS;
    const fade = Math.max(1, Math.round(fadeS * sr));

    if (errorS > deadBandS) {
      // Source ahead: silence before this chunk (after a fade-out over its first frames).
      const gap = Math.round(errorS * sr);
      stats.paddedS += gap / sr;
      stats.pads++;
      const out: AudioSample[] = [];
      let at = outS;
      if (n >= 2 * fade) {
        const planes = planesOf(sample);
        for (const p of planes) {
          for (let i = 0; i < fade; i++) {
            p[i] *= 1 - (i + 0.5) / fade; // head fades out
            p[fade + i] *= (i + 0.5) / fade; // rest fades back in after the silence
          }
        }
        out.push(make(planes, fade, sr, at));
        at += fade / sr;
        out.push(...silence(gap, planes.length, sr, at));
        at += gap / sr;
        out.push(make(planes.map((p) => p.subarray(fade)), n - fade, sr, at));
      } else {
        out.push(...silence(gap, sample.numberOfChannels, sr, at));
        at += gap / sr;
        sample.setTimestamp(at);
        out.push(sample);
      }
      outFrames += gap + n;
      return out;
    }

    if (errorS < -deadBandS) {
      // Source behind: drop frames from the start of this chunk, crossfading over the cut.
      const drop = Math.round(-errorS * sr);
      stats.trims++;
      if (drop + fade >= n) {
        stats.trimmedS += n / sr;
        return null; // the whole chunk; the next one carries on with what is left
      }
      stats.trimmedS += drop / sr;
      const planes = planesOf(sample);
      for (const p of planes) {
        for (let i = 0; i < fade; i++) {
          const w = (i + 0.5) / fade;
          p[drop + i] = p[i] * (1 - w) + p[drop + i] * w;
        }
      }
      const kept = n - drop;
      const out = make(planes.map((p) => p.subarray(drop)), kept, sr, outS);
      outFrames += kept;
      return out;
    }

    sample.setTimestamp(outS);
    outFrames += n;
    return sample;
  }

  return { process, stats };
}
