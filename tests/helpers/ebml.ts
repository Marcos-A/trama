// Minimal EBML walker for assertions, written separately from src/media/webm-repair.ts so the
// tests do not check the repair against itself.

export interface Block {
  track: number;
  time: number; // absolute, TimecodeScale units
  key: boolean;
  bytes: Uint8Array; // the whole SimpleBlock/BlockGroup element
}

export interface Parsed {
  segmentSizeKnown: boolean;
  /** Segment payload ends exactly at the end of the file. */
  segmentFillsFile: boolean;
  segmentDataStart: number;
  allClustersSized: boolean;
  duration?: number;
  timecodeScale: number;
  videoTrack?: number;
  clusters: { pos: number; time: number }[]; // pos relative to segment data
  cues: { time: number; track: number; cluster: number }[];
  seek: Map<number, number>;
  blocks: Block[];
}

const CLUSTER = 0x1f43b675;
const LEVEL1 = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, CLUSTER, 0x1c53bb6b, 0x1254c367]);

function vint(d: Uint8Array, p: number, keepMarker: boolean) {
  let len = 1;
  while (len <= 8 && !(d[p] & (0x100 >> len))) len++;
  if (len > 8) throw new Error(`bad vint at ${p}`);
  let v = keepMarker ? d[p] : d[p] & (0xff >> len);
  let ones = (d[p] & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + d[p + i];
    ones &&= d[p + i] === 0xff;
  }
  return { v, len, unknown: !keepMarker && ones };
}

function head(d: Uint8Array, p: number) {
  const id = vint(d, p, true);
  const size = vint(d, p + id.len, false);
  return { id: id.v, size: size.unknown ? -1 : size.v, body: p + id.len + size.len };
}

const uint = (d: Uint8Array) => d.reduce((v, x) => v * 256 + x, 0);

function kids(d: Uint8Array, start: number, end: number) {
  const out: { id: number; size: number; at: number; body: number }[] = [];
  for (let p = start; p < end; ) {
    const h = head(d, p);
    if (h.size < 0) throw new Error(`unknown size inside master at ${p}`);
    out.push({ ...h, at: p });
    p = h.body + h.size;
  }
  return out;
}

export function parseWebm(d: Uint8Array): Parsed {
  const ebml = head(d, 0);
  const segAt = ebml.body + ebml.size;
  const seg = head(d, segAt);
  if (seg.id !== 0x18538067) throw new Error('no segment');
  const segEnd = seg.size < 0 ? d.length : seg.body + seg.size;
  const out: Parsed = {
    segmentSizeKnown: seg.size >= 0,
    segmentFillsFile: seg.size >= 0 && segEnd === d.length,
    segmentDataStart: seg.body,
    allClustersSized: true,
    timecodeScale: 1_000_000,
    clusters: [],
    cues: [],
    seek: new Map(),
    blocks: [],
  };

  for (let p = seg.body; p < segEnd; ) {
    const h = head(d, p);
    if (h.id === CLUSTER) {
      if (h.size < 0) out.allClustersSized = false;
      let end = h.size < 0 ? segEnd : h.body + h.size;
      let time = 0;
      const cluster = { pos: p - seg.body, time: 0 };
      out.clusters.push(cluster);
      let c = h.body;
      while (c < end) {
        const ch = head(d, c);
        if (h.size < 0 && LEVEL1.has(ch.id)) {
          end = c;
          break;
        }
        const bytes = d.subarray(c, ch.body + ch.size);
        if (ch.id === 0xe7) cluster.time = time = uint(d.subarray(ch.body, ch.body + ch.size));
        if (ch.id === 0xa3 || ch.id === 0xa0) {
          let blockAt = ch.body;
          let key = false;
          if (ch.id === 0xa0) {
            const g = kids(d, ch.body, ch.body + ch.size);
            blockAt = g.find((k) => k.id === 0xa1)!.body;
            key = !g.some((k) => k.id === 0xfb);
          }
          const tn = vint(d, blockAt, false);
          const rel = new DataView(d.buffer, d.byteOffset + blockAt + tn.len, 2).getInt16(0);
          if (ch.id === 0xa3) key = !!(d[blockAt + tn.len + 2] & 0x80);
          out.blocks.push({ track: tn.v, time: time + rel, key, bytes });
        }
        c = ch.body + ch.size;
      }
      p = end;
      continue;
    }
    if (h.size < 0) throw new Error(`unknown-size 0x${h.id.toString(16)}`);
    if (h.id === 0x1549a966) {
      for (const k of kids(d, h.body, h.body + h.size)) {
        if (k.id === 0x2ad7b1) out.timecodeScale = uint(d.subarray(k.body, k.body + k.size));
        if (k.id === 0x4489) out.duration = new DataView(d.buffer, d.byteOffset + k.body, k.size).getFloat64(0);
      }
    }
    if (h.id === 0x1654ae6b) {
      for (const te of kids(d, h.body, h.body + h.size)) {
        const f = kids(d, te.body, te.body + te.size);
        const val = (id: number) => {
          const k = f.find((x) => x.id === id);
          return k ? uint(d.subarray(k.body, k.body + k.size)) : undefined;
        };
        if (val(0x83) === 1) out.videoTrack ??= val(0xd7);
      }
    }
    if (h.id === 0x114d9b74) {
      for (const s of kids(d, h.body, h.body + h.size)) {
        const f = kids(d, s.body, s.body + s.size);
        const id = f.find((x) => x.id === 0x53ab)!;
        const pos = f.find((x) => x.id === 0x53ac)!;
        out.seek.set(uint(d.subarray(id.body, id.body + id.size)), uint(d.subarray(pos.body, pos.body + pos.size)));
      }
    }
    if (h.id === 0x1c53bb6b) {
      for (const cp of kids(d, h.body, h.body + h.size)) {
        const f = kids(d, cp.body, cp.body + cp.size);
        const t = f.find((x) => x.id === 0xb3)!;
        const tp = kids(d, f.find((x) => x.id === 0xb7)!.body, f.find((x) => x.id === 0xb7)!.body + f.find((x) => x.id === 0xb7)!.size);
        const get = (id: number) => {
          const k = tp.find((x) => x.id === id)!;
          return uint(d.subarray(k.body, k.body + k.size));
        };
        out.cues.push({ time: uint(d.subarray(t.body, t.body + t.size)), track: get(0xf7), cluster: get(0xf1) });
      }
    }
    p = h.body + h.size;
  }
  return out;
}

/** The id at an absolute file position (to check that Cue/Seek positions land on elements). */
export function idAt(d: Uint8Array, p: number): number {
  return vint(d, p, true).v;
}
