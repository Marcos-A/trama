import {
  EXPORTS_DIR,
  LOCK_PREFIX,
  RECORDINGS_DIR,
  REPAIR_PREFIX,
  type ConvertRequest,
  type ConvertResponse,
  type RepairResponse,
} from './shared.ts';

async function dir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(RECORDINGS_DIR, { create: true });
}

export async function getRecording(name: string): Promise<File> {
  const fh = await (await dir()).getFileHandle(name);
  return fh.getFile();
}

export async function deleteRecording(name: string): Promise<void> {
  await (await dir()).removeEntry(name);
}

async function heldRecordingLocks(): Promise<Set<string>> {
  return new Set(
    ((await navigator.locks.query()).held ?? [])
      .map((l) => l.name ?? '')
      .filter((n) => n.startsWith(LOCK_PREFIX))
      .map((n) => n.slice(LOCK_PREFIX.length)),
  );
}

/**
 * Finishes or discards repairs interrupted by a closed tab. The worker deletes the original only
 * after the repaired copy is complete, so: original still there → the copy is partial, delete
 * it; original gone → the copy is the recording, give it the original name.
 */
async function tidyRepairs(d: FileSystemDirectoryHandle, held: Set<string>): Promise<void> {
  const names = new Set<string>();
  for await (const name of d.keys()) names.add(name);
  for (const tmpName of names) {
    if (!tmpName.startsWith(REPAIR_PREFIX)) continue;
    const name = tmpName.slice(REPAIR_PREFIX.length);
    if (held.has(name)) continue; // a tab is repairing it right now
    try {
      if (names.has(name)) await d.removeEntry(tmpName);
      else await ((await d.getFileHandle(tmpName)) as FileSystemFileHandle & { move(n: string): Promise<void> }).move(name);
    } catch {
      // Gone or busy meanwhile (another tab tidied it, or it is still open): the next load retries.
    }
  }
}

/**
 * Recordings left in OPFS that no tab is writing or repairing right now (a tab holds a Web Lock
 * per file). These are leftovers from a closed tab, a crash or an unsaved export.
 */
export async function leftoverRecordings(): Promise<File[]> {
  const held = await heldRecordingLocks();
  const d = await dir();
  await tidyRepairs(d, held);
  const files: File[] = [];
  for await (const [name, handle] of d.entries()) {
    if (handle.kind !== 'file' || held.has(name) || name.startsWith(REPAIR_PREFIX)) continue;
    // A file deleted from another tab while listing is skipped, not an error for the whole list.
    const file = await (handle as FileSystemFileHandle).getFile().catch(() => null);
    if (file) files.push(file);
  }
  return files.sort((a, b) => b.lastModified - a.lastModified);
}

export type RepairOutcome = Extract<RepairResponse, { t: 'done' }>;

/**
 * Makes the recording seekable with a known duration (worker, see repair.worker.ts). Holds the
 * file's lock meanwhile so other tabs neither list nor touch it. Rejects with the worker's
 * error; the original file is then unchanged.
 */
export function repairRecording(name: string, onProgress: (fraction: number) => void): Promise<RepairOutcome> {
  return navigator.locks.request(LOCK_PREFIX + name, () => {
    const worker = new Worker(new URL('./repair.worker.ts', import.meta.url), { type: 'module' });
    return new Promise<RepairOutcome>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<RepairResponse>) => {
        const m = e.data;
        if (m.t === 'progress') return onProgress(m.fraction);
        worker.terminate();
        if (m.t === 'done') resolve(m);
        else reject(new DOMException(m.message, m.name));
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(e.message || 'repair worker failed'));
      };
      worker.postMessage({ name });
    });
  });
}

type SavePicker = (opts: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

const FILE_TYPES = {
  webm: { description: 'Vídeo WebM', accept: { 'video/webm': ['.webm'] } },
  mp4: { description: 'Vídeo MP4', accept: { 'video/mp4': ['.mp4'] } },
};

function savePicker(): SavePicker | undefined {
  return (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
}

/** The native save dialog; null if the user cancels, undefined if the browser has none. */
export async function pickSaveFile(name: string, kind: keyof typeof FILE_TYPES): Promise<FileSystemFileHandle | null | undefined> {
  const picker = savePicker();
  if (!picker) return undefined;
  try {
    return await picker({ suggestedName: name, types: [FILE_TYPES[kind]] });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

export function downloadFile(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Saves through the native save dialog when available, otherwise as a download. */
export async function exportRecording(file: File, name: string): Promise<'saved' | 'downloaded' | 'cancelled'> {
  const handle = await pickSaveFile(name, 'webm');
  if (handle === null) return 'cancelled';
  if (handle) {
    // Streams from disk to disk: the recording is never held whole in memory.
    await file.stream().pipeTo(await handle.createWritable());
    return 'saved';
  }
  downloadFile(file, name);
  return 'downloaded';
}

// ---------------------------------------------------------------- MP4

async function exportsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(EXPORTS_DIR, { create: true });
}

/**
 * A file in OPFS to convert into when there is no save dialog; it is then offered as a
 * download. Earlier ones are removed first: their downloads have long finished.
 */
export async function exportFileInBrowser(name: string): Promise<FileSystemFileHandle> {
  await clearExports();
  return (await exportsDir()).getFileHandle(name, { create: true });
}

/** Removes MP4s converted for downloads (on load, and before the next one). */
export async function clearExports(): Promise<void> {
  const d = await exportsDir();
  for await (const name of d.keys()) await d.removeEntry(name).catch(() => {});
}

export type ConvertOutcome = Extract<ConvertResponse, { t: 'done' }>;

/**
 * Converts the recording to MP4 into `dest` (worker, see convert.worker.ts), holding the
 * recording's lock meanwhile so other tabs neither list nor delete it. Resolves to null if
 * cancelled through `signal`; rejects with the worker's error. `dest` is only written when the
 * conversion completes.
 */
export function convertRecordingToMp4(
  name: string,
  dest: FileSystemFileHandle,
  onProgress: (fraction: number, workerHeapMB?: number) => void,
  signal: AbortSignal,
): Promise<ConvertOutcome | null> {
  return navigator.locks.request(LOCK_PREFIX + name, () => {
    const worker = new Worker(new URL('./convert.worker.ts', import.meta.url), { type: 'module' });
    const send = (msg: ConvertRequest) => worker.postMessage(msg);
    return new Promise<ConvertOutcome | null>((resolve, reject) => {
      const onAbort = () => send({ t: 'cancel' });
      signal.addEventListener('abort', onAbort, { once: true });
      const finish = () => {
        signal.removeEventListener('abort', onAbort);
        worker.terminate();
      };
      worker.onmessage = (e: MessageEvent<ConvertResponse>) => {
        const m = e.data;
        if (m.t === 'progress') return onProgress(m.fraction, m.heapMB);
        finish();
        if (m.t === 'done') resolve(m);
        else if (m.t === 'cancelled') resolve(null);
        else reject(new DOMException(m.message, m.name));
      };
      worker.onerror = (e) => {
        finish();
        reject(new Error(e.message || 'convert worker failed'));
      };
      send({ t: 'start', name, dest });
    });
  });
}
