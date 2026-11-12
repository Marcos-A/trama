// Finds the WebM video track's AlphaMode flag, so the MP4 conversion can read it as 0 (see
// webm-to-mp4.ts). Chrome's MediaRecorder sets it when the source frames carry alpha.
// No DOM or Node APIs beyond Blob.

const ID = {
  Segment: 0x18538067,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  Video: 0xe0,
  AlphaMode: 0x53c0,
  Cluster: 0x1f43b675,
};
const CONTAINERS = new Set([ID.Segment, ID.Tracks, ID.TrackEntry, ID.Video]);
const HEADER_BYTES = 256 * 1024; // Tracks come before the first Cluster, within a few KB

/** EBML variable-length integer at `pos`: [value (null if "unknown"), length]. */
function vint(b: Uint8Array, pos: number, keepMarker: boolean): [number | null, number] | null {
  const first = b[pos];
  if (first === undefined || first === 0) return null;
  const len = Math.clz32(first) - 23;
  if (pos + len > b.length) return null;
  let v = keepMarker ? first : first & (0xff >> len);
  let allOnes = v === (0xff >> len);
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[pos + i];
    allOnes &&= b[pos + i] === 0xff;
  }
  return [!keepMarker && allOnes ? null : v, len];
}

/**
 * Byte offsets of the value of every AlphaMode element (1 byte, non-zero) in the WebM header, or
 * [] if there is none. Walks the EBML tree only as far as the first Cluster.
 */
export async function alphaModeOffsets(src: Blob): Promise<number[]> {
  const b = new Uint8Array(await src.slice(0, HEADER_BYTES).arrayBuffer());
  const found: number[] = [];
  let pos = 0;
  while (pos < b.length) {
    const id = vint(b, pos, true);
    if (!id) break;
    const size = vint(b, pos + id[1], false);
    if (!size) break;
    const elId = id[0]!;
    const dataAt = pos + id[1] + size[1];
    if (elId === ID.Cluster) break;
    if (CONTAINERS.has(elId)) {
      pos = dataAt; // descend: the children follow
      continue;
    }
    if (size[0] === null) break; // only Segment and Cluster have unknown sizes
    if (elId === ID.AlphaMode && size[0] === 1 && b[dataAt] !== 0) found.push(dataAt);
    pos = dataAt + size[0];
  }
  return found;
}
