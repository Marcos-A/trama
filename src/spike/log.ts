// Diagnostics log for the spike: every event the manual checklist needs to judge reliability
// (chunk gaps, memory, storage, track and visibility changes). Downloadable as JSON so each
// run can be attached to docs/manual-tests.md.

export interface LogEntry {
  at: string; // ISO time
  ev: string;
  data?: unknown;
}

const entries: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();

export function log(ev: string, data?: unknown): void {
  const entry: LogEntry = { at: new Date().toISOString(), ev, data };
  entries.push(entry);
  for (const l of listeners) l(entry);
}

export function onLog(fn: (e: LogEntry) => void): void {
  listeners.add(fn);
}

export function logAsBlob(): Blob {
  const env = {
    userAgent: navigator.userAgent,
    userAgentData: (navigator as Navigator & { userAgentData?: unknown }).userAgentData,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
  return new Blob([JSON.stringify({ env, entries }, null, 2)], { type: 'application/json' });
}

/** Chrome-only, non-standard; undefined elsewhere. */
export function heapMB(): number | undefined {
  const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return mem ? Math.round(mem.usedJSHeapSize / 1e6) : undefined;
}

export async function storageMB(): Promise<{ usage: number; quota: number; free: number } | undefined> {
  if (!navigator.storage?.estimate) return undefined;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage: Math.round(usage / 1e6), quota: Math.round(quota / 1e6), free: Math.round((quota - usage) / 1e6) };
}
