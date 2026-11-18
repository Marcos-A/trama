// Finds clicks in the audio of a recording made with the synthetic markers (fixtures.ts
// `markers`): the hum is a 440 Hz sine, whose sample-to-sample change stays under 6–7 % of its
// level, so a jump of more than 30 % of the recent level (plus a small floor for codec noise) is
// a discontinuity, as a cut without a fade would make. The beeps switch level abruptly by
// design, so jumps near a beep's start or end are ignored, with room for AAC's pre-echo, and so
// are the first and last 0.1 s, where the hum starts and stops with the stream.
// Runs on the WebM as a control (it must be clean) and on the MP4, where the converter pads and
// trims audio (src/media/audio-retime.ts) with short fades that must not click.

import { expect, type Page } from '@playwright/test';
import { MEDIABUNNY_URL, openAnalysisPage } from './av-sync.ts';

export interface ClickReport {
  seconds: number;
  /** Discontinuities away from the beeps' edges (first 20). */
  clicks: { atS: number; jump: number; level: number }[];
  count: number;
  /** When every click falls, in seconds to the millisecond (all of them, unlike `clicks`). */
  times: number[];
  /** Beep edges found (starts and ends), for a sanity check that the detector saw the markers. */
  edges: number;
}

export async function findClicks(app: Page, dir: string, name: string): Promise<ClickReport> {
  const page = await openAnalysisPage(app);
  const report = await page.evaluate(
    async ({ url, dir, name }) => {
      const mb = await import(url);
      const root = await navigator.storage.getDirectory();
      const file = await (await (await root.getDirectoryHandle(dir)).getFileHandle(name)).getFile();
      const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      const audio = new mb.AudioBufferSink(await input.getPrimaryAudioTrack());

      const EDGE_GUARD_S = 0.06; // AAC frames are 1024 samples; pre-echo can reach a window back
      const candidates: { atS: number; jump: number; level: number }[] = [];
      const edges: number[] = [];
      let level = 0; // recent peak, decaying by half every ~10 ms
      let prev: number | null = null;
      let loud = false;
      let lastLoudAt = -Infinity;
      let t = 0; // decoded audio is contiguous; time by sample count
      for await (const { buffer } of audio.buffers()) {
        const ch = buffer.getChannelData(0);
        const dt = 1 / buffer.sampleRate;
        const decay = Math.pow(0.5, dt / 0.01);
        for (let i = 0; i < ch.length; i++, t += dt) {
          const x = ch[i];
          const a = Math.abs(x);
          if (a >= 0.4) {
            if (!loud && t - lastLoudAt > 0.1) edges.push(t); // beep starts
            loud = true;
            lastLoudAt = t;
          } else if (loud && t - lastLoudAt > 0.005) {
            edges.push(lastLoudAt); // beep ended
            loud = false;
          }
          if (prev !== null) {
            const jump = Math.abs(x - prev);
            if (jump > 0.3 * level + 0.01) candidates.push({ atS: t, jump, level });
          }
          level = Math.max(a, level * decay);
          prev = x;
        }
      }
      input.dispose();
      const nearEdge = (s: number) => edges.some((e) => Math.abs(e - s) < EDGE_GUARD_S);
      // The hum starts and stops abruptly with the stream, so its first and last 0.1 s are skipped.
      const clicks = candidates.filter((c) => c.atS > 0.1 && c.atS < t - 0.1 && !nearEdge(c.atS));
      return {
        seconds: t,
        clicks: clicks.slice(0, 20),
        count: clicks.length,
        times: clicks.map((c) => Math.round(c.atS * 1000) / 1000),
        edges: edges.length,
      };
    },
    { url: MEDIABUNNY_URL, dir, name },
  );
  await page.close();
  return report;
}

/** No clicks, and the markers were seen (so the detector looked at real audio). */
export function expectNoClicks(report: ClickReport, minEdges: number): void {
  expect(report.edges, 'beep edges found').toBeGreaterThanOrEqual(minEdges);
  expect(report.clicks, `clicks in ${report.seconds.toFixed(1)} s of audio`).toEqual([]);
}

/**
 * The MP4 adds no clicks of its own: each one it has sits where the WebM already had one, give or
 * take `toleranceS` (the converter's pads and trims shift the audio by up to their total). For
 * real tab capture without a sound card (the server, and the macOS CI VM), whose stand-in audio
 * output glitches under load, so the WebM itself is not clean there. Times, not counts: AAC can
 * split one glitch into more detections than the WebM's Opus gives (37 against 40 once, all at
 * the same places).
 */
export function expectNoNewClicks(mp4: ClickReport, webm: ClickReport, minEdges: number, toleranceS: number): void {
  expect(mp4.edges, 'beep edges found').toBeGreaterThanOrEqual(minEdges);
  const added = mp4.times.filter((t) => !webm.times.some((w) => Math.abs(w - t) <= toleranceS));
  expect(added, 'clicks in the MP4 that the WebM does not have').toEqual([]);
}
