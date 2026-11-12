// Converts a recording in OPFS to MP4 (see src/media/webm-to-mp4.ts), writing to the file the
// page chose: one picked with the save dialog, or a file in OPFS for the download fallback.
// The output is committed only when the conversion is complete; on error or cancel it is
// discarded, so the destination never ends up with half a video. The recording is not touched.

import { ConversionCanceledError, convertWebmToMp4 } from '../media/webm-to-mp4.ts';
import { RECORDINGS_DIR, type ConvertRequest, type ConvertResponse } from './shared.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const abort = new AbortController();

function reply(msg: ConvertResponse): void {
  ctx.postMessage(msg);
}

type RemovableHandle = FileSystemFileHandle & { remove?: () => Promise<void> };

async function convert(name: string, dest: RemovableHandle): Promise<void> {
  const t0 = performance.now();
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(RECORDINGS_DIR);
  const file = await (await dir.getFileHandle(name)).getFile();
  const out = await dest.createWritable({ keepExistingData: false });
  let outputBytes = 0;
  try {
    const result = await convertWebmToMp4(
      file,
      {
        async write(data, position) {
          await out.write({ type: 'write', position, data });
          outputBytes = Math.max(outputBytes, position + data.byteLength);
        },
      },
      { signal: abort.signal, onProgress: (fraction) => reply({ t: 'progress', fraction }) },
    );
    await out.close();
    reply({ t: 'done', ...result, inputBytes: file.size, outputBytes, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    await out.abort().catch(() => {});
    // The save dialog creates an empty file up front; don't leave it behind. A file that was
    // there before (overwrite) keeps its old contents, since nothing was committed.
    if ((await dest.getFile().catch(() => null))?.size === 0) await dest.remove?.().catch(() => {});
    throw err;
  }
}

ctx.onmessage = (e: MessageEvent<ConvertRequest>) => {
  const m = e.data;
  if (m.t === 'cancel') return abort.abort();
  convert(m.name, m.dest).catch((err: unknown) => {
    if (err instanceof ConversionCanceledError || abort.signal.aborted) return reply({ t: 'cancelled' });
    const e2 = err instanceof Error ? err : new Error(String(err));
    reply({ t: 'error', name: e2.name, message: e2.message });
  });
};
