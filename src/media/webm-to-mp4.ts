// Converts a recorded WebM (VP8/VP9 + Opus) to MP4 (H.264 + AAC) in the browser, with
// WebCodecs doing the decoding and encoding and Mediabunny demuxing and muxing. No media leaves
// the machine and nothing needs WebAssembly, so the CSP stays as it is (PLAN §7).
//
// Streaming: the input is read from a Blob (an OPFS file) through a small cache and the output
// goes to positional writes (a FileSystemWritableFileStream), so a 2-hour recording is never
// held in memory. The caller commits or discards the output: Mediabunny closes its stream on
// cancel too, and closing a FileSystemWritableFileStream would publish a partial file. The moov box goes at the end (no fast start), which costs nothing for
// a file played from disk and avoids holding the sample tables or a second pass.
//
// Alpha: Chrome's MediaRecorder marks the video track AlphaMode=1 and adds alpha planes when the
// source frames have an alpha channel (a canvas does; tab capture should not). Mediabunny then
// decodes the alpha and merges it in a blob: worker, which `worker-src 'self'` blocks. The MP4
// has no alpha anyway, so the input is shown to Mediabunny with AlphaMode read as 0
// (src/media/webm-alpha.ts) and the alpha planes are ignored.
//
// Audio: AAC when the browser can encode it (Chrome and Edge on macOS and Windows use the
// platform encoder); otherwise Opus (Linux), which browsers and VLC play but QuickTime may not.
// The caller is told which one it got. Either way the audio is decoded and re-encoded, and on
// the way it is put back on the WebM's recorded timeline (src/media/audio-retime.ts): silence
// where the recording has a gap or its audio clock ran slow, frames dropped where it ran fast,
// so the MP4 stays in sync with the picture as the WebM does.
//
// AAC priming: an AAC encoder starts its output with 2112 frames of delay (the "priming"), so a
// sound fed in at 0 s comes out 44 ms (at 48 kHz) into the track. The audio is therefore placed
// that much earlier, starting before zero; Mediabunny turns the negative start into an edit list
// (elst) that tells players to skip the priming, as QuickTime and browsers do. Measured on macOS
// in Chrome and Edge (.github/workflows/mac.yml): without this the MP4's sound ran a constant
// 41–47 ms late. 2112 is Apple's AAC encoder delay; other platforms' encoders are untested.

import {
  Conversion,
  ConversionCanceledError,
  Input,
  MATROSKA,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  CustomSource,
  StreamTarget,
  WEBM,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';
import { retimer, trackTimeline, type RetimeStats } from './audio-retime.ts';
import { alphaModeOffsets } from './webm-alpha.ts';

export interface Mp4Result {
  durationS: number;
  width: number;
  height: number;
  /** 'aac', or 'opus' when the browser has no AAC encoder; null for a recording without sound. */
  audioCodec: 'aac' | 'opus' | null;
  /** How far the audio was moved to keep to its recorded timing; null without sound. */
  audioRetime: RetimeStats | null;
}

/** AAC encoder delay in frames (Apple's AudioToolbox, used by Chrome and Edge on macOS). */
export const AAC_PRIMING_FRAMES = 2112;

export interface Mp4Options {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/** Where the MP4 goes. Writes may go back to patch earlier bytes (box sizes). */
export interface Mp4Sink {
  write(data: Uint8Array<ArrayBuffer>, position: number): Promise<void> | void;
}

export { ConversionCanceledError };

/** H.264 encoders want even dimensions; tab captures can be odd after a window resize. */
const even = (n: number) => Math.max(2, n - (n % 2));

export async function convertWebmToMp4(
  src: Blob,
  sink: Mp4Sink,
  { onProgress, signal }: Mp4Options = {},
): Promise<Mp4Result> {
  signal?.throwIfAborted();
  const alphaAt = await alphaModeOffsets(src);
  const input = new Input({ source: opaqueSource(src, alphaAt), formats: [WEBM, MATROSKA] });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new DOMException('the recording has no video track', 'DataError');
    const audio = await input.getPrimaryAudioTrack();

    // Keep the size the recording started with; if the shared tab was resized mid-recording,
    // later frames are scaled into the same box (letterboxed) instead of breaking the encoder.
    const width = even(video.displayWidth);
    const height = even(video.displayHeight);
    if (!(await canEncodeVideo('avc', { width, height, quality: QUALITY_MEDIUM }))) {
      throw new DOMException(`this browser cannot encode H.264 at ${width}×${height}`, 'NotSupportedError');
    }

    let audioCodec: Mp4Result['audioCodec'] = null;
    if (audio) {
      const aac = await canEncodeAudio('aac', {
        numberOfChannels: audio.numberOfChannels,
        sampleRate: audio.sampleRate,
        quality: QUALITY_MEDIUM,
      });
      audioCodec = aac ? 'aac' : 'opus';
    }

    // The conversion's start, worked out as Conversion does without `trim`, and passed to it
    // explicitly so the audio's recorded times and the output timeline share one origin.
    const startS = Math.max(await input.getFirstTimestamp(audio ? [video, audio] : [video]), 0);
    const timeline = audio ? await trackTimeline(audio) : null;
    // AAC: start the audio one encoder delay early, so the priming falls before zero (see above).
    const primingS = audio && audioCodec === 'aac' ? AAC_PRIMING_FRAMES / audio.sampleRate : 0;
    const retime = timeline ? retimer(timeline, startS + primingS) : null;

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(
        new WritableStream({ write: (chunk) => sink.write(chunk.data, chunk.position) }), // no close: see above
        { chunked: true, chunkSize: 4 * 2 ** 20 },
      ),
    });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video: { codec: 'avc', width, height, fit: 'contain', quality: QUALITY_MEDIUM, forceTranscode: true },
      audio:
        audioCodec && retime
          ? { codec: audioCodec, quality: QUALITY_MEDIUM, forceTranscode: true, process: retime.process }
          : { discard: true },
      trim: { start: startS },
      showWarnings: false,
    });
    if (!conversion.isValid || conversion.discardedTracks.some((d) => d.reason !== 'discarded_by_user')) {
      const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(', ');
      throw new DOMException(`cannot convert (${why || 'invalid conversion'})`, 'NotSupportedError');
    }

    signal?.throwIfAborted(); // cancelled while setting up
    const onAbort = () => void conversion.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (onProgress) conversion.onProgress = (fraction) => onProgress(fraction);
    try {
      await conversion.execute();
    } finally {
      signal?.removeEventListener('abort', onAbort);
      timeline?.close();
    }

    return { durationS: await input.computeDuration(), width, height, audioCodec, audioRetime: retime?.stats ?? null };
  } finally {
    input.dispose();
  }
}

/** A source over `src` in which the bytes at `zeroAt` read as 0. */
function opaqueSource(src: Blob, zeroAt: number[]): CustomSource {
  return new CustomSource({
    getSize: () => src.size,
    read: async (start, end) => {
      const bytes = new Uint8Array(await src.slice(start, end).arrayBuffer());
      for (const at of zeroAt) if (at >= start && at < end) bytes[at - start] = 0;
      return bytes;
    },
    prefetchProfile: 'fileSystem',
  });
}
