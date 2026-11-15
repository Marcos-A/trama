// Recording flow in headless Chromium with a synthetic stream (real capture is manual: see
// docs/manual-tests.md). Served by `vite preview` with the production headers.

import { readFileSync } from 'node:fs';
import { expect, logEvents, opfsFiles, playerReady, record, stopAndWaitSaved, test } from './fixtures.ts';

test('security headers: CSP keeps media in the browser, no mic or camera', async ({ request }) => {
  const headers = (await request.get('/')).headers();
  expect(headers['content-security-policy']).toContain("connect-src 'self'");
  expect(headers['permissions-policy']).toContain('microphone=()');
  expect(headers['permissions-policy']).toContain('camera=()');
});

test('record, repair, play with a duration, seek, export and delete', async ({ openApp }) => {
  const page = await openApp();
  await record(page, 6000);
  await expect(page.locator('#mida')).toContainText('MB desats');
  await expect(page.locator('#estat-so')).toHaveText('Amb so');
  expect(await page.title()).toMatch(/^●/);
  // Tab audio is asked for untouched: no microphone processing, and the user still hears it.
  const asked = await page.evaluate(() => (window as unknown as { __displayMediaOptions: { audio: unknown } }).__displayMediaOptions.audio);
  expect(asked).toEqual({ suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  await stopAndWaitSaved(page);
  expect(await page.title()).toBe('Trama');

  // Repaired: the player knows the length (Infinity before step 3) and can seek.
  const meta = await playerReady(page);
  expect(meta.width).toBe(640);
  expect(meta.duration).toBeGreaterThan(4.5);
  expect(meta.duration).toBeLessThan(8);
  const [repair] = (await logEvents(page, 'repair')) as { durationS: number; cues: number; droppedBytes: number }[];
  expect(repair.durationS).toBeCloseTo(meta.duration, 1);
  expect(repair.cues).toBeGreaterThanOrEqual(1);
  expect(repair.droppedBytes).toBe(0);

  const seek = await page.evaluate(async () => {
    const v = document.querySelector<HTMLVideoElement>('#reproductor')!;
    const target = v.duration / 2;
    await new Promise<void>((done) => {
      v.addEventListener('seeked', () => done(), { once: true });
      v.currentTime = target;
    });
    return { target, at: v.currentTime, seekableEnd: v.seekable.length ? v.seekable.end(0) : 0 };
  });
  expect(Math.abs(seek.at - seek.target)).toBeLessThan(0.5);
  expect(seek.seekableEnd).toBeCloseTo(meta.duration, 1);

  // One file in OPFS, no temporary repair copy left.
  const files = await opfsFiles(page);
  expect(files.map((f) => f.name)).toEqual([expect.stringMatching(/^trama-.*\.webm$/)]);

  // Export through the download fallback (headless has no save picker): same bytes.
  await page.evaluate(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
  await page.fill('#nom', 'prova-reunio');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#desa')]);
  expect(download.suggestedFilename()).toBe('prova-reunio.webm');
  const exported = readFileSync((await download.path())!);
  expect(exported.length).toBe(files[0].size);
  expect(exported.subarray(0, 4).toString('hex')).toBe('1a45dfa3');

  await page.click('#esborra');
  await expect(page.locator('#vista-inici')).toBeVisible();
  expect(await opfsFiles(page)).toEqual([]);
});

test('closed tab mid-recording: other tabs ignore the live file, then it is recovered and repaired', async ({ openApp }) => {
  const page = await openApp();
  await record(page, 4000);

  const other = await openApp();
  await other.waitForTimeout(500);
  await expect(other.locator('#pendents')).toBeHidden();
  await other.close();

  await page.close({ runBeforeUnload: false });
  const again = await openApp();
  await expect(again.locator('#llista-pendents li')).toHaveCount(1);
  await again.click('#llista-pendents li button:has-text("Recupera")');
  await expect(again.locator('#vista-desat')).toBeVisible({ timeout: 30_000 });
  const meta = await playerReady(again);
  expect(meta.width).toBe(640);
  expect(Number.isFinite(meta.duration)).toBe(true);
  expect(meta.duration).toBeGreaterThan(1.5);
  expect(await logEvents(again, 'repair')).toHaveLength(1);
  await expect(again.locator('#missatge')).toBeHidden();
  await again.click('#esborra');
});

test('stopping the share from the browser bar stops and keeps the file', async ({ openApp }) => {
  const page = await openApp();
  await record(page, 2500);
  await page.evaluate(() => {
    const t = (window as unknown as { __fakeStream: MediaStream }).__fakeStream.getVideoTracks()[0];
    t.stop();
    t.dispatchEvent(new Event('ended'));
  });
  await expect(page.locator('#vista-desat')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#missatge')).toContainText('deixat de compartir');
  expect(Number.isFinite((await playerReady(page)).duration)).toBe(true);
});

test('no audio track: "Sense so" warning while recording', async ({ openApp }) => {
  const page = await openApp({ audio: false });
  await record(page, 500);
  await expect(page.locator('#missatge')).toHaveText(/^Sense so\./);
  await expect(page.locator('#estat-so')).toHaveText('Sense so');
  await page.waitForTimeout(2000);
  await stopAndWaitSaved(page);
  const meta = await playerReady(page);
  expect(Number.isFinite(meta.duration)).toBe(true);
});

test('simulated full storage (?quota=) stops the recording and keeps the file', async ({ openApp }) => {
  const page = await openApp({ query: '?quota=0.2' });
  await page.click('#grava');
  await expect(page.locator('#vista-desat')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#missatge')).toContainText("acabat l'espai");
  const files = await opfsFiles(page);
  expect(files).toHaveLength(1);
  expect(files[0].size).toBeGreaterThan(0);
});

test('without ?debug: no log panel, and ?quota is ignored', async ({ openApp }) => {
  const page = await openApp({ query: '?quota=0.2', debug: false });
  await expect(page.locator('#panell-registre')).toBeHidden();
  await record(page, 3000); // well past 0.2 MB of synthetic video
  await expect(page.locator('#vista-gravant')).toBeVisible();
  await stopAndWaitSaved(page);
  expect(await logEvents(page, 'simulated-quota-reached')).toEqual([]);
});

test('with ?debug the log panel is shown', async ({ openApp }) => {
  const page = await openApp();
  await expect(page.locator('#panell-registre')).toBeVisible();
});

test('browsers other than desktop Chromium are told to use Chrome or Edge', async ({ page }) => {
  // Firefox and Safari have no User-Agent Client Hints.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined }));
  await page.goto('/');
  await expect(page.locator('#grava')).toBeDisabled();
  await expect(page.locator('#missatge')).toContainText('Chrome o Edge');
});

test('cancelling the picker returns to the start with a message', async ({ openApp }) => {
  const page = await openApp();
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await page.click('#grava');
  await expect(page.locator('#missatge')).toContainText('has tancat el selector');
  await expect(page.locator('#grava')).toBeEnabled();
});

test('a file that cannot be repaired is still offered, with a warning', async ({ openApp }) => {
  const page = await openApp();
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('recordings', { create: true });
    const w = await (await dir.getFileHandle('trama-malmes.webm', { create: true })).createWritable();
    await w.write('this is not a webm file');
    await w.close();
  });
  await page.reload();
  await page.click('#llista-pendents li button:has-text("Recupera")');
  await expect(page.locator('#vista-desat')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#missatge')).toContainText("No s'ha pogut preparar el vídeo");
  expect(await logEvents(page, 'repair-failed')).toHaveLength(1);
  expect((await opfsFiles(page)).map((f) => f.name)).toEqual(['trama-malmes.webm']); // untouched
});

test('repairs interrupted by a closed tab are finished or discarded on the next load', async ({ openApp }) => {
  const page = await openApp();
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('recordings', { create: true });
    const put = async (name: string, text: string) => {
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    };
    // Original deleted, repaired copy complete: the copy becomes the recording.
    await put('.repair-a.webm', 'repaired copy of a');
    // Original still there: the copy was partial and goes.
    await put('b.webm', 'original b');
    await put('.repair-b.webm', 'partial copy of b');
  });
  await page.reload();
  await expect(page.locator('#llista-pendents li')).toHaveCount(2);
  const files = await opfsFiles(page);
  expect(files).toEqual([
    { name: 'a.webm', size: 'repaired copy of a'.length },
    { name: 'b.webm', size: 'original b'.length },
  ]);
});
