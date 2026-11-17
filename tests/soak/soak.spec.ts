// Long synthetic recording (manual checks 5a, 5b and 8c without Teams): records SOAK_MINUTES of
// the synthetic stream with A/V markers, then checks the log (no chunk gaps, no silence, heap
// flat), the repaired WebM (duration, seeking, sync), and its MP4 conversion (same). Only runs
// when SOAK_MINUTES is set:
//
//   SOAK_MINUTES=120 bash scripts/test.sh --project=soak
//
// It also looks for clicks in the audio (tests/helpers/clicks.ts) and, on macOS, requires AAC and
// has AVFoundation (QuickTime's framework) decode the MP4 to the end: the Mac re-checks of 8a
// (SOAK_MINUTES=5) and 8c (60), run by .github/workflows/mac.yml in installed Chrome and Edge.
//
// With SOAK_CAPTURE=real it records a meeting tab through Chrome's real tab capture instead
// (tests/capture, tests/helpers/meeting-tab.ts), in a browser started as a user has it, and keeps
// Trama and the meeting tab hidden from the first minute to the last, and again during the MP4
// conversion: check 3 at full length, through Chrome's intensive throttling (after 5 minutes
// hidden). The synthetic stream is generated inside Trama's own page, so without it this does
// not replace check 3; it shows that Trama itself holds up over the length of a meeting.
//
// Headless Chromium's audio clock runs slow; the MP4 has to keep the WebM's recorded audio timing
// regardless, so it is checked in sync on its own and marker by marker against the WebM (see
// tests/helpers/av-sync.ts). The summary has the converter's corrections (`mp4.audioRetime`).

import type { Page } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectInSync, expectMp4MatchesWebm, measureSync } from '../helpers/av-sync.ts';
import { avfoundationCheck, expectPlaysInQuickTime, onMac, saveOpfsFile } from '../helpers/avfoundation.ts';
import { expectNoClicks, findClicks } from '../helpers/clicks.ts';
import { expect, fakeSavePicker, opfsFiles, playerReady, record, test as base } from '../e2e/fixtures.ts';
import { hideTabs } from '../helpers/meeting-tab.ts';
import { launchRealBrowser } from '../helpers/real-browser.ts';

const REAL = process.env.SOAK_CAPTURE === 'real';

// A normal browser profile on disk instead of Playwright's default private-mode context, whose
// small storage quota fits a 2-hour recording but not the second copy the repair needs.
const test = base.extend({
  context: async ({ playwright, baseURL, channel, headless, launchOptions }, use) => {
    if (REAL) {
      const real = await launchRealBrowser(channel, launchOptions.args ?? []);
      await use(real.context);
      await real.close();
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'trama-soak-'));
    // Same browser as the project (bundled Chromium, or installed Chrome or Edge on macOS).
    const context = await playwright.chromium.launchPersistentContext(dir, { ...launchOptions, channel, headless, baseURL, acceptDownloads: true });
    await use(context);
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  },
});

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
  const page = await openApp({ markers: PERIOD_S, ...(REAL ? { capture: 'real' as const } : {}) });
  const seconds = MINUTES * 60;

  step('recording');
  let hiddenS = 0;
  if (REAL && seconds > 180) {
    await record(page, 60_000);
    step('hiding Trama and the meeting tab');
    const show = await hideTabs(page);
    hiddenS = seconds - 120;
    await page.waitForTimeout(hiddenS * 1000);
    await show();
    step('shown again');
    await page.waitForTimeout(60_000);
  } else {
    await record(page, seconds * 1000);
  }
  step('stopping');
  await page.click('#atura');
  await expect(page.locator('#vista-desat')).toBeVisible({ timeout: 900_000 });
  await expect(page.locator('main'), 'repair skipped for lack of space').not.toContainText('No hi ha prou espai');
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
  const showAfterMp4 = REAL ? await hideTabs(page) : null;
  await expect(page.locator('#missatge')).toContainText('Vídeo desat en MP4', { timeout: 3_600_000 });
  await showAfterMp4?.();
  step('seeking the MP4');
  const mp4Seek = await seekFile(page, 'picked', 'soak.mp4', [0.5, 0.99]);
  step('measuring MP4 sync');
  const mp4Sync = await measureSync(page, 'picked', 'soak.mp4', PERIOD_S, { from: webmSync });

  step('looking for clicks');
  const webmClicks = await findClicks(page, 'recordings', webm.name);
  const mp4Clicks = await findClicks(page, 'picked', 'soak.mp4');
  let quicktime = null;
  if (onMac) {
    step('decoding the MP4 with AVFoundation');
    const path = test.info().outputPath('soak.mp4');
    await saveOpfsFile(page, 'picked', 'soak.mp4', path);
    quicktime = avfoundationCheck(path);
  }

  step('reading the log');
  // The on-page log keeps only the last 300 lines; the downloaded JSON has every entry. Read from
  // the Blob the page builds for the download (a CDP-attached browser saves downloads itself).
  await page.click('#panell-registre summary');
  await page.evaluate(() => {
    const create = URL.createObjectURL;
    URL.createObjectURL = (b: Blob | MediaSource) => {
      (window as unknown as { __logBlob: unknown }).__logBlob = b;
      return create(b);
    };
    document.querySelector<HTMLAnchorElement>('#baixa-registre')!.click();
  });
  const logText = await page.evaluate(() => ((window as unknown as { __logBlob: Blob }).__logBlob).text());
  const entries = (JSON.parse(logText) as { entries: Entry[] }).entries;
  const one = (ev: string) => entries.find((e) => e.ev === ev)?.data ?? {};
  const samples = entries.filter((e) => e.ev === 'sample').map((e) => e.data!.heapMB as number);
  const mp4Samples = entries.filter((e) => e.ev === 'mp4-sample').map((e) => e.data!.heapMB as number);
  const offsets = (r: typeof webmSync) => r.markers.map((m) => (m.offsetS === null ? null : Math.round(m.offsetS * 1000)));

  const summary = {
    minutes: MINUTES,
    capture: REAL ? { real: true, hiddenS, visibility: entries.filter((e) => e.ev === 'visibility').map((e) => [e.at, e.data]) } : 'synthetic',
    storageAtStart: one('storage'),
    stopped: one('recording-stopped'),
    badEvents: entries.filter((e) => BAD_EVENTS.includes(e.ev)),
    heap: heapTrend(samples),
    maxWriteMs: Math.max(...entries.filter((e) => e.ev === 'sample').map((e) => e.data!.maxWriteMs as number)),
    repair: one('repair'),
    webm: { bytes: webm.size, playerDuration: player.duration, seeks: webmSeek.seeks, syncMs: offsets(webmSync), audioClockSkew: webmSync.audioClockSkew },
    clicks: { webm: webmClicks, mp4: mp4Clicks },
    quicktime,
    mp4: { ...one('mp4'), heap: mp4Samples.length ? heapTrend(mp4Samples) : null, seeks: mp4Seek.seeks, syncMs: offsets(mp4Sync), audioClockSkew: mp4Sync.audioClockSkew },
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
  // Real capture: without the first marker, in the first second while the picture starts
  // (see tests/capture).
  const checked = (r: typeof webmSync) => (REAL ? { ...r, markers: r.markers.filter((m) => m.expectedS >= 2) } : r);
  expectInSync(checked(webmSync), minMarkers - (REAL ? 1 : 0));
  expectInSync(checked(mp4Sync), minMarkers - (REAL ? 1 : 0));
  expectMp4MatchesWebm(checked(mp4Sync), checked(webmSync));
  const minEdges = 2 * minMarkers;
  // Real capture without a sound card (the server, the macOS CI VM) goes through the browser's
  // stand-in sound output, which glitches under load: dozens of clicks in the WebM itself, so
  // the counts are only reported (tests/capture checks the MP4 adds none).
  if (!REAL) {
    expectNoClicks(webmClicks, minEdges);
    expectNoClicks(mp4Clicks, minEdges);
  }
  if (onMac) {
    expect(summary.mp4).toMatchObject({ audioCodec: 'aac' });
    expectPlaysInQuickTime(quicktime!, webmSync.durationS);
  }
});
