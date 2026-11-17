// "Plays in QuickTime" (manual checks 8a/8c), automated on macOS: copies a file out of OPFS and
// has AVFoundation decode every track to the end (scripts/avfoundation-check.swift).

import { execFileSync } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const onMac = process.platform === 'darwin';

export interface AvReport {
  playable?: boolean;
  durationS?: number;
  error?: string;
  tracks?: { type: string; codec?: string; startS: number; durationS: number; decodedBuffers: number; decodedToS: number; readerStatus: string }[];
}

/** Copies `dir/name` from the page's OPFS to `dest`, 8 MB at a time. */
export async function saveOpfsFile(page: Page, dir: string, name: string, dest: string): Promise<number> {
  const fd = openSync(dest, 'w');
  try {
    for (let at = 0; ; ) {
      const chunk = await page.evaluate(
        async ({ dir, name, at }) => {
          const root = await navigator.storage.getDirectory();
          const file = await (await (await root.getDirectoryHandle(dir)).getFileHandle(name)).getFile();
          const bytes = new Uint8Array(await file.slice(at, at + 8 * 2 ** 20).arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(bin);
        },
        { dir, name, at },
      );
      const buf = Buffer.from(chunk, 'base64');
      if (!buf.length) return at;
      writeSync(fd, buf);
      at += buf.length;
    }
  } finally {
    closeSync(fd);
  }
}

export function avfoundationCheck(path: string): AvReport {
  const out = execFileSync('swift', ['scripts/avfoundation-check.swift', path], { encoding: 'utf8', timeout: 1_800_000 });
  return JSON.parse(out) as AvReport;
}

/** Playable, H.264 + AAC, as long as `expectedS`, every track decoded to the end. */
export function expectPlaysInQuickTime(report: AvReport, expectedS: number): void {
  expect(report.error, 'AVFoundation error').toBeUndefined();
  expect(report.playable, 'AVFoundation calls it playable').toBe(true);
  expect(Math.abs(report.durationS! - expectedS), 'duration against the WebM').toBeLessThan(0.1);
  const codecs = report.tracks!.map((t) => `${t.type}:${t.codec}`).sort();
  expect(codecs).toEqual(['soun:aac ', 'vide:avc1']);
  for (const t of report.tracks!) {
    expect(t.readerStatus, `${t.type} decoded without error`).toBe('completed');
    expect(t.decodedBuffers, `${t.type} decoded something`).toBeGreaterThan(0);
    // Within 0.2 s of the end: a video frame counts from its start, so the last one ends ~33 ms later.
    expect(t.decodedToS, `${t.type} decoded to the end`).toBeGreaterThan(t.startS + t.durationS - 0.2);
  }
}
