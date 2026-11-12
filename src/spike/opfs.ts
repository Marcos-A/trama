import { LOCK_PREFIX, RECORDINGS_DIR, REPAIR_PREFIX, type RepairResponse } from './shared.ts';

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
    if (names.has(name)) await d.removeEntry(tmpName);
    else await ((await d.getFileHandle(tmpName)) as FileSystemFileHandle & { move(n: string): Promise<void> }).move(name);
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
    files.push(await (handle as FileSystemFileHandle).getFile());
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

/** Saves through the native save dialog when available, otherwise as a download. */
export async function exportRecording(file: File, name: string): Promise<'saved' | 'downloaded' | 'cancelled'> {
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker) {
    let handle: FileSystemFileHandle;
    try {
      handle = await picker({
        suggestedName: name,
        types: [{ description: 'Vídeo WebM', accept: { 'video/webm': ['.webm'] } }],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      throw err;
    }
    // Streams from disk to disk: the recording is never held whole in memory.
    await file.stream().pipeTo(await handle.createWritable());
    return 'saved';
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return 'downloaded';
}
