// Long synthetic recording (manual checks 5a, 5b and 8c without Teams): records SOAK_MINUTES of
// the synthetic stream with A/V markers, then checks the log (no chunk gaps, no silence, heap
// flat), the repaired WebM (duration, seeking, sync), and its MP4 conversion (same). Only runs
// when SOAK_MINUTES is set:
//
//   SOAK_MINUTES=120 bash scripts/test.sh --project=soak
//
// Headless Chromium is never throttled like a hidden tab on a Mac, so this does not replace
// check 3; it shows that Trama itself holds up over the length of a meeting.
//
// The MP4's sound is checked against the WebM, not on its own: headless Chromium's audio clock
// runs slow, which the MP4 turns into drift (see tests/helpers/av-sync.ts).

import type { Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { expectInSync, expectMp4MatchesWebm, measureSync } from '../helpers/av-sync.ts';
import { expect, fakeSavePicker, opfsFiles, playerReady, record, test } from '../e2e/fixtures.ts';

const MINUTES = Number(process.env.SOAK_MINUTES);
const PERIOD_S = 10;
const BAD_EVENTS = [
  'chunk-gap',
  'audio-silence-start',
  'track-ended',
  'track-muted',
  'recorder-error',
  'write-error',
  'repair-failed',
  'player-error',
  'mp4-failed',
  'pageerror',
];

interface Entry {
  at: string;
  ev: string;
  data?: Record<string, unknown>;
}

/** Plays an OPFS file in a fresh <video> and seeks to each fraction of its length. */
async function seekFile(page: Page, dir: string, name: string, fractions: number[]) {
  return page.evaluate(
    async ({ dir, name, fractions }) => {
      const root = await navigator.storage.getDirectory();
      const file = await (await (await root.getDirectoryHandle(dir)).getFileHandle(name)).getFile();
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(file);
      await new Promise<void>((ok, fail) => {
        v.onloadedmetadata = () => ok();
        v.onerror = () => fail(new Error(`video error ${v.error?.code}: ${v.error?.message}`));
      });
      const seeks = [];
      for (const f of fractions) {
        const target = v.duration * f;
        const t0 = performance.now();
        await new Promise<void>((ok) => {
          v.addEventListener('seeked', () => ok(), { once: true });
          v.currentTime = target;
        });
        seeks.push({ target, at: v.currentTime, ms: Math.round(performance.now() - t0) });
      }
      URL.revokeObjectURL(v.src);
      return { duration: v.duration, size: file.size, seeks };
    },
    { dir, name, fractions },
  );
}

const step = (what: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${what}`);

/** Median of the samples' heap in the first and last thirds, and the peak. */
function heapTrend(samples: number[]) {
  const third = Math.max(1, Math.floor(samples.length / 3));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return { first: median(samples.slice(0, third)), last: median(samples.slice(-third)), max: Math.max(...samples) };
}

test.skip(!MINUTES, 'set SOAK_MINUTES to run');

test(`${MINUTES}-minute recording: no gaps, heap flat, repairs, seeks, converts, stays in sync`, async ({ openApp }) => {
  test.setTimeout((MINUTES * 60 + 3600) * 1000);
  const page = await openApp({ markers: PERIOD_S });
  const seconds = MINUTES * 60;

  step('recording');
  await record(page, seconds * 1000);
  step('stopping');
  await page.click('#atura');
  await expect(page.locator('#vista-desat')).toBeVisible({ timeout: 900_000 });
  step('saved; checking the player');
  const player = await playerReady(page);
  const [webm] = await opfsFiles(page);
  step('seeking the WebM');
  const webmSeek = await seekFile(page, 'recordings', webm.name, [0.5, 0.99]);
  step('measuring WebM sync');
  const webmSync = await measureSync(page, 'recordings', webm.name, PERIOD_S);

  step('converting to MP4');
  await fakeSavePicker(page);
  await page.fill('#nom', 'soak');
  await page.click('#desa-mp4');
  await expect(page.locator('#missatge')).toContainText('Vídeo desat en MP4', { timeout: 3_600_000 });
  step('seeking the MP4');
  const mp4Seek = await seekFile(page, 'picked', 'soak.mp4', [0.5, 0.99]);
  step('measuring MP4 sync');
  const mp4Sync = await measureSync(page, 'picked', 'soak.mp4', PERIOD_S, { from: webmSync });

  step('reading the log');
  // The on-page log keeps only the last 300 lines; the downloaded JSON has every entry.
  await page.click('#panell-registre summary');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#baixa-registre')]);
  const entries = (JSON.parse(readFileSync((await download.path())!, 'utf8')) as { entries: Entry[] }).entries;
  const one = (ev: string) => entries.find((e) => e.ev === ev)?.data ?? {};
  const samples = entries.filter((e) => e.ev === 'sample').map((e) => e.data!.heapMB as number);
  const mp4Samples = entries.filter((e) => e.ev === 'mp4-sample').map((e) => e.data!.heapMB as number);
  const offsets = (r: typeof webmSync) => r.markers.map((m) => (m.offsetS === null ? null : Math.round(m.offsetS * 1000)));

  const summary = {
    minutes: MINUTES,
    stopped: one('recording-stopped'),
    badEvents: entries.filter((e) => BAD_EVENTS.includes(e.ev)),
    heap: heapTrend(samples),
    maxWriteMs: Math.max(...entries.filter((e) => e.ev === 'sample').map((e) => e.data!.maxWriteMs as number)),
    repair: one('repair'),
    webm: { bytes: webm.size, playerDuration: player.duration, seeks: webmSeek.seeks, syncMs: offsets(webmSync), audioClockSkew: webmSync.audioClockSkew },
    mp4: { ...one('mp4'), heap: mp4Samples.length ? heapTrend(mp4Samples) : null, seeks: mp4Seek.seeks, syncMs: offsets(mp4Sync) },
  };
  writeFileSync(test.info().outputPath('soak-summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(test.info().outputPath('soak-log.json'), JSON.stringify(entries, null, 2));
  writeFileSync(test.info().outputPath('soak-sync.json'), JSON.stringify({ webmSync, mp4Sync }, null, 2));
  console.log(JSON.stringify(summary, null, 2));

  expect(summary.stopped).toMatchObject({ reason: 'user' });
  expect(summary.badEvents).toEqual([]);
  // Heap flat: the recording is written to disk, not held in memory.
  expect(summary.heap.last - summary.heap.first, 'heap growth (MB)').toBeLessThan(10);
  expect(summary.heap.max, 'peak heap (MB)').toBeLessThan(100);
  expect(Math.abs(player.duration - seconds), 'repaired duration against recording time').toBeLessThan(5);
  for (const s of [...webmSeek.seeks, ...mp4Seek.seeks]) expect(Math.abs(s.at - s.target)).toBeLessThan(0.5);
  expect(Math.abs(mp4Seek.duration - webmSeek.duration), 'MP4 length against WebM').toBeLessThan(0.5);
  if (summary.mp4.heap) expect(summary.mp4.heap.max - summary.mp4.heap.first, 'heap growth while converting (MB)').toBeLessThan(20);
  const minMarkers = Math.min(25, Math.floor(seconds / PERIOD_S) - 1);
  expectInSync(webmSync, minMarkers);
  expectMp4MatchesWebm(mp4Sync, webmSync);
});
