// Measures A/V sync in a recording made with the synthetic markers (fixtures.ts `markers`):
// decodes a short window around each marker with Mediabunny and compares when the frame turns
// white with when the beep starts. Positive offset = picture after sound.
//
// Two clocks are involved. The beeps are `periodS` apart in audio samples. Chrome's WebM stamps
// each audio packet and video frame with capture (wall-clock) time, so in the WebM the beeps are
// `periodS` apart only if the audio clock keeps time with the system clock; the flashes, timed
// on the audio clock, follow them, and picture and sound stay together either way. Headless
// Chromium's fake audio device runs 0.1–3 % slow, so the difference is large here; on a Mac the
// clocks agree closely.
//
// Decoding loses the packet stamps (the decoder and Mediabunny count samples, and Mediabunny
// only re-syncs once it is a whole packet, 60 ms, off), so WebM beeps are timed here from the
// packets themselves: each window is decoded with WebCodecs and every decoded packet placed at
// its own timestamp. The MP4's audio is contiguous, so its decoded timing is its packet timing.
//
// The MP4 conversion puts the audio back on the WebM's recorded timeline (src/media/
// audio-retime.ts), so the MP4 must be in sync on its own (`expectInSync`) and its beeps must
// sit at the WebM's beep times (`expectMp4MatchesWebm`).

import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const MEDIABUNNY_URL = '/__test__/mediabunny.mjs';
const ANALYSIS_PAGE = '/__test__/analyse.html';

export interface Marker {
  /** Marker number: the k-th beep after the first. */
  k: number;
  /** Where the beep was looked for. */
  expectedS: number;
  audioS: number | null;
  videoS: number | null;
  /** Picture minus sound, when both were found. */
  offsetS: number | null;
}

export interface SyncReport {
  durationS: number;
  /** Beep spacing against `periodS`, minus 1: how far the audio clock is from the file's timeline. */
  audioClockSkew: number;
  markers: Marker[];
}

/**
 * A blank page on the app's origin (so it sees the same OPFS) but without the app's CSP, which
 * would block the worker Mediabunny starts, plus Mediabunny itself. Both are test-only routes.
 */
export async function openAnalysisPage(app: Page): Promise<Page> {
  const context = app.context();
  const mediabunny = readFileSync('node_modules/mediabunny/dist/bundles/mediabunny.min.mjs'); // tests run from the repo root
  await context.route(`**${MEDIABUNNY_URL}`, (r) => r.fulfill({ body: mediabunny, contentType: 'text/javascript' }));
  await context.route(`**${ANALYSIS_PAGE}`, (r) => r.fulfill({ body: '<!doctype html><title>analyse</title>', contentType: 'text/html' }));
  const page = await context.newPage();
  await page.goto(new URL(ANALYSIS_PAGE, app.url()).href);
  return page;
}

/**
 * `dir/name` in OPFS, with markers every `periodS` s; checks at most `maxMarkers`, spread evenly.
 * With `from` (the WebM's report, when measuring its MP4), looks for the same markers where the
 * WebM had them.
 */
export async function measureSync(
  app: Page,
  dir: string,
  name: string,
  periodS: number,
  { maxMarkers = 25, from }: { maxMarkers?: number; from?: SyncReport } = {},
): Promise<SyncReport> {
  const page = await openAnalysisPage(app);
  const report = await page.evaluate(
    async ({ url, dir, name, periodS, maxMarkers, from }) => {
      const mb = await import(url);
      const root = await navigator.storage.getDirectory();
      const file = await (await (await root.getDirectoryHandle(dir)).getFileHandle(name)).getFile();
      const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const durationS: number = await input.computeDuration();
      const audioTrack = await input.getPrimaryAudioTrack();
      const audio = new mb.AudioBufferSink(audioTrack);
      const packetTimed = (await input.getFormat()) instanceof mb.MatroskaInputFormat;
      const video = new mb.CanvasSink(await input.getPrimaryVideoTrack(), { width: 32, height: 18, fit: 'fill', poolSize: 2 });
      const half = periodS / 2 - 0.3; // search window around each expected marker

      // Channel 0 of [from, to), as chunks placed at their packet's timestamp (WebM) or at their
      // decoded timestamp (MP4). The WebM window starts a few packets early to warm the decoder.
      async function* chunks(from: number, to: number): AsyncGenerator<{ data: Float32Array; timestamp: number; sampleRate: number }> {
        if (!packetTimed) {
          for await (const { buffer, timestamp } of audio.buffers(Math.max(0, from), to)) {
            yield { data: buffer.getChannelData(0), timestamp, sampleRate: buffer.sampleRate };
          }
          return;
        }
        const sink = new mb.EncodedPacketSink(audioTrack);
        const first = (await sink.getPacket(Math.max(0, from - 0.2))) ?? (await sink.getFirstPacket());
        const stamps: number[] = [];
        const decoded: AudioData[] = [];
        let failed: unknown = null;
        const decoder = new AudioDecoder({ output: (d) => decoded.push(d), error: (e) => (failed = e) });
        decoder.configure(await audioTrack.getDecoderConfig());
        for await (const p of sink.packets(first)) {
          if (p.timestamp >= to) break;
          stamps.push(p.timestamp);
          decoder.decode(p.toEncodedAudioChunk());
        }
        await decoder.flush();
        decoder.close();
        if (failed) throw failed;
        if (decoded.length !== stamps.length) throw new Error(`${decoded.length} decoded chunks for ${stamps.length} packets`);
        for (let i = 0; i < decoded.length; i++) {
          const d = decoded[i];
          const data = new Float32Array(d.numberOfFrames);
          d.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
          const sampleRate = d.sampleRate; // read before close, which zeroes it
          d.close();
          yield { data, timestamp: stamps[i], sampleRate };
        }
      }

      // A beep starts where the level jumps above 0.4 after ≥ 0.1 s below it (the hum is 0.05).
      async function beeps(from: number, to: number): Promise<number[]> {
        const out: number[] = [];
        let lastLoud = -Infinity;
        for await (const { data: ch, timestamp, sampleRate } of chunks(Math.max(0, from), to)) {
          for (let i = 0; i < ch.length; i++) {
            if (Math.abs(ch[i]) < 0.4) continue;
            const t = timestamp + i / sampleRate;
            if (t - lastLoud > 0.1 && t >= from) out.push(t);
            lastLoud = t;
          }
        }
        return out;
      }
      // A flash starts at the first frame whose darkest channel averages above 200.
      async function flashes(from: number, to: number): Promise<number[]> {
        const out: number[] = [];
        let wasWhite = false;
        for await (const { canvas, timestamp } of video.canvases(Math.max(0, from), to)) {
          const px = (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 32, 18).data;
          let sum = 0;
          for (let i = 0; i < px.length; i += 4) sum += Math.min(px[i], px[i + 1], px[i + 2]);
          const white = sum / (px.length / 4) > 200;
          if (white && !wasWhite && timestamp >= from) out.push(timestamp);
          wasWhite = white;
        }
        return out;
      }
      const nearest = (xs: number[], t: number) =>
        xs.reduce<number | null>((best, x) => (best === null || Math.abs(x - t) < Math.abs(best - t) ? x : best), null);
      async function marker(k: number, expectedA: number, expectedV: number) {
        const a = nearest(await beeps(expectedA - half, expectedA + half), expectedA);
        const v = nearest(await flashes(expectedV - half, expectedV + half), expectedV);
        return { k, expectedS: expectedA, audioS: a, videoS: v, offsetS: a === null || v === null ? null : v - a };
      }

      const markers = [];
      let spacing = periodS;
      const [a0] = from ? [] : await beeps(0, Math.min(durationS, periodS + 2));
      if (from) {
        for (const w of from.markers) markers.push(await marker(w.k, w.audioS ?? w.expectedS, w.videoS ?? w.expectedS));
        const found = markers.filter((m) => m.audioS !== null);
        const [f, l] = [found[0], found.at(-1)];
        if (f && l && l.k > f.k) spacing = (l.audioS! - f.audioS!) / (l.k - f.k);
      } else if (a0 !== undefined) {
        // Follow the beeps' spacing as it is measured, so a skewed clock keeps them in the window.
        const a1 = nearest(await beeps(a0 + periodS - half, a0 + periodS + half), a0 + periodS);
        if (a1 !== null) spacing = a1 - a0;
        const count = Math.floor((durationS - 0.5 - a0) / spacing) + 1;
        const ks =
          count <= maxMarkers
            ? [...Array(count).keys()]
            : [...new Set([...Array(maxMarkers).keys()].map((i) => Math.round((i * (count - 1)) / (maxMarkers - 1))))];
        for (const k of ks) {
          const expected = a0 + k * spacing;
          if (expected > durationS - 0.3) break;
          const m = await marker(k, expected, expected);
          if (m.audioS !== null && k > 0) spacing = (m.audioS - a0) / k;
          markers.push(m);
        }
      }
      input.dispose();
      return { durationS, audioClockSkew: spacing / periodS - 1, markers };
    },
    { url: MEDIABUNNY_URL, dir, name, periodS, maxMarkers, from },
  );
  await page.close();
  return report;
}

/**
 * Every checked marker found, each within 0.15 s, and no drift: the median offset of the last
 * markers within 0.1 s of the first ones'. A median, not the full spread, because a flash can
 * only land on a 33 ms frame and a busy server delays the odd one by a frame or two more
 * (one +83 ms marker among 25 in the first 2-hour run, with no trend at all).
 */
export function expectInSync(report: SyncReport, minMarkers: number): void {
  const offsets = report.markers.map((m) => m.offsetS);
  expect(offsets.length, `markers found in ${report.durationS.toFixed(1)} s`).toBeGreaterThanOrEqual(minMarkers);
  expect(offsets, 'every marker has both a flash and a beep').not.toContain(null);
  const values = offsets as number[];
  // The manual criterion is 0.5 s; the synthetic pipeline should do far better.
  for (const o of values) expect(Math.abs(o), 'picture-minus-sound offset').toBeLessThan(0.15);
  const n = Math.max(1, Math.min(5, Math.floor(values.length / 2)));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  expect(Math.abs(median(values.slice(-n)) - median(values.slice(0, n))), 'drift: last markers against the first').toBeLessThan(0.1);
}

/**
 * The MP4 against the WebM it came from, marker by marker: each flash at the WebM's time (the
 * picture keeps its timing) and each beep at the WebM's time (the audio keeps its recorded
 * timing, within the converter's 20 ms dead band).
 */
export function expectMp4MatchesWebm(mp4: SyncReport, webm: SyncReport): void {
  expect(mp4.markers.length, 'markers in the MP4').toBe(webm.markers.length);
  webm.markers.forEach((w, i) => {
    const m = mp4.markers[i];
    expect(m.videoS, `marker ${w.k}: flash found`).not.toBeNull();
    expect(m.audioS, `marker ${w.k}: beep found`).not.toBeNull();
    expect(Math.abs(m.videoS! - w.videoS!), `marker ${w.k}: flash time, MP4 against WebM`).toBeLessThan(0.05);
    expect(Math.abs(m.audioS! - w.audioS!), `marker ${w.k}: beep time, MP4 against WebM`).toBeLessThan(0.035);
  });
}
