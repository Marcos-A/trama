// AlphaMode lookup used by the MP4 conversion (src/media/webm-alpha.ts).

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { alphaModeOffsets } from '../../src/media/webm-alpha.ts';
import { repairWebm } from '../../src/media/webm-repair.ts';

const fixture = readFileSync(new URL('../fixtures/chromium-158-vp9-opus-7s.webm', import.meta.url));

test('finds AlphaMode=1 in a Chrome canvas recording', async () => {
  const at = await alphaModeOffsets(new Blob([fixture]));
  expect(at).toHaveLength(1);
  expect(fixture.readUInt16BE(at[0] - 3)).toBe(0x53c0); // ID, then size 0x81, then the value
  expect(fixture[at[0] - 1]).toBe(0x81);
  expect(fixture[at[0]]).toBe(1);
});

test('finds it in a repaired file too (known sizes, SeekHead first)', async () => {
  let buf = new Uint8Array(fixture.length + 64 * 1024);
  let size = 0;
  await repairWebm(
    { size: fixture.length, read: async (pos, len) => fixture.subarray(pos, pos + len) },
    {
      write(bytes, at) {
        if (at + bytes.length > buf.length) {
          const bigger = new Uint8Array(2 * (at + bytes.length));
          bigger.set(buf);
          buf = bigger;
        }
        buf.set(bytes, at);
        size = Math.max(size, at + bytes.length);
      },
      truncate: (n) => void (size = n),
    },
  );
  const repaired = buf.subarray(0, size);
  const at = await alphaModeOffsets(new Blob([repaired]));
  expect(at).toHaveLength(1);
  expect(repaired[at[0]]).toBe(1);
});

test('nothing to mask when AlphaMode is 0 or absent', async () => {
  const at = (await alphaModeOffsets(new Blob([fixture])))[0];
  const zeroed = Buffer.from(fixture);
  zeroed[at] = 0;
  expect(await alphaModeOffsets(new Blob([zeroed]))).toEqual([]);
  expect(await alphaModeOffsets(new Blob([new Uint8Array(100)]))).toEqual([]);
});
