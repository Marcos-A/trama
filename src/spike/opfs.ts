import { LOCK_PREFIX, RECORDINGS_DIR } from './shared.ts';

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

/**
 * Recordings left in OPFS that no tab is writing to right now (a recording tab holds a Web
 * Lock for its file). These are leftovers from a closed tab, a crash or an unsaved export.
 */
export async function leftoverRecordings(): Promise<File[]> {
  const held = new Set(
    ((await navigator.locks.query()).held ?? [])
      .map((l) => l.name ?? '')
      .filter((n) => n.startsWith(LOCK_PREFIX))
      .map((n) => n.slice(LOCK_PREFIX.length)),
  );
  const files: File[] = [];
  for await (const [name, handle] of (await dir()).entries()) {
    if (handle.kind !== 'file' || held.has(name)) continue;
    files.push(await (handle as FileSystemFileHandle).getFile());
  }
  return files.sort((a, b) => b.lastModified - a.lastModified);
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
