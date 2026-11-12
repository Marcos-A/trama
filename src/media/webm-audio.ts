// Reads the audio track of a WebM file as encoded packets, streaming (recordings reach 1–3 GB,
// so nothing is held whole in memory). Works on repaired files and on raw MediaRecorder output
// (Segment and Clusters of unknown size): the walk is flat, descending into Segment, Cluster and
// BlockGroup and skipping everything else by its size.
//
// No DOM or Node APIs; the caller decodes the packets (WebCodecs AudioDecoder in the browser).

import { ID, Reader, UNKNOWN, blockHead, readUint, type RepairSource } from './webm-repair.ts';

const TRACK_AUDIO = 2;
const CodecID = 0x86;
const CodecPrivate = 0x63a2;
const Audio = 0xe1;
const SamplingFrequency = 0xb5;
const Channels = 0x9f;
const CodecDelay = 0x56aa;

export interface AudioTrackInfo {
  number: number;
  /** Matroska codec id, e.g. "A_OPUS". */
  codecId: string;
  /** WebCodecs codec string, or null when we do not map it. */
  codec: string | null;
  sampleRate: number;
  channels: number;
  /** OpusHead for Opus; passed to AudioDecoder as `description`. */
  codecPrivate: Uint8Array | null;
  codecDelayNs: number;
}

export interface AudioPacket {
  /** Microseconds from the start of the Segment. */
  timeUs: number;
  data: Uint8Array;
}

export class WebmAudioError extends Error {
  override name = 'WebmAudioError';
}

const MASTERS = new Set<number>([ID.Segment, ID.Cluster, ID.BlockGroup]);

function float(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length === 4 ? v.getFloat32(0) : v.getFloat64(0);
}

function parseTracks(payload: Uint8Array): AudioTrackInfo | null {
  let found: AudioTrackInfo | null = null;
  walkSmall(payload, (id, body) => {
    if (id !== ID.TrackEntry || found) return;
    const t: Partial<AudioTrackInfo> & { type?: number } = { codecPrivate: null, codecDelayNs: 0, sampleRate: 48000, channels: 1 };
    walkSmall(body, (cid, c) => {
      if (cid === ID.TrackNumber) t.number = readUint(c);
      else if (cid === ID.TrackType) t.type = readUint(c);
      else if (cid === CodecID) t.codecId = new TextDecoder().decode(c);
      else if (cid === CodecPrivate) t.codecPrivate = c.slice();
      else if (cid === CodecDelay) t.codecDelayNs = readUint(c);
      else if (cid === Audio)
        walkSmall(c, (aid, a) => {
          if (aid === SamplingFrequency) t.sampleRate = float(a);
          else if (aid === Channels) t.channels = readUint(a);
        });
    });
    if (t.type === TRACK_AUDIO && t.number !== undefined && t.codecId) {
      const codec = t.codecId === 'A_OPUS' ? 'opus' : t.codecId === 'A_VORBIS' ? 'vorbis' : null;
      found = { ...(t as AudioTrackInfo), codec };
    }
  });
  return found;
}

/** Children of a small, fully loaded master element. */
function walkSmall(b: Uint8Array, fn: (id: number, body: Uint8Array) => void): void {
  let p = 0;
  while (p < b.length) {
    const idLen = vlen(b[p]);
    if (!idLen || idLen > 4 || p + idLen >= b.length) return;
    let id = 0;
    for (let i = 0; i < idLen; i++) id = id * 256 + b[p + i];
    const sl = vlen(b[p + idLen]);
    if (!sl || p + idLen + sl > b.length) return;
    let size = b[p + idLen] & (0xff >> sl);
    for (let i = 1; i < sl; i++) size = size * 256 + b[p + idLen + i];
    const start = p + idLen + sl;
    if (start + size > b.length) return;
    fn(id, b.subarray(start, start + size));
    p = start + size;
  }
}

function vlen(first: number): number {
  for (let len = 1; len <= 8; len++) if (first & (0x100 >> len)) return len;
  return 0;
}

/**
 * Opens the file: returns the audio track (null if there is none) and a generator of its
 * packets in file order. A cut-off tail ends the generator quietly.
 */
export async function openWebmAudio(src: RepairSource): Promise<{ track: AudioTrackInfo | null; durationS: number | null; packets: () => AsyncGenerator<AudioPacket> }> {
  const r = new Reader(src);
  const first = await r.header(0);
  if (!first || first.id !== ID.EBML) throw new WebmAudioError('not a WebM/Matroska file');

  let pos = first.len + first.size;
  let timecodeScale = 1_000_000;
  let durationS: number | null = null;
  let track: AudioTrackInfo | null = null;
  let firstCluster = -1;

  // Header pass: Info and Tracks come before the first Cluster in every WebM we write or read.
  while (pos < r.size) {
    const h = await r.header(pos);
    if (!h) break;
    if (h.id === ID.Segment) {
      pos += h.len;
      continue;
    }
    if (h.id === ID.Cluster) {
      firstCluster = pos;
      break;
    }
    if (h.size === UNKNOWN) throw new WebmAudioError(`unknown-size element 0x${h.id.toString(16)} before the first Cluster`);
    if (h.id === ID.Info || h.id === ID.Tracks) {
      const body = await r.payload(pos, h);
      if (!body) break;
      if (h.id === ID.Tracks) track = parseTracks(body);
      else
        walkSmall(body, (id, b) => {
          if (id === ID.TimecodeScale) timecodeScale = readUint(b);
          else if (id === ID.Duration) durationS = float(b);
        });
    }
    pos += h.len + h.size;
  }
  if (durationS !== null) durationS = (durationS * timecodeScale) / 1e9;

  async function* packets(): AsyncGenerator<AudioPacket> {
    if (!track || firstCluster < 0) return;
    let p = firstCluster;
    let clusterTime = 0;
    const scaleUs = timecodeScale / 1000;
    while (p < r.size) {
      const h = await r.header(p);
      if (!h) return;
      if (MASTERS.has(h.id)) {
        p += h.len;
        continue;
      }
      if (h.size === UNKNOWN) return;
      if (h.id === ID.Timecode) {
        const b = await r.payload(p, h);
        if (!b) return;
        clusterTime = readUint(b);
      } else if (h.id === ID.SimpleBlock || h.id === ID.Block) {
        // Read just the block head first: most blocks are video, and those we skip unread.
        if (!(await r.ensure(p + h.len, Math.min(h.size, 8)))) return;
        const head = blockHead(r.bytes(p + h.len, Math.min(h.size, 8)));
        if (head && head.track === track.number) {
          if (head.flags & 0x06) throw new WebmAudioError('laced audio blocks are not supported');
          const b = await r.payload(p, h);
          if (!b) return;
          const n = vlen(b[0]);
          yield { timeUs: Math.round((clusterTime + head.rel) * scaleUs), data: b.subarray(n + 3) };
        }
      }
      p += h.len + h.size;
    }
  }

  return { track, durationS, packets };
}
