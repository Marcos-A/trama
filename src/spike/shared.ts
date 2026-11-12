// Shared between the page and the writer worker. Keep this module free of side effects.

export const RECORDINGS_DIR = 'recordings';
export const LOCK_PREFIX = 'trama-rec:';

export type WriterRequest =
  | { t: 'open'; name: string }
  | { t: 'chunk'; seq: number; data: ArrayBuffer }
  | { t: 'close' };

export type WriterResponse =
  | { t: 'opened'; size: number }
  | { t: 'written'; seq: number; bytes: number; total: number; ms: number }
  | { t: 'closed'; total: number }
  | { t: 'error'; name: string; message: string };

/** Repair output is written under this prefix and renamed over the original when complete. */
export const REPAIR_PREFIX = '.repair-';

export type RepairRequest = { name: string };

export type RepairResponse =
  | { t: 'progress'; fraction: number }
  | {
      t: 'done';
      skipped: boolean;
      durationS?: number;
      clusters?: number;
      cues?: number;
      inputBytes?: number;
      outputBytes?: number;
      droppedBytes?: number;
      ms: number;
    }
  | { t: 'error'; name: string; message: string };

/** MP4 conversions for the download fallback are written here and cleared on the next load. */
export const EXPORTS_DIR = 'exports';

export type ConvertRequest = { t: 'start'; name: string; dest: FileSystemFileHandle } | { t: 'cancel' };

export type ConvertResponse =
  | { t: 'progress'; fraction: number }
  | {
      t: 'done';
      durationS: number;
      width: number;
      height: number;
      audioCodec: 'aac' | 'opus' | null;
      inputBytes: number;
      outputBytes: number;
      ms: number;
    }
  | { t: 'cancelled' }
  | { t: 'error'; name: string; message: string };
