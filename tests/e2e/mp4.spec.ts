// WebM → MP4 conversion (PLAN §7) in headless Chromium. Linux Chromium has an H.264 encoder
// (OpenH264) but no AAC encoder, so here the audio is copied as Opus; the AAC path runs on
// macOS and Windows and is checked by hand (docs/manual-tests.md, check 8).

import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, logEvents, opfsFiles, playerReady, record, stopAndWaitSaved, test } from './fixtures.ts';

interface Mp4Log {
  durationS: number;
  width: number;
  height: number;
  audioCodec: 'aac' | 'opus' | null;
  inputBytes: number;
  outputBytes: number;
}

/** Top-level box types of an ISO BMFF file, and whether the moov mentions each codec. */
function mp4Summary(bytes: Buffer) {
  const boxes: string[] = [];
  let moov: Buffer = Buffer.alloc(0);
  for (let pos = 0; pos + 8 <= bytes.length; ) {
    let size = bytes.readUInt32BE(pos);
    const type = bytes.toString('latin1', pos + 4, pos + 8);
    if (size === 1) size = Number(bytes.readBigUInt64BE(pos + 8));
    if (size === 0) size = bytes.length - pos;
    boxes.push(type);
    if (type === 'moov') moov = bytes.subarray(pos, pos + size);
    pos += size;
  }
  const has = (fourcc: string) => moov.includes(Buffer.from(fourcc, 'latin1'));
  return { boxes, avc1: has('avc1'), mp4a: has('mp4a'), opus: has('Opus') };
}

/** Plays an OPFS file in a fresh <video> and seeks to its middle. */
async function playOpfsFile(page: Page, dir: string, name: string) {
  return page.evaluate(
    async ([dir, name]) => {
      const root = await navigator.storage.getDirectory();
      const file = await (await (await root.getDirectoryHandle(dir)).getFileHandle(name)).getFile();
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(file);
      await new Promise<void>((ok, fail) => {
        v.onloadedmetadata = () => ok();
        v.onerror = () => fail(new Error(`video error ${v.error?.code}: ${v.error?.message}`));
      });
      const target = v.duration / 2;
      await new Promise<void>((ok) => {
        v.addEventListener('seeked', () => ok(), { once: true });
        v.currentTime = target;
      });
      return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, target, at: v.currentTime, size: file.size };
    },
    [dir, name],
  );
}

/** Replaces the save dialog with one that "picks" a file in OPFS (`picked/<name>`). */
async function fakeSavePicker(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('picked', { create: true });
      return dir.getFileHandle(suggestedName, { create: true }); // the real dialog creates it too
    };
  });
}

async function pickedFiles(page: Page): Promise<{ name: string; size: number }[]> {
  return page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
    const out: { name: string; size: number }[] = [];
    for await (const [name, h] of dir.entries()) out.push({ name, size: (await (h as FileSystemFileHandle).getFile()).size });
    return out;
  });
}

test('MP4 without a save dialog: converted in the browser, downloaded, plays and seeks', async ({ openApp }) => {
  const page = await openApp();
  await record(page, 6000);
  await stopAndWaitSaved(page);
  const webm = await playerReady(page);
  const before = await opfsFiles(page);

  await page.evaluate(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
  await page.fill('#nom', 'reunio.webm');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#desa-mp4')]);
  expect(download.suggestedFilename()).toBe('reunio.mp4');
  await expect(page.locator('#missatge')).toContainText("S'ha baixat el vídeo en MP4");
  await expect(page.locator('#vista-desat')).toBeVisible();

  const bytes = readFileSync((await download.path())!);
  const mp4 = mp4Summary(bytes);
  expect(mp4.boxes).toEqual(['ftyp', 'mdat', 'moov']); // moov at the end: no fast start
  expect(mp4.avc1).toBe(true);

  const [log] = (await logEvents(page, 'mp4')) as Mp4Log[];
  expect(log.outputBytes).toBe(bytes.length);
  expect(log.width).toBe(640);
  expect(log.height).toBe(360);
  expect(log.audioCodec === 'aac' ? mp4.mp4a : mp4.opus).toBe(true);
  expect(log.durationS).toBeCloseTo(webm.duration, 0);

  const played = await playOpfsFile(page, 'exports', 'reunio.mp4');
  expect(played.size).toBe(bytes.length);
  expect(played.width).toBe(640);
  expect(Math.abs(played.duration - webm.duration)).toBeLessThan(0.5);
  expect(Math.abs(played.at - played.target)).toBeLessThan(0.5);

  // The recording itself is untouched.
  expect(await opfsFiles(page)).toEqual(before);
});

test('MP4 with the save dialog: written straight to the picked file', async ({ openApp }) => {
  const page = await openApp();
  await record(page, 4000);
  await stopAndWaitSaved(page);
  await fakeSavePicker(page);
  await page.fill('#nom', 'reunio');
  await page.click('#desa-mp4');
  await expect(page.locator('#missatge')).toContainText('Vídeo desat en MP4', { timeout: 60_000 });

  const [log] = (await logEvents(page, 'mp4')) as (Mp4Log & { download: boolean })[];
  expect(log.download).toBe(false);
  expect(await pickedFiles(page)).toEqual([{ name: 'reunio.mp4', size: log.outputBytes }]);
  const played = await playOpfsFile(page, 'picked', 'reunio.mp4');
  expect(played.duration).toBeGreaterThan(2.5);
});

test('cancelling the MP4 conversion leaves no file and returns to the recording', async ({ openApp }) => {
  test.setTimeout(120_000);
  const page = await openApp({ width: 1920, height: 1080 }); // slow enough to cancel midway
  await record(page, 12_000);
  await stopAndWaitSaved(page);
  await fakeSavePicker(page);
  await page.click('#desa-mp4');
  await page.waitForFunction(() => document.querySelector<HTMLProgressElement>('#progres-mp4')!.value > 0);
  await page.click('#cancella-mp4');
  await expect(page.locator('#missatge')).toContainText('Conversió cancel·lada', { timeout: 30_000 });
  await expect(page.locator('#vista-desat')).toBeVisible();
  const [cancelled] = (await logEvents(page, 'mp4-cancelled')) as { progress: number; elapsedS: number }[];
  expect(cancelled.progress).toBeGreaterThan(0);
  expect((await logEvents(page, 'mp4-sample')).length).toBeGreaterThanOrEqual(1); // one at the first progress
  expect(await pickedFiles(page)).toEqual([]); // the empty file the dialog created is removed too

  // Converting again afterwards works.
  await page.click('#desa-mp4');
  await expect(page.locator('#missatge')).toContainText('Vídeo desat en MP4', { timeout: 90_000 });
  const [log] = (await logEvents(page, 'mp4')) as Mp4Log[];
  expect([log.width, log.height]).toEqual([1920, 1080]);
});

test('a recording without sound converts to a video-only MP4', async ({ openApp }) => {
  const page = await openApp({ audio: false });
  await record(page, 3000);
  await stopAndWaitSaved(page);
  await fakeSavePicker(page);
  await page.click('#desa-mp4');
  await expect(page.locator('#missatge')).toHaveText('Vídeo desat en MP4. Ja pots esborrar la còpia del navegador.', { timeout: 60_000 });
  const [log] = (await logEvents(page, 'mp4')) as Mp4Log[];
  expect(log.audioCodec).toBeNull();
});

test('while the WebM is being saved, MP4 and the other actions wait', async ({ openApp }) => {
  const page = await openApp();
  await record(page, 3000);
  await stopAndWaitSaved(page);
  // A save dialog that stays open until the test closes it, standing in for a long write.
  await page.evaluate(() => {
    const w = window as unknown as { showSaveFilePicker: unknown; closeDialog: () => void };
    w.showSaveFilePicker = ({ suggestedName }: { suggestedName: string }) =>
      new Promise((resolve) => {
        w.closeDialog = async () => {
          const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
          resolve(await dir.getFileHandle(suggestedName, { create: true }));
        };
      });
  });
  await page.click('#desa');
  await expect(page.locator('#desa')).toHaveText('Desant…');
  for (const id of ['#desa', '#desa-mp4', '#nova', '#esborra']) await expect(page.locator(id)).toBeDisabled();

  await page.evaluate(() => (window as unknown as { closeDialog: () => void }).closeDialog());
  await expect(page.locator('#missatge')).toHaveText('Vídeo desat. Ja pots esborrar la còpia del navegador.');
  await expect(page.locator('#desa')).toHaveText('Desa el vídeo');
  for (const id of ['#desa', '#desa-mp4', '#nova', '#esborra']) await expect(page.locator(id)).toBeEnabled();
  expect(await pickedFiles(page)).toEqual([{ name: expect.stringMatching(/\.webm$/), size: expect.any(Number) }]);
});
