// Chrome's real tab capture of a meeting tab (tests/helpers/meeting-tab.ts), in a headed
// browser: what the synthetic stream cannot show. Trama's getDisplayMedia call runs unchanged;
// only the picker is skipped (--auto-select-tab-capture-source-by-title, playwright.config.ts).
//
// Automates, without Teams: 1 and 2 (picture and sound in sync through tab capture), 3 (both
// tabs hidden while recording; CAPTURE_HIDDEN_S sets how long, default 60 s; over 5 min reaches
// Chrome's intensive throttling), 7b (the shared tab goes away mid-recording) and 7f (tab audio
// arrives untouched: stereo, no voice processing). Teams itself, the real picker and the
// "Stop sharing" bar stay manual (docs/manual-tests.md).

import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expectInSync, expectMp4MatchesWebm, measureSync, type SyncReport } from '../helpers/av-sync.ts';
import { expectNoClicks, expectNoNewClicks, findClicks } from '../helpers/clicks.ts';
import { hideTabs, MEETING_TITLE, webrtcWorks } from '../helpers/meeting-tab.ts';
import { onMac } from '../helpers/avfoundation.ts';
import { expect, fakeSavePicker, logEvents, opfsFiles, playerReady, record, stopAndWaitSaved, test } from '../e2e/fixtures.ts';

const PERIOD_S = 3;
const HIDDEN_S = Number(process.env.CAPTURE_HIDDEN_S) || 60;
const BAD_EVENTS = ['chunk-gap', 'audio-silence-start', 'track-ended', 'track-muted', 'recorder-error', 'write-error', 'repair-failed'];

interface Track {
  kind: string;
  label: string;
  settings: Record<string, unknown>;
}

async function badEvents(page: Page) {
  const out: Record<string, unknown[]> = {};
  for (const ev of BAD_EVENTS) {
    const found = await logEvents(page, ev);
    if (found.length) out[ev] = found;
  }
  return out;
}

/**
 * Back to Trama, then Atura. Chrome brings the shared tab to the front once it is picked, so
 * Trama records in the background until the user comes back to it, as here.
 */
async function stop(page: Page) {
  await page.bringToFront();
  await stopAndWaitSaved(page);
}

const meetingTab = (page: Page) => page.context().pages().find((p) => p.url().includes('/__test__/meeting'))!;
const meetingFrames = (page: Page) =>
  meetingTab(page).evaluate(() => (window as unknown as { __frames: () => number }).__frames());

for (const webrtc of [false, true]) {
  test(`tab capture${webrtc ? ' of a WebRTC call' : ''}: untouched stereo audio, in sync, and the MP4 keeps its timing`, async ({ openApp, context }) => {
    test.setTimeout(240_000);
    if (webrtc) test.skip(!(await webrtcWorks(context)), 'WebRTC cannot connect without a network route (runs on the macOS runner)');
    const page = await openApp({ capture: 'real', markers: PERIOD_S, webrtc });
    await record(page, 30_000);
    await stop(page);

    const [started] = (await logEvents(page, 'recording-started')) as { tracks: Track[] }[];
    const [webm] = await opfsFiles(page);
    const fromWebm = await measureSync(page, 'recordings', webm.name, PERIOD_S);
    await fakeSavePicker(page);
    await page.bringToFront(); // the analysis opened its own tab in front
    await page.fill('#nom', 'capture');
    await page.click('#desa-mp4');
    await expect(page.locator('#missatge')).toContainText('Vídeo desat en MP4', { timeout: 120_000 });
    const fromMp4 = await measureSync(page, 'picked', 'capture.mp4', PERIOD_S, { from: fromWebm });
    const [mp4Log] = (await logEvents(page, 'mp4')) as { audioCodec: string; audioRetime: { paddedS: number; trimmedS: number } | null }[];
    const clicks = { webm: await findClicks(page, 'recordings', webm.name), mp4: await findClicks(page, 'picked', 'capture.mp4') };
    const report = { tracks: started.tracks, bad: await badEvents(page), fromWebm, fromMp4, mp4Log, clicks };
    writeFileSync(test.info().outputPath('capture-report.json'), JSON.stringify(report, null, 2));

    // 7f: real tab capture, the meeting tab picked, its audio without voice processing.
    const video = started.tracks.find((t) => t.kind === 'video')!;
    const audio = started.tracks.find((t) => t.kind === 'audio')!;
    expect(video.settings.displaySurface).toBe('browser');
    expect(audio, 'tab audio shared').toBeDefined();
    expect(audio.settings).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 });
    expect(report.bad).toEqual({});
    // 1/2: in sync through the browser's own capture, and kept so in the MP4.
    expectInSync(fromWebm, 8);
    expectInSync(fromMp4, 8);
    expectMp4MatchesWebm(fromMp4, fromWebm);
    // On a Mac the captured sound must be clean (no drop-outs). The server has no sound card:
    // Chromium's stand-in output glitches under load, so there only the MP4 is held to adding
    // no clicks of its own.
    if (onMac) expectNoClicks(clicks.webm, 16);
    const shift = (mp4Log.audioRetime?.paddedS ?? 0) + (mp4Log.audioRetime?.trimmedS ?? 0);
    expectNoNewClicks(clicks.mp4, clicks.webm, 16, 0.03 + shift);
    if (onMac) expect(mp4Log.audioCodec).toBe('aac');
  });
}

test(`both tabs hidden for ${HIDDEN_S} s: the recording keeps its picture and sound`, async ({ openApp, context }) => {
  test.setTimeout((HIDDEN_S + 300) * 1000);
  // Through a WebRTC call where one can connect (macOS runner), as Teams plays a meeting.
  const webrtc = await webrtcWorks(context);
  const page = await openApp({ capture: 'real', markers: PERIOD_S, webrtc });
  await record(page, 10_000);
  const framesBefore = await meetingFrames(page);
  const show = await hideTabs(page);
  await page.waitForTimeout(HIDDEN_S * 1000);
  const hiddenFrames = (await meetingFrames(page)) - framesBefore;
  await show();
  await page.waitForTimeout(10_000);
  await stop(page);

  const [webm] = await opfsFiles(page);
  // Every marker of the hidden stretch, not a sample of them.
  const sync: SyncReport = await measureSync(page, 'recordings', webm.name, PERIOD_S, { maxMarkers: 1000 });
  const report = {
    hiddenS: HIDDEN_S,
    webrtc,
    visibility: await logEvents(page, 'visibility'),
    bad: await badEvents(page),
    hiddenFrames,
    duration: (await playerReady(page)).duration,
    sync,
  };
  writeFileSync(test.info().outputPath('hidden-report.json'), JSON.stringify(report, null, 2));

  // Earlier changes are the meeting tab opening in front and Trama coming back.
  expect(report.visibility.slice(-2), 'Trama hidden for the stretch, then shown').toEqual(['hidden', 'visible']);
  expect(report.bad, 'no chunk gaps, silence or track problems while hidden').toEqual({});
  expect(Math.abs(report.duration - (HIDDEN_S + 20)), 'recorded the whole time').toBeLessThan(5);
  // A marker every 3 s all the way through means the picture kept changing and the sound kept
  // coming while both tabs were hidden.
  expectInSync(sync, Math.floor((HIDDEN_S + 20) / PERIOD_S) - 2);
});

test('the shared tab closing mid-recording stops it and keeps the file', async ({ openApp }) => {
  const page = await openApp({ capture: 'real', markers: PERIOD_S });
  await record(page, 5000);
  const meeting = meetingTab(page);
  expect(await meeting.title()).toBe(MEETING_TITLE);
  await meeting.close();
  await expect(page.locator('#vista-desat')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#missatge')).toContainText('deixat de compartir');
  expect((await playerReady(page)).duration).toBeGreaterThan(3);
});
