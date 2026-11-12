// Streaming downmix + resample to 16 kHz mono (Whisper's input), for hours of audio pushed in
// small chunks. Polyphase windowed-sinc low-pass (Blackman, 32 taps, cut-off just under the
// target Nyquist) with a precomputed phase table, so the cost is ~32 multiply-adds per output
// sample: about 4 s of CPU for 2 h of audio.

const HALF = 16; // taps on each side
const PHASES = 256;

export class Resampler {
  private readonly step: number;
  private readonly table: Float32Array; // PHASES+1 rows of 2*HALF taps
  private buf = new Float32Array(4096);
  private len = 0; // valid samples in buf
  private base = 0; // absolute input index of buf[0]
  private k = 0; // next output index
  private flushed = false;

  constructor(
    readonly inRate: number,
    readonly outRate = 16000,
  ) {
    this.step = inRate / outRate;
    const cutoff = Math.min(1, outRate / inRate) * 0.94; // fraction of the input Nyquist
    this.table = new Float32Array((PHASES + 1) * 2 * HALF);
    for (let p = 0; p <= PHASES; p++) {
      const frac = p / PHASES;
      let sum = 0;
      for (let t = 0; t < 2 * HALF; t++) {
        // tap t multiplies input sample i0 - HALF + 1 + t, at distance d from the output point
        const d = t - HALF + 1 - frac;
        const x = Math.PI * cutoff * d;
        const sinc = d === 0 ? 1 : Math.sin(x) / x;
        const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / HALF) + 0.08 * Math.cos((2 * Math.PI * d) / HALF);
        const v = Math.abs(d) >= HALF ? 0 : sinc * w;
        this.table[p * 2 * HALF + t] = v;
        sum += v;
      }
      for (let t = 0; t < 2 * HALF; t++) this.table[p * 2 * HALF + t] /= sum;
    }
  }

  /** Planar channels of equal length (AudioData copyTo with format f32-planar). */
  push(channels: Float32Array[]): Float32Array {
    const n = channels[0]?.length ?? 0;
    this.reserve(n);
    const dst = this.buf.subarray(this.len, this.len + n);
    if (channels.length === 1) dst.set(channels[0]);
    else {
      const g = 1 / channels.length;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (const c of channels) s += c[i];
        dst[i] = s * g;
      }
    }
    this.len += n;
    return this.drain(false);
  }

  /** Zeros in place of missing input (a gap in the recording), keeping later audio in sync. */
  pushSilence(n: number): Float32Array {
    this.reserve(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this.drain(false);
  }

  /** Remaining output once the input has ended. */
  flush(): Float32Array {
    if (this.flushed) return new Float32Array(0);
    this.flushed = true;
    return this.drain(true);
  }

  /** Input samples consumed so far (absolute), for gap detection by the caller. */
  get inputSamples(): number {
    return this.base + this.len;
  }

  private reserve(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = new Float32Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  private drain(final: boolean): Float32Array {
    const end = this.base + this.len; // absolute index one past the last input sample
    const lastOut = final ? Math.floor((end - 1) / this.step) : Math.floor((end - HALF - 1) / this.step);
    const count = Math.max(0, lastOut - this.k + 1);
    const out = new Float32Array(count);
    const W = 2 * HALF;
    for (let o = 0; o < count; o++, this.k++) {
      const pos = this.k * this.step;
      const i0 = Math.floor(pos);
      const row = Math.round((pos - i0) * PHASES) * W;
      let s = 0;
      let j = i0 - HALF + 1 - this.base;
      for (let t = 0; t < W; t++, j++) if (j >= 0 && j < this.len) s += this.buf[j] * this.table[row + t];
      out[o] = s;
    }
    // Drop input no future output needs.
    const keepFrom = Math.floor(this.k * this.step) - HALF + 1 - this.base;
    if (keepFrom > 0) {
      const drop = Math.min(keepFrom, this.len);
      this.buf.copyWithin(0, drop, this.len);
      this.len -= drop;
      this.base += drop;
    }
    return out;
  }
}
