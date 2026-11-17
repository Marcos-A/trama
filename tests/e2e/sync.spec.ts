// A/V sync through Trama's own pipeline (recorder → OPFS → repair → MP4), measured on synthetic
// markers. It cannot see what Teams or tab capture do to sync; that stays manual (checks 1, 5b).
// The long version of this test is tests/soak (SOAK_MINUTES).

import { expectInSync, expectMp4MatchesWebm, measureSync } from '../helpers/av-sync.ts';
import { avfoundationCheck, expectPlaysInQuickTime, onMac, saveOpfsFile } from '../helpers/avfoundation.ts';
import { expectNoClicks, findClicks } from '../helpers/clicks.ts';
import { expect, fakeSavePicker, logEvents, opfsFiles, record, stopAndWaitSaved, test } from './fixtures.ts';

const PERIOD_S = 3;

test('picture and sound stay in sync in the WebM, and the MP4 keeps its timing', async ({ openApp }) => {
  test.setTimeout(180_000);
  const page = await openApp({ markers: PERIOD_S });
  await record(page, 20_000);
  await stopAndWaitSaved(page);
  const [webm] = await opfsFiles(page);

  const fromWebm = await measureSync(page, 'recordings', webm.name, PERIOD_S);
  test.info().annotations.push({ type: 'webm sync', description: JSON.stringify(fromWebm) });
  expectInSync(fromWebm, 5);

  await fakeSavePicker(page);
  await page.fill('#nom', 'sync');
  await page.click('#desa-mp4');
  await expect(page.locator('#missatge')).toContainText('Vídeo desat en MP4', { timeout: 120_000 });
  const fromMp4 = await measureSync(page, 'picked', 'sync.mp4', PERIOD_S, { from: fromWebm });
  test.info().annotations.push({ type: 'mp4 sync', description: JSON.stringify(fromMp4) });
  // In sync on its own, and with the WebM's timing: see tests/helpers/av-sync.ts.
  expectInSync(fromMp4, 5);
  expectMp4MatchesWebm(fromMp4, fromWebm);

  // No clicks where the converter padded or trimmed the audio; the WebM is the control.
  const [mp4Log] = (await logEvents(page, 'mp4')) as { audioCodec: string; audioRetime?: unknown }[];
  test.info().annotations.push({ type: 'mp4 log', description: JSON.stringify(mp4Log) });
  expectNoClicks(await findClicks(page, 'recordings', webm.name), 10);
  expectNoClicks(await findClicks(page, 'picked', 'sync.mp4'), 10);

  // On macOS: AAC from the platform encoder, and QuickTime's AVFoundation plays it to the end.
  if (onMac) {
    expect(mp4Log.audioCodec).toBe('aac');
    const path = test.info().outputPath('sync.mp4');
    await saveOpfsFile(page, 'picked', 'sync.mp4', path);
    const av = avfoundationCheck(path);
    test.info().annotations.push({ type: 'avfoundation', description: JSON.stringify(av) });
    expectPlaysInQuickTime(av, fromWebm.durationS);
  }
});
