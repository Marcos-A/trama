// Audio retiming used by the MP4 conversion (src/media/audio-retime.ts), run in Node on
// synthetic packet timelines: a sine wave in 60 ms chunks, stamped as Chrome's recorder would
// with a slow or fast audio clock, jitter, or a gap.

import { expect, test } from '@playwright/test';
import { AudioSample } from 'mediabunny';
import { opusPacketFrames, packetTimeline, retimer, type PacketTiming } from '../../src/media/audio-retime.ts';

const SR = 48000;
const N = 2880; // 60 ms

async function* iterate(packets: PacketTiming[]) {
  yield* packets;
}

/** `count` packets of N frames; packet i stamped at `stamp(i)`. */
function packets(count: number, stamp: (i: number) => number): PacketTiming[] {
  return Array.from({ length: count }, (_, i) => ({ timestamp: stamp(i), frames: N }));
}

/** Runs `count` sine chunks through the retimer; returns the output, flattened, and its samples. */
async function run(stamps: PacketTiming[], startS = 0, interleaved = false) {
  const { process, stats } = retimer(packetTimeline(iterate(stamps), SR), startS);
  const out: number[] = [];
  const timestamps: { t: number; n: number }[] = [];
  for (let k = 0; k < stamps.length; k++) {
    const data = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = Math.sin((2 * Math.PI * 440 * (k * N + i)) / SR);
      if (interleaved) data[2 * i] = data[2 * i + 1] = x;
      else data[i] = data[N + i] = x;
    }
    const format = interleaved ? 'f32' : 'f32-planar';
    const sample = new AudioSample({ data, format, numberOfChannels: 2, sampleRate: SR, timestamp: (k * N) / SR });
    const result = await process(sample);
    for (const s of result === null ? [] : Array.isArray(result) ? result : [result]) {
      expect(s.format, 'output keeps the input layout').toBe(format);
      const ch = new Float32Array(s.numberOfFrames);
      s.copyTo(ch, { planeIndex: 0, format: 'f32-planar' });
      out.push(...ch);
      timestamps.push({ t: s.timestamp, n: s.numberOfFrames });
      s.close();
    }
    sample.close(); // as Mediabunny does after `process`
  }
  return { out, timestamps, stats };
}

/** Each sample starts where the last ended; the largest step between neighbouring frames. */
function expectContinuous({ out, timestamps }: Awaited<ReturnType<typeof run>>) {
  for (let i = 1; i < timestamps.length; i++) {
    const { t, n } = timestamps[i - 1];
    expect(Math.abs(timestamps[i].t - (t + n / SR)), `sample ${i} starts where ${i - 1} ended`).toBeLessThan(1e-6);
  }
  // A 440 Hz sine moves at most 2π·440/48000 ≈ 0.058 per frame; a bare cut can jump up to 2.
  let step = 0;
  for (let i = 1; i < out.length; i++) step = Math.max(step, Math.abs(out[i] - out[i - 1]));
  expect(step, 'largest step between frames (clicks)').toBeLessThan(0.12);
}

test('Opus TOC: frames per packet', () => {
  expect(opusPacketFrames(new Uint8Array([(3 << 3) | 0]))).toBe(2880); // SILK 60 ms, one frame
  expect(opusPacketFrames(new Uint8Array([(31 << 3) | 3, 3]))).toBe(2880); // CELT 20 ms × 3
  expect(opusPacketFrames(new Uint8Array([(15 << 3) | 1]))).toBe(1920); // hybrid 20 ms × 2
  expect(opusPacketFrames(new Uint8Array([(16 << 3) | 0]))).toBe(120); // CELT 2.5 ms
  expect(opusPacketFrames(new Uint8Array([]))).toBeNull();
  expect(opusPacketFrames(new Uint8Array([(31 << 3) | 3]))).toBeNull(); // code 3 without a count
});

test('timeline maps decoded time to packet stamps, and runs on past the last packet', async () => {
  const tl = packetTimeline(iterate([{ timestamp: 0.012, frames: N }, { timestamp: 0.075, frames: N }, { timestamp: 0.13, frames: N }]), SR);
  expect(await tl.timeAt(0)).toBeCloseTo(0.012, 9);
  expect(await tl.timeAt(0.03)).toBeCloseTo(0.042, 9);
  expect(await tl.timeAt(0.06)).toBeCloseTo(0.075, 9);
  expect(await tl.timeAt(0.12 + 0.01)).toBeCloseTo(0.14, 9);
  expect(await tl.timeAt(0.2)).toBeCloseTo(0.13 + 0.08, 9);
});

test('pre-skip: decoded frames are counted from after it, packets keep their stamps', async () => {
  const tl = packetTimeline(iterate([{ timestamp: 1, frames: N }, { timestamp: 2, frames: N }]), SR, 312);
  expect(await tl.timeAt(0)).toBeCloseTo(1 + 312 / SR, 9);
  expect(await tl.timeAt((N - 312) / SR)).toBeCloseTo(2, 9);
});

test('jitter alone is left alone', async () => {
  // ±10 ms around the right place, no skew.
  const r = await run(packets(500, (i) => i * 0.06 + 0.01 * Math.sin(i * 1.7)));
  expect(r.stats).toEqual({ paddedS: 0, pads: 0, trimmedS: 0, trims: 0 });
  expect(r.out.length).toBe(500 * N);
  expectContinuous(r);
});

for (const [what, skew] of [
  ['slow audio clock (3 %): silence goes in', 0.03],
  ['fast audio clock (3 %): audio comes out', -0.03],
  ['slightly slow audio clock (0.1 %)', 0.001],
] as const) {
  test(what, async () => {
    const count = 1000; // 60 s
    const stamps = packets(count, (i) => i * 0.06 * (1 + skew) + 0.004 * Math.sin(i));
    const r = await run(stamps);
    // Where each chunk ended up: the output should end where the recording does.
    const recordedEnd = stamps[count - 1].timestamp + 0.06;
    expect(Math.abs(r.out.length / SR - recordedEnd), 'output length against recorded span').toBeLessThan(0.03);
    if (skew > 0) expect(r.stats.pads).toBeGreaterThan(0);
    else expect(r.stats.trims).toBeGreaterThan(0);
    expectContinuous(r);
  });
}

for (const interleaved of [false, true]) test(`a 2 s gap becomes 2 s of silence at the right place (${interleaved ? 'interleaved' : 'planar'})`, async () => {
  const stamps = packets(100, (i) => i * 0.06 + (i >= 50 ? 2 : 0));
  const r = await run(stamps, 0, interleaved);
  expect(r.stats.pads).toBe(1);
  expect(r.stats.paddedS).toBeCloseTo(2, 3);
  expect(r.out.length).toBe(100 * N + 2 * SR);
  // Silence from just after where chunk 50 would have started to where it was recorded.
  const from = 50 * N + 120;
  expect(r.out.slice(from, from + 2 * SR).every((x) => x === 0)).toBe(true);
  expect(Math.abs(r.out[from + 2 * SR + 200])).toBeGreaterThan(0); // and sound after it
  expectContinuous(r);
});

test('fast clock with interleaved samples (as Chrome decodes): trims keep the layout and stay smooth', async () => {
  const stamps = packets(500, (i) => i * 0.06 * 0.97);
  const r = await run(stamps, 0, true);
  expect(r.stats.trims).toBeGreaterThan(0);
  expect(Math.abs(r.out.length / SR - (stamps[499].timestamp + 0.06))).toBeLessThan(0.03);
  expectContinuous(r);
});

test('audio behind by more than a chunk: whole chunks are dropped', async () => {
  // The stamps step back 0.2 s at chunk 50 (as if the clock had been running fast).
  const stamps = packets(100, (i) => i * 0.06 - (i >= 50 ? 0.2 : 0));
  const r = await run(stamps);
  expect(Math.abs(r.out.length / SR - (stamps[99].timestamp + 0.06))).toBeLessThan(0.03);
  expect(r.stats.trimmedS).toBeGreaterThan(0.17);
});

test('start offset: the output timeline starts at the conversion start', async () => {
  const r = await run(packets(10, (i) => 5 + 0.03 + i * 0.06), 5);
  expect(r.timestamps[0].t).toBeCloseTo(0.03, 9);
});
