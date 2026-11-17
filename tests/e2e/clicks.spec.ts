// The click detector (tests/helpers/clicks.ts) against audio with known cuts, so a clean result
// elsewhere means something: a hard cut must be found, a cut with the converter's 2.5 ms fades
// must not, and neither must a beep's own edges.

import type { Page } from '@playwright/test';
import { findClicks } from '../helpers/clicks.ts';
import { expect, test } from './fixtures.ts';

/** Writes `clicks/<name>.wav` to OPFS: 3 s of 440 Hz hum at 0.05, a beep at 0.8 from 2.0 to 2.2 s, and 20 ms cut out at 1.0 s, with or without fades. */
async function writeTestWav(page: Page, name: string, fadeMs: number) {
  await page.evaluate(
    async ({ name, fadeMs }) => {
      const rate = 48000;
      const samples: number[] = [];
      const cutFrom = rate * 1.0;
      const cutTo = cutFrom + rate * 0.02;
      const fade = Math.round((rate * fadeMs) / 1000);
      for (let i = 0; i < rate * 3; i++) {
        if (i >= cutFrom && i < cutTo) continue; // the cut: the phase jumps
        const t = i / rate;
        let gain = t >= 2 && t < 2.2 ? 0.8 : 0.05;
        if (fade) {
          if (i < cutFrom && i >= cutFrom - fade) gain *= (cutFrom - i) / fade;
          if (i >= cutTo && i < cutTo + fade) gain *= (i - cutTo + 1) / fade;
        }
        samples.push(gain * Math.sin(2 * Math.PI * 440 * t));
      }
      const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
      const text = (at: number, s: string) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)));
      text(0, 'RIFF');
      data.setUint32(4, 36 + samples.length * 2, true);
      text(8, 'WAVEfmt ');
      data.setUint32(16, 16, true);
      data.setUint16(20, 1, true); // PCM
      data.setUint16(22, 1, true); // mono
      data.setUint32(24, rate, true);
      data.setUint32(28, rate * 2, true);
      data.setUint16(32, 2, true);
      data.setUint16(34, 16, true);
      text(36, 'data');
      data.setUint32(40, samples.length * 2, true);
      samples.forEach((x, i) => data.setInt16(44 + i * 2, Math.round(x * 32767), true));
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('clicks', { create: true });
      const w = await (await dir.getFileHandle(`${name}.wav`, { create: true })).createWritable();
      await w.write(data.buffer);
      await w.close();
    },
    { name, fadeMs },
  );
}

test('the click detector finds a hard cut, but not a faded one or a beep', async ({ openApp }) => {
  const page = await openApp();
  await writeTestWav(page, 'hard', 0);
  await writeTestWav(page, 'faded', 2.5);

  const hard = await findClicks(page, 'clicks', 'hard.wav');
  expect(hard.edges).toBe(2);
  expect(hard.count).toBeGreaterThanOrEqual(1);
  for (const c of hard.clicks) expect(Math.abs(c.atS - 1.0)).toBeLessThan(0.01);

  const faded = await findClicks(page, 'clicks', 'faded.wav');
  expect(faded.edges).toBe(2);
  expect(faded.clicks).toEqual([]);
});
