import { heapMB, log, storageMB } from './log.ts';
import { LOCK_PREFIX, type WriterRequest, type WriterResponse } from './shared.ts';

export const TIMESLICE_MS = 1000;
const SAMPLE_EVERY = 30; // chunks, i.e. about every 30 s
const LOW_SPACE_MB = 500;

const MIME_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export type StopReason = 'user' | 'share-ended' | 'write-error' | 'quota' | 'recorder-error';
export type TrackEvent = 'audio-ended' | 'audio-muted' | 'audio-unmuted' | 'video-muted' | 'video-unmuted';

export interface RecordingEvents {
  onProgress(totalBytes: number): void;
  onTrack(ev: TrackEvent): void;
  onLowSpace(freeMB: number): void;
  onStopped(reason: StopReason, totalBytes: number): void;
}

export function pickMimeType(): string {
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

/**
 * Tab audio is recorded untouched. Chrome and Edge otherwise apply their microphone processing
 * to it and downmix it to mono; Teams has already cleaned each voice, and a second pass can only
 * lose detail the transcription needs, for good. With these off, both browsers deliver stereo at
 * the device rate (44.1 kHz on the test Mac). Only echoCancellation actually switches the path:
 * the other two are ignored without it (docs/manual-tests.md, 7f).
 */
const AUDIO_PROCESSING_OFF = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/** Opens the browser picker, steered towards a tab with its audio. Needs a user gesture. */
export function requestTabStream(): Promise<MediaStream> {
  const options = {
    video: { displaySurface: 'browser' },
    audio: {
      suppressLocalAudioPlayback: false, // the user keeps hearing the meeting
      ...AUDIO_PROCESSING_OFF,
    },
    selfBrowserSurface: 'exclude',
    monitorTypeSurfaces: 'exclude',
    surfaceSwitching: 'include',
  };
  return navigator.mediaDevices.getDisplayMedia(options as DisplayMediaStreamOptions);
}

export function recordingName(start: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const d = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  const t = `${pad(start.getHours())}-${pad(start.getMinutes())}-${pad(start.getSeconds())}`;
  return `trama-${d}_${t}.webm`;
}

export class Recording {
  readonly name: string;
  readonly mimeType: string;
  readonly startedAt = Date.now();
  readonly hasAudio: boolean;
  totalBytes = 0;

  private readonly worker: Worker;
  private recorder: MediaRecorder | null = null;
  private seq = 0;
  private pending: Promise<void> = Promise.resolve();
  private lastChunkAt = 0;
  private maxWriteMs = 0;
  private stopReason: StopReason = 'user';
  private releaseLock: () => void = () => {};
  private openWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private onClosed: ((total: number) => void) | null = null;

  constructor(
    readonly stream: MediaStream,
    private readonly ev: RecordingEvents,
    /** Simulated quota for checklist item 7 (`?quota=<MB>`); undefined = real quota only. */
    private readonly quotaLimitBytes?: number,
  ) {
    this.name = recordingName(new Date(this.startedAt));
    this.mimeType = pickMimeType();
    this.hasAudio = stream.getAudioTracks().length > 0;
    this.worker = new Worker(new URL('./writer.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WriterResponse>) => this.fromWorker(e.data);
    this.worker.onerror = (e) => {
      log('worker-error', { message: e.message });
      this.stop('write-error');
    };
  }

  private send(msg: WriterRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  async start(): Promise<void> {
    const opened = new Promise<void>((resolve, reject) => (this.openWaiter = { resolve, reject }));
    this.send({ t: 'open', name: this.name });
    await opened;

    // Held for as long as this tab writes the file, so another tab's leftover scan skips it.
    await new Promise<void>((granted) => {
      void navigator.locks.request(LOCK_PREFIX + this.name, () => {
        granted();
        return new Promise<void>((release) => (this.releaseLock = release));
      });
    });

    for (const track of this.stream.getTracks()) this.watchTrack(track);

    const rec = new MediaRecorder(this.stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    this.recorder = rec;
    rec.ondataavailable = (e) => this.onChunk(e.data);
    rec.onerror = (e) => {
      log('recorder-error', { error: String((e as Event & { error?: unknown }).error) });
      this.stop('recorder-error');
    };
    rec.onstop = () => void this.finish();
    rec.start(TIMESLICE_MS);

    log('recording-started', {
      name: this.name,
      mimeType: rec.mimeType,
      tracks: this.stream.getTracks().map((t) => ({ kind: t.kind, label: t.label, settings: t.getSettings() })),
      heapMB: heapMB(),
      storage: await storageMB(),
    });
  }

  stop(reason: StopReason): void {
    if (!this.recorder || this.recorder.state === 'inactive') return;
    this.stopReason = reason;
    log('stop-requested', { reason });
    this.recorder.stop();
  }

  private watchTrack(track: MediaStreamTrack): void {
    track.addEventListener('ended', () => {
      log('track-ended', { kind: track.kind });
      if (track.kind === 'video') this.stop('share-ended');
      else this.ev.onTrack('audio-ended');
    });
    track.addEventListener('mute', () => {
      log('track-muted', { kind: track.kind });
      this.ev.onTrack(track.kind === 'audio' ? 'audio-muted' : 'video-muted');
    });
    track.addEventListener('unmute', () => {
      log('track-unmuted', { kind: track.kind });
      this.ev.onTrack(track.kind === 'audio' ? 'audio-unmuted' : 'video-unmuted');
    });
  }

  private onChunk(blob: Blob): void {
    if (!blob.size) return;
    const now = performance.now();
    // Background throttling or a stalled encoder shows up as a gap between chunks.
    if (this.lastChunkAt && now - this.lastChunkAt > TIMESLICE_MS * 2.5) {
      log('chunk-gap', { ms: Math.round(now - this.lastChunkAt), hidden: document.hidden });
    }
    this.lastChunkAt = now;
    const seq = this.seq++;
    // Chained so chunks reach the worker in recording order even though arrayBuffer() is async.
    this.pending = this.pending.then(async () => {
      const data = await blob.arrayBuffer();
      this.send({ t: 'chunk', seq, data }, [data]);
    });
  }

  private fromWorker(m: WriterResponse): void {
    switch (m.t) {
      case 'opened':
        if (m.size > 0) log('opened-existing-file', { size: m.size });
        this.openWaiter?.resolve();
        this.openWaiter = null;
        return;
      case 'written':
        this.totalBytes = m.total;
        this.maxWriteMs = Math.max(this.maxWriteMs, m.ms);
        this.ev.onProgress(m.total);
        if (m.seq % SAMPLE_EVERY === 0) void this.sample(m.seq);
        if (this.quotaLimitBytes !== undefined && m.total > this.quotaLimitBytes && this.recorder?.state === 'recording') {
          log('simulated-quota-reached', { limitMB: this.quotaLimitBytes / 1e6 });
          this.stop('quota');
        }
        return;
      case 'closed':
        this.onClosed?.(m.total);
        return;
      case 'error':
        log('write-error', m);
        if (this.openWaiter) {
          this.openWaiter.reject(new DOMException(m.message, m.name));
          this.openWaiter = null;
          this.worker.terminate();
          return;
        }
        this.stop(m.name === 'QuotaExceededError' ? 'quota' : 'write-error');
        return;
    }
  }

  private async sample(seq: number): Promise<void> {
    const storage = await storageMB();
    log('sample', {
      seq,
      elapsedS: Math.round((Date.now() - this.startedAt) / 1000),
      fileMB: Math.round(this.totalBytes / 1e6),
      maxWriteMs: Math.round(this.maxWriteMs),
      heapMB: heapMB(),
      storage,
      hidden: document.hidden,
    });
    this.maxWriteMs = 0;
    if (storage && storage.free < LOW_SPACE_MB) this.ev.onLowSpace(storage.free);
  }

  private async finish(): Promise<void> {
    await this.pending;
    const closed = new Promise<number>((r) => (this.onClosed = r));
    this.send({ t: 'close' });
    const total = await closed;
    this.releaseLock();
    this.worker.terminate();
    for (const t of this.stream.getTracks()) t.stop();
    log('recording-stopped', {
      reason: this.stopReason,
      fileMB: +(total / 1e6).toFixed(1),
      chunks: this.seq,
      durationS: Math.round((Date.now() - this.startedAt) / 1000),
      heapMB: heapMB(),
    });
    this.ev.onStopped(this.stopReason, total);
  }
}
