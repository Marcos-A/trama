// WebM repair on a real Chromium MediaRecorder file (tests/fixtures), run in Node.

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { needsRepair, repairWebm, WebmRepairError, type RepairOptions, type RepairSink, type RepairSource } from '../../src/media/webm-repair.ts';
import { idAt, parseWebm } from '../helpers/ebml.ts';

const FIXTURE = new Uint8Array(readFileSync(new URL('../fixtures/chromium-158-vp9-opus-7s.webm', import.meta.url)));
const CLUSTER = 0x1f43b675;

function source(d: Uint8Array): RepairSource {
  return { size: d.length, read: async (pos, len) => d.slice(pos, pos + len) };
}

/** Growable in-memory sink. */
function memorySink() {
  let buf = new Uint8Array(1024);
  let size = 0;
  const sink: RepairSink = {
    write(bytes, at) {
      if (at + bytes.length > buf.length) {
        const next = new Uint8Array(Math.max(buf.length * 2, at + bytes.length));
        next.set(buf);
        buf = next;
      }
      buf.set(bytes, at);
      size = Math.max(size, at + bytes.length);
    },
    truncate(n) {
      size = n;
    },
  };
  return { sink, bytes: () => buf.slice(0, size) };
}

async function repair(d: Uint8Array, opts?: RepairOptions) {
  const m = memorySink();
  const result = await repairWebm(source(d), m.sink, opts);
  return { result, out: m.bytes() };
}

const blockBytes = (d: Uint8Array) => parseWebm(d).blocks.map((b) => Buffer.from(b.bytes).toString('base64'));

test('the fixture is what Chrome writes: unknown sizes, no Duration, no Cues', () => {
  const p = parseWebm(FIXTURE);
  expect(p.segmentSizeKnown).toBe(false);
  expect(p.allClustersSized).toBe(false);
  expect(p.duration).toBeUndefined();
  expect(p.cues).toHaveLength(0);
  expect(p.blocks.filter((b) => b.track === p.videoTrack && b.key).length).toBeGreaterThanOrEqual(2);
});

test('repair adds sizes, Duration, Cues and SeekHead and keeps every frame', async () => {
  const { result, out } = await repair(FIXTURE);
  const p = parseWebm(out);
  const original = parseWebm(FIXTURE);

  expect(p.segmentFillsFile).toBe(true);
  expect(p.allClustersSized).toBe(true);
  expect(result.outputBytes).toBe(out.length);
  expect(result.droppedBytes).toBe(0);

  // Same frames, same bytes, same order.
  expect(blockBytes(out)).toEqual(blockBytes(FIXTURE));

  // Duration: the last block plus one frame, about 7 s.
  const lastMs = Math.max(...original.blocks.map((b) => b.time));
  expect(p.duration).toBeGreaterThan(lastMs);
  expect(p.duration!).toBeLessThan(lastMs + 100);
  expect(result.durationS).toBeCloseTo(p.duration! / 1000, 3);
  expect(result.durationS).toBeGreaterThan(6.5);
  expect(result.durationS).toBeLessThan(7.6);

  // One cue per video keyframe that starts a cluster's first keyframe, each pointing at a Cluster.
  const keyTimes = new Set(original.blocks.filter((b) => b.track === original.videoTrack && b.key).map((b) => b.time));
  expect(p.cues.length).toBeGreaterThanOrEqual(2);
  expect(p.cues.length).toBe(result.cues);
  for (const cue of p.cues) {
    expect(cue.track).toBe(p.videoTrack);
    expect(keyTimes.has(cue.time)).toBe(true);
    expect(idAt(out, p.segmentDataStart + cue.cluster)).toBe(CLUSTER);
  }

  // SeekHead points at Info, Tracks and Cues.
  for (const [id, pos] of p.seek) expect(idAt(out, p.segmentDataStart + pos)).toBe(id);
  expect([...p.seek.keys()].sort()).toEqual([0x1549a966, 0x1654ae6b, 0x1c53bb6b].sort());
});

test('repairing a repaired file gives the same bytes, and needsRepair tells them apart', async () => {
  const { out } = await repair(FIXTURE);
  const { out: again } = await repair(out);
  expect(Buffer.from(again).equals(Buffer.from(out))).toBe(true);
  expect(await needsRepair(source(FIXTURE))).toBe(true);
  expect(await needsRepair(source(out))).toBe(false);
  // A repaired file cut short is no longer "repaired".
  expect(await needsRepair(source(out.slice(0, out.length - 10)))).toBe(true);
});

test('tiny read windows and write buffers give the same output', async () => {
  const { out } = await repair(FIXTURE);
  for (const [readWindow, writeBuffer] of [
    [64, 50],
    [1000, 777],
    [4096, 100_000],
  ]) {
    const { out: small } = await repair(FIXTURE, { readWindow, writeBuffer });
    expect(Buffer.from(small).equals(Buffer.from(out)), `window ${readWindow}, buffer ${writeBuffer}`).toBe(true);
  }
});

test('a file cut anywhere (killed tab) repairs to a valid prefix', async () => {
  const full = blockBytes(FIXTURE);
  const cuts = new Set<number>();
  for (let i = 1; i <= 120; i++) cuts.add(Math.floor((FIXTURE.length * i) / 121));
  for (let c = 200; c < 1200; c += 7) cuts.add(c); // around the first cluster's header and blocks
  let failedEarly = 0;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    const part = FIXTURE.slice(0, cut);
    let res;
    try {
      res = await repair(part);
    } catch (e) {
      // Only acceptable when nothing playable is in the file yet.
      expect(e, `cut at ${cut}`).toBeInstanceOf(WebmRepairError);
      expect(cut, `cut at ${cut} threw ${(e as Error).message}`).toBeLessThan(2000);
      failedEarly++;
      continue;
    }
    const p = parseWebm(res.out);
    expect(p.segmentFillsFile, `cut at ${cut}`).toBe(true);
    expect(p.allClustersSized).toBe(true);
    const kept = blockBytes(res.out);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept, `cut at ${cut}: frames must be a prefix of the original`).toEqual(full.slice(0, kept.length));
    expect(res.result.droppedBytes).toBeLessThan(cut); // 0 when the cut falls between elements
    for (const cue of p.cues) expect(idAt(res.out, p.segmentDataStart + cue.cluster)).toBe(CLUSTER);
  }
  expect(failedEarly).toBeLessThan(cuts.size / 4);
});

test('rejects what is not a WebM', async () => {
  await expect(repair(new TextEncoder().encode('not a webm at all'))).rejects.toBeInstanceOf(WebmRepairError);
  await expect(repair(FIXTURE.slice(0, 40))).rejects.toBeInstanceOf(WebmRepairError);
});
