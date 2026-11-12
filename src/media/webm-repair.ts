// Makes a MediaRecorder WebM seekable: adds Duration, Cues and a SeekHead, and gives the
// Segment and every Cluster a real size.
//
// Chrome's MediaRecorder writes a live-style WebM: Segment and Clusters of unknown size, no
// Duration, no Cues. Players then show no length and seek badly. This rewrites the file in one
// streaming pass (recordings reach 1–3 GB, so nothing is held whole in memory): elements are
// copied as they are, size and Duration fields are written as placeholders and patched at the
// end, and Cues are appended after the last Cluster.
//
// A recording cut short (closed tab, crash) ends in a partial element; everything from that
// element on is dropped, so the result plays up to the last complete frame.
//
// Running it on its own output gives the same bytes again. No DOM or Node APIs: the caller
// supplies the source and the sink (OPFS in the app, buffers in the tests).

export interface RepairSource {
  readonly size: number;
  read(pos: number, len: number): Promise<Uint8Array>;
}

export interface RepairSink {
  write(bytes: Uint8Array, at: number): void | Promise<void>;
  truncate(size: number): void | Promise<void>;
}

export interface RepairResult {
  /** Seconds, from the last block of each track. */
  durationS: number;
  clusters: number;
  cues: number;
  inputBytes: number;
  outputBytes: number;
  /** Bytes at the end of the input that were dropped as incomplete (0 when the file ended cleanly). */
  droppedBytes: number;
}

export class WebmRepairError extends Error {
  override name = 'WebmRepairError';
}

// ---------------------------------------------------------------- EBML ids

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Void: 0xec,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
} as const;

/** Segment children: inside an unknown-size Cluster, any of these ends the Cluster. */
const LEVEL1 = new Set<number>([
  ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments,
]);

const TRACK_VIDEO = 1;
const UNKNOWN = -1;
const READ_WINDOW = 8 * 1024 * 1024;
const WRITE_BUFFER = 4 * 1024 * 1024;

// ---------------------------------------------------------------- reading

interface Header {
  id: number;
  /** Payload size, or UNKNOWN. */
  size: number;
  /** Header length (id + size field). */
  len: number;
}

/** Windowed reader: sequential header reads and copies without loading the file. */
class Reader {
  private buf: Uint8Array = new Uint8Array(0);
  private start = 0;

  constructor(
    private readonly src: RepairSource,
    readonly window = READ_WINDOW,
  ) {}

  get size(): number {
    return this.src.size;
  }

  /** Makes [pos, pos+n) available; false if it runs past the end of the file. */
  async ensure(pos: number, n: number): Promise<boolean> {
    if (pos + n > this.src.size) return false;
    if (pos >= this.start && pos + n <= this.start + this.buf.length) return true;
    const len = Math.min(Math.max(n, this.window), this.src.size - pos);
    this.buf = await this.src.read(pos, len);
    if (this.buf.length < len) throw new WebmRepairError(`short read at ${pos}`);
    this.start = pos;
    return true;
  }

  /** Only after ensure() covered the range. */
  bytes(pos: number, n: number): Uint8Array {
    return this.buf.subarray(pos - this.start, pos - this.start + n);
  }

  /** Reads an element header; null if it is cut off by the end of the file or invalid. */
  async header(pos: number): Promise<Header | null> {
    if (!(await this.ensure(pos, 1))) return null;
    const idLen = vintLength(this.bytes(pos, 1)[0]);
    if (idLen === 0 || idLen > 4) return null;
    if (!(await this.ensure(pos, idLen + 1))) return null;
    const sizeLen = vintLength(this.bytes(pos + idLen, 1)[0]);
    if (sizeLen === 0) return null;
    if (!(await this.ensure(pos, idLen + sizeLen))) return null;
    const b = this.bytes(pos, idLen + sizeLen);
    let id = 0;
    for (let i = 0; i < idLen; i++) id = id * 256 + b[i];
    let size = b[idLen] & (0xff >> sizeLen);
    let allOnes = size === 0xff >> sizeLen;
    for (let i = 1; i < sizeLen; i++) {
      size = size * 256 + b[idLen + i];
      allOnes &&= b[idLen + i] === 0xff;
    }
    return { id, size: allOnes ? UNKNOWN : size, len: idLen + sizeLen };
  }

  /** Whole payload of a small element (ints, floats, Info children…). */
  async payload(pos: number, h: Header): Promise<Uint8Array | null> {
    if (h.size === UNKNOWN || !(await this.ensure(pos + h.len, h.size))) return null;
    return this.bytes(pos + h.len, h.size).slice();
  }
}

function vintLength(first: number): number {
  for (let len = 1; len <= 8; len++) if (first & (0x100 >> len)) return len;
  return 0;
}

function readUint(b: Uint8Array): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

/** Track number (vint) and signed 16-bit timecode at the start of a (Simple)Block payload. */
function blockHead(b: Uint8Array): { track: number; rel: number; flags: number } | null {
  const n = vintLength(b[0] ?? 0);
  if (n === 0 || b.length < n + 3) return null;
  let track = b[0] & (0xff >> n);
  for (let i = 1; i < n; i++) track = track * 256 + b[i];
  const rel = ((b[n] << 8) | b[n + 1]) << 16 >> 16;
  return { track, rel, flags: b[n + 2] };
}

// ---------------------------------------------------------------- writing

function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return out;
}

/** Size field as an 8-byte vint, so it can be patched later without moving anything. */
function size8(n: number): number[] {
  const out = [0x01];
  for (let i = 6; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xff);
  return out;
}

function sizeMin(n: number): number[] {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out: number[] = [];
      for (let i = len - 1; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) & 0xff);
      out[0] |= 0x100 >> len;
      return out;
    }
  }
  throw new WebmRepairError('element too large');
}

function uintBytes(n: number, fixed = 0): number[] {
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  while (out.length < Math.max(fixed, 1)) out.unshift(0);
  return out;
}

function element(id: number, payload: ArrayLike<number>): Uint8Array {
  const head = [...idBytes(id), ...sizeMin(payload.length)];
  const out = new Uint8Array(head.length + payload.length);
  out.set(head);
  out.set(payload, head.length);
  return out;
}

const uintElement = (id: number, n: number, fixed = 0) => element(id, uintBytes(n, fixed));

function float64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, n);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Buffered sequential writer; patches are applied after the final flush. */
class Writer {
  pos = 0;
  private readonly buf: Uint8Array;
  private bufStart = 0;
  private bufLen = 0;
  private patches: { at: number; bytes: Uint8Array }[] = [];

  constructor(
    private readonly sink: RepairSink,
    bufferSize = WRITE_BUFFER,
  ) {
    this.buf = new Uint8Array(bufferSize);
  }

  async append(bytes: Uint8Array): Promise<void> {
    if (this.bufLen + bytes.length > this.buf.length) await this.flush();
    if (bytes.length > this.buf.length) {
      await this.sink.write(bytes, this.pos);
      this.pos += bytes.length;
      this.bufStart = this.pos;
      return;
    }
    this.buf.set(bytes, this.bufLen);
    this.bufLen += bytes.length;
    this.pos += bytes.length;
  }

  /** Drops everything written after `pos` (an empty trailing Cluster). */
  async rewind(pos: number): Promise<void> {
    if (pos >= this.bufStart) this.bufLen = pos - this.bufStart;
    else {
      this.bufLen = 0;
      this.bufStart = pos;
    }
    this.pos = pos;
    this.patches = this.patches.filter((p) => p.at < pos);
  }

  patch(at: number, bytes: Uint8Array): void {
    this.patches.push({ at, bytes });
  }

  async flush(): Promise<void> {
    if (this.bufLen) await this.sink.write(this.buf.slice(0, this.bufLen), this.bufStart);
    this.bufStart += this.bufLen;
    this.bufLen = 0;
  }

  async finish(): Promise<void> {
    await this.flush();
    for (const p of this.patches) await this.sink.write(p.bytes, p.at);
    await this.sink.truncate(this.pos);
  }
}

// ---------------------------------------------------------------- repair

/** SeekHead with fixed-width positions, so its length is known before the positions are. */
function seekHead(entries: { id: number; pos: number }[]): Uint8Array {
  return element(
    ID.SeekHead,
    concat(
      entries.map((e) =>
        element(ID.Seek, concat([element(ID.SeekID, idBytes(e.id)), uintElement(ID.SeekPosition, e.pos, 8)])),
      ),
    ),
  );
}

interface TrackTimes {
  last: number;
  prev: number;
  lastDuration?: number;
}

export interface RepairOptions {
  onProgress?: (fraction: number) => void;
  /** Bytes read per source request (tests use small values to exercise window changes). */
  readWindow?: number;
  /** Bytes buffered per sink write. */
  writeBuffer?: number;
}

export async function repairWebm(src: RepairSource, sink: RepairSink, opts: RepairOptions = {}): Promise<RepairResult> {
  const { onProgress } = opts;
  const r = new Reader(src, opts.readWindow);
  const w = new Writer(sink, opts.writeBuffer);
  let progressAt = 0;
  const progress = (pos: number) => {
    if (onProgress && pos - progressAt > 16 * 1024 * 1024) {
      progressAt = pos;
      onProgress(pos / src.size);
    }
  };

  // EBML header, copied as is.
  const ebml = await r.header(0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === UNKNOWN) throw new WebmRepairError('not a WebM file');
  const ebmlBytes = await r.payload(0, ebml);
  if (!ebmlBytes) throw new WebmRepairError('file too short');
  await w.append(concat([new Uint8Array([...idBytes(ID.EBML), ...sizeMin(ebml.size)]), ebmlBytes]));

  const segPos = ebml.len + ebml.size;
  const seg = await r.header(segPos);
  if (!seg || seg.id !== ID.Segment) throw new WebmRepairError('no Segment');
  const segEnd = seg.size === UNKNOWN ? src.size : Math.min(src.size, segPos + seg.len + seg.size);

  const outSegHeader = w.pos;
  await w.append(new Uint8Array([...idBytes(ID.Segment), ...size8(0)]));
  const segData = w.pos; // positions in SeekHead and Cues are relative to this
  const seekHeadAt = w.pos;
  const seekIds = [ID.Info, ID.Tracks, ID.Cues];
  await w.append(seekHead(seekIds.map((id) => ({ id, pos: 0 }))));

  let timecodeScale = 1_000_000;
  let durationAt = -1;
  let infoPos = -1;
  let tracksPos = -1;
  let videoTrack = 0;
  let firstTrack = 0;
  const times = new Map<number, TrackTimes>();
  const cues: { time: number; track: number; cluster: number }[] = [];
  let clusters = 0;
  let pos = segPos + seg.len;
  let cleanEnd = true;

  const noteBlock = (track: number, time: number, duration?: number) => {
    const t = times.get(track);
    if (!t) times.set(track, { last: time, prev: time, lastDuration: duration });
    else if (time >= t.last) {
      t.prev = t.last;
      t.last = time;
      t.lastDuration = duration;
    }
  };

  segment: while (pos < segEnd) {
    const h = await r.header(pos);
    if (!h) {
      cleanEnd = false;
      break;
    }

    if (h.id === ID.Cluster) {
      // ------------------------------------------------ Cluster
      if (infoPos < 0 || tracksPos < 0) throw new WebmRepairError('Cluster before Info/Tracks');
      const clusterOut = w.pos;
      await w.append(new Uint8Array([...idBytes(ID.Cluster), ...size8(0)]));
      const bodyOut = w.pos;
      const end = h.size === UNKNOWN ? segEnd : pos + h.len + h.size;
      let c = pos + h.len;
      let clusterTime = 0;
      let blocks = 0;
      let keyframe: number | undefined;
      let truncated = false;

      while (c < end) {
        const ch = await r.header(c);
        if (!ch) {
          truncated = true;
          break;
        }
        if (h.size === UNKNOWN && LEVEL1.has(ch.id)) break;
        if (ch.size === UNKNOWN || c + ch.len + ch.size > end) {
          truncated = true;
          break;
        }
        const body = c + ch.len;

        if (ch.id === ID.Timecode) {
          const p = await r.payload(c, ch);
          if (p) clusterTime = readUint(p);
        } else if (ch.id === ID.SimpleBlock) {
          if (!(await r.ensure(body, Math.min(ch.size, 12)))) { truncated = true; break; }
          const b = blockHead(r.bytes(body, Math.min(ch.size, 12)));
          if (b) {
            blocks++;
            noteBlock(b.track, clusterTime + b.rel);
            if (b.track === videoTrack && b.flags & 0x80 && keyframe === undefined) keyframe = clusterTime + b.rel;
          }
        } else if (ch.id === ID.BlockGroup) {
          // Chrome puts video frames in BlockGroups; a keyframe has no ReferenceBlock.
          let g = body;
          let head: ReturnType<typeof blockHead> = null;
          let hasRef = false;
          let duration: number | undefined;
          while (g < body + ch.size) {
            const gh = await r.header(g);
            if (!gh || gh.size === UNKNOWN) break;
            if (gh.id === ID.Block && (await r.ensure(g + gh.len, Math.min(gh.size, 12)))) {
              head = blockHead(r.bytes(g + gh.len, Math.min(gh.size, 12)));
            } else if (gh.id === ID.ReferenceBlock) hasRef = true;
            else if (gh.id === ID.BlockDuration) {
              const p = await r.payload(g, gh);
              if (p) duration = readUint(p);
            }
            g += gh.len + gh.size;
          }
          if (head) {
            blocks++;
            noteBlock(head.track, clusterTime + head.rel, duration);
            if (head.track === videoTrack && !hasRef && keyframe === undefined) keyframe = clusterTime + head.rel;
          }
        }

        // Copy the child element verbatim, window by window.
        for (let at = c, left = ch.len + ch.size; left > 0; ) {
          const n = Math.min(left, r.window);
          await r.ensure(at, n);
          await w.append(r.bytes(at, n));
          at += n;
          left -= n;
        }
        c = body + ch.size;
        progress(c);
      }

      if (blocks === 0) {
        await w.rewind(clusterOut);
      } else {
        clusters++;
        w.patch(clusterOut + idBytes(ID.Cluster).length, new Uint8Array(size8(w.pos - bodyOut)));
        const cueTrack = videoTrack || firstTrack;
        if (keyframe !== undefined) cues.push({ time: keyframe, track: cueTrack, cluster: clusterOut - segData });
        else if (!videoTrack) cues.push({ time: clusterTime, track: cueTrack, cluster: clusterOut - segData });
      }
      if (truncated) {
        cleanEnd = false;
        pos = c;
        break segment;
      }
      pos = c;
      continue;
    }

    // ------------------------------------------------ other Segment children
    if (h.size === UNKNOWN) throw new WebmRepairError(`unknown-size element 0x${h.id.toString(16)}`);
    if (pos + h.len + h.size > segEnd) {
      cleanEnd = false;
      break;
    }

    if (h.id === ID.Info) {
      const p = await r.payload(pos, h);
      if (!p) throw new WebmRepairError('Info unreadable');
      const kept: Uint8Array[] = [];
      for (const sub of await children(p)) {
        const whole = p.subarray(sub.at, sub.at + sub.len + sub.size);
        if (sub.id === ID.TimecodeScale) timecodeScale = readUint(whole.subarray(sub.len)) || timecodeScale;
        if (sub.id !== ID.Duration) kept.push(whole);
      }
      const durationEl = element(ID.Duration, float64(0));
      const info = element(ID.Info, concat([...kept, durationEl]));
      infoPos = w.pos - segData;
      durationAt = w.pos + info.length - 8;
      await w.append(info);
    } else if (h.id === ID.Tracks) {
      const p = await r.payload(pos, h);
      if (!p) throw new WebmRepairError('Tracks unreadable');
      for (const te of await children(p)) {
        if (te.id !== ID.TrackEntry) continue;
        let number = 0;
        let type = 0;
        const entry = p.subarray(te.at + te.len, te.at + te.len + te.size);
        for (const f of await children(entry)) {
          const v = readUint(entry.subarray(f.at + f.len, f.at + f.len + f.size));
          if (f.id === ID.TrackNumber) number = v;
          if (f.id === ID.TrackType) type = v;
        }
        firstTrack ||= number;
        if (type === TRACK_VIDEO && !videoTrack) videoTrack = number;
      }
      tracksPos = w.pos - segData;
      await w.append(element(ID.Tracks, p));
    } else if (h.id === ID.SeekHead || h.id === ID.Cues || h.id === ID.Void) {
      // Rebuilt below / padding: dropped.
    } else {
      // Tags, Chapters…: kept as they are.
      const p = await r.payload(pos, h);
      if (p) await w.append(concat([new Uint8Array([...idBytes(h.id), ...sizeMin(h.size)]), p]));
    }
    pos += h.len + h.size;
  }

  if (clusters === 0) throw new WebmRepairError('no complete frames');

  // Cues after the last Cluster; the SeekHead points at them.
  const cuesPos = w.pos - segData;
  await w.append(
    element(
      ID.Cues,
      concat(
        cues.map((c) =>
          element(
            ID.CuePoint,
            concat([
              uintElement(ID.CueTime, c.time),
              element(ID.CueTrackPositions, concat([uintElement(ID.CueTrack, c.track), uintElement(ID.CueClusterPosition, c.cluster)])),
            ]),
          ),
        ),
      ),
    ),
  );

  // Duration in TimecodeScale units: end of the latest track, adding its last frame's length.
  let durationTicks = 0;
  for (const t of times.values()) {
    durationTicks = Math.max(durationTicks, t.last + (t.lastDuration ?? t.last - t.prev));
  }

  w.patch(outSegHeader + idBytes(ID.Segment).length, new Uint8Array(size8(w.pos - segData)));
  w.patch(durationAt, float64(durationTicks));
  w.patch(seekHeadAt, seekHead([
    { id: ID.Info, pos: infoPos },
    { id: ID.Tracks, pos: tracksPos },
    { id: ID.Cues, pos: cuesPos },
  ]));
  await w.finish();
  onProgress?.(1);

  return {
    durationS: (durationTicks * timecodeScale) / 1e9,
    clusters,
    cues: cues.length,
    inputBytes: src.size,
    outputBytes: w.pos,
    droppedBytes: cleanEnd ? 0 : src.size - pos,
  };
}

/**
 * Cheap check on the first bytes: true unless the file already has a known Segment size that
 * matches the file, a Duration and a SeekHead entry for Cues (i.e. it was repaired before).
 */
export async function needsRepair(src: RepairSource): Promise<boolean> {
  const r = new Reader(src);
  const ebml = await r.header(0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === UNKNOWN) return true;
  const segPos = ebml.len + ebml.size;
  const seg = await r.header(segPos);
  if (!seg || seg.id !== ID.Segment || seg.size === UNKNOWN) return true;
  if (segPos + seg.len + seg.size !== src.size) return true;
  let hasDuration = false;
  let hasCues = false;
  let pos = segPos + seg.len;
  for (let i = 0; i < 4 && pos < src.size; i++) {
    const h = await r.header(pos);
    if (!h || h.size === UNKNOWN || h.id === ID.Cluster) break;
    const p = await r.payload(pos, h);
    if (!p) break;
    if (h.id === ID.SeekHead) {
      for (const seek of await children(p)) {
        const entry = p.subarray(seek.at + seek.len, seek.at + seek.len + seek.size);
        for (const f of await children(entry)) {
          if (f.id === ID.SeekID && readUint(entry.subarray(f.at + f.len, f.at + f.len + f.size)) === ID.Cues) hasCues = true;
        }
      }
    }
    if (h.id === ID.Info) hasDuration = (await children(p)).some((c) => c.id === ID.Duration);
    pos += h.len + h.size;
  }
  return !(hasDuration && hasCues);
}

/** Direct children of an in-memory master element payload. */
async function children(payload: Uint8Array): Promise<(Header & { at: number })[]> {
  const r = new Reader({ size: payload.length, read: async (a, n) => payload.subarray(a, a + n) });
  const out: (Header & { at: number })[] = [];
  for (let at = 0; at < payload.length; ) {
    const h = await r.header(at);
    if (!h || h.size === UNKNOWN || at + h.len + h.size > payload.length) break;
    out.push({ ...h, at });
    at += h.len + h.size;
  }
  return out;
}
