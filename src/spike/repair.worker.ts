// Repairs a finished recording in OPFS (Duration, Cues, sizes: see src/media/webm-repair.ts).
// Writes to a temporary file and only replaces the original once the copy is complete, so a
// failure or a closed tab never costs the recording. Needs free space for a second copy.

import { needsRepair, repairWebm } from '../media/webm-repair.ts';
import { RECORDINGS_DIR, REPAIR_PREFIX, type RepairRequest, type RepairResponse } from './shared.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const SPACE_MARGIN = 50e6;

function reply(msg: RepairResponse): void {
  ctx.postMessage(msg);
}

type MovableHandle = FileSystemFileHandle & { move(name: string): Promise<void> };

async function repair(name: string): Promise<void> {
  const t0 = performance.now();
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(RECORDINGS_DIR);
  const file = await (await dir.getFileHandle(name)).getFile();
  const src = {
    size: file.size,
    read: async (pos: number, len: number) => new Uint8Array(await file.slice(pos, pos + len).arrayBuffer()),
  };
  if (!(await needsRepair(src))) {
    reply({ t: 'done', skipped: true, ms: Math.round(performance.now() - t0) });
    return;
  }

  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  if (quota - usage < file.size + SPACE_MARGIN) {
    throw new DOMException(`needs ${Math.round(file.size / 1e6)} MB free, has ${Math.round((quota - usage) / 1e6)} MB`, 'QuotaExceededError');
  }

  const tmpName = REPAIR_PREFIX + name;
  const tmp = (await dir.getFileHandle(tmpName, { create: true })) as MovableHandle;
  const handle = await tmp.createSyncAccessHandle();
  let result;
  try {
    handle.truncate(0);
    result = await repairWebm(
      src,
      {
        write(bytes, at) {
          if (handle.write(bytes, { at }) !== bytes.length) throw new Error('short write');
        },
        truncate: (size) => handle.truncate(size),
      },
      { onProgress: (fraction) => reply({ t: 'progress', fraction }) },
    );
    handle.flush();
  } catch (err) {
    handle.close();
    await dir.removeEntry(tmpName).catch(() => {});
    throw err;
  }
  handle.close();

  // The repaired copy is complete: from here on, a leftover .repair- file without its original
  // is the good one (see tidyRepairs in opfs.ts).
  await dir.removeEntry(name);
  await tmp.move(name);
  reply({ t: 'done', skipped: false, ...result, ms: Math.round(performance.now() - t0) });
}

ctx.onmessage = (e: MessageEvent<RepairRequest>) => {
  repair(e.data.name).catch((err: unknown) => {
    const e2 = err instanceof Error ? err : new Error(String(err));
    reply({ t: 'error', name: e2.name, message: e2.message });
  });
};
