// Appends recording chunks to a file in the Origin Private File System.
// createSyncAccessHandle() writes in place (no .crswap temp file), and flush() after every
// chunk means a crash or closed tab leaves a file that is complete up to the last chunk.

import { RECORDINGS_DIR, type WriterRequest, type WriterResponse } from './shared.ts';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let handle: FileSystemSyncAccessHandle | null = null;
let offset = 0;
// Messages are handled strictly in order: chunks may arrive while 'open' is still awaiting.
let queue: Promise<void> = Promise.resolve();

function reply(msg: WriterResponse): void {
  ctx.postMessage(msg);
}

async function handleMessage(m: WriterRequest): Promise<void> {
  switch (m.t) {
    case 'open': {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(RECORDINGS_DIR, { create: true });
      const file = await dir.getFileHandle(m.name, { create: true });
      handle = await file.createSyncAccessHandle();
      offset = handle.getSize();
      reply({ t: 'opened', size: offset });
      return;
    }
    case 'chunk': {
      if (!handle) throw new Error('chunk before open');
      const t0 = performance.now();
      const bytes = handle.write(new Uint8Array(m.data), { at: offset });
      offset += bytes;
      handle.flush();
      reply({ t: 'written', seq: m.seq, bytes, total: offset, ms: performance.now() - t0 });
      return;
    }
    case 'close': {
      if (handle) {
        handle.flush();
        handle.close();
        handle = null;
      }
      reply({ t: 'closed', total: offset });
      return;
    }
  }
}

ctx.onmessage = (e: MessageEvent<WriterRequest>) => {
  const m = e.data;
  queue = queue
    .then(() => handleMessage(m))
    .catch((err: unknown) => {
      const e2 = err instanceof Error ? err : new Error(String(err));
      reply({ t: 'error', name: e2.name, message: e2.message });
    });
};
