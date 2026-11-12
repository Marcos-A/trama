// Speed and memory matrix for the transcription spike, in headless Chromium on the server.
// Opt-in (slow): runs only when TRAMA_MEASURE is set, e.g.
//
//   TRAMA_MEASURE='onnx-community/whisper-small:q8,onnx-community/whisper-small:q8:coi' \
//     bash scripts/test.sh --project=transcription -g measure
//
// Each entry is model:dtype[:coi]; ":coi" loads the page cross-origin isolated, so ONNX
// Runtime may use WASM threads. Other knobs:
//   TRAMA_MEASURE_AUDIO   URL of the audio to transcribe (default: the synthetic fixture,
//                         served from /eval-data/ when given as a file name there)
//   TRAMA_MEASURE_REF     reference transcript under /eval-data/ (optional)
//   TRAMA_MEASURE_MODES   default forced-ca,window-lid,segment-lid
//   TRAMA_MEASURE_DECODE  a long WebM under /eval-data/ to time the audio decode alone
// Memory is the summed PSS of all Chromium processes (/proc/*/smaps_rollup), sampled every
// 250 ms: browser, renderer, GPU and worker memory, without double-counting shared pages.
// Results go to test-results/measure-*.json and the console.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const MATRIX = (process.env.TRAMA_MEASURE ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const MODES = (process.env.TRAMA_MEASURE_MODES ?? 'forced-ca,window-lid,segment-lid').split(',');

function chromiumPssMB(): number {
  let kb = 0;
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!/chrom(e|ium)/i.test(cmd) || cmd.includes('playwright test')) continue;
      const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
      if (m) kb += Number(m[1]);
    } catch {
      // process ended while we looked
    }
  }
  return Math.round(kb / 1024);
}

async function sampled<T>(fn: () => Promise<T>): Promise<{ value: T; peakMB: number; baseMB: number }> {
  const baseMB = chromiumPssMB();
  let peakMB = baseMB;
  const timer = setInterval(() => (peakMB = Math.max(peakMB, chromiumPssMB())), 250);
  try {
    const value = await fn();
    return { value, peakMB: Math.max(peakMB, chromiumPssMB()), baseMB };
  } finally {
    clearInterval(timer);
  }
}

const results: unknown[] = [];

test.describe('measure', () => {
  test.skip(MATRIX.length === 0 && !process.env.TRAMA_MEASURE_DECODE, 'set TRAMA_MEASURE to run the speed/memory matrix');
  test.describe.configure({ mode: 'serial' });

  test.afterAll(() => {
    mkdirSync('test-results', { recursive: true });
    const file = `test-results/measure-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify(results, null, 1));
    console.log(`wrote ${file}`);
  });

  test('environment: WebGPU and threads in this headless Chromium', async ({ page }) => {
    await page.goto('/eval.html?coi=1');
    const env = await page.evaluate(async () => ({
      ua: navigator.userAgent,
      cores: navigator.hardwareConcurrency,
      isolated: self.crossOriginIsolated,
      webgpu: 'gpu' in navigator ? !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter()) : false,
    }));
    console.log(JSON.stringify(env));
    results.push({ env });
  });

  if (process.env.TRAMA_MEASURE_DECODE) {
    test('decode a long recording’s audio to 16 kHz', async ({ page }) => {
      test.setTimeout(30 * 60_000);
      await page.goto('/eval.html');
      const url = `/eval-data/${process.env.TRAMA_MEASURE_DECODE}`;
      const { value, peakMB, baseMB } = await sampled(() =>
        page.evaluate((u) => (window as unknown as { tramaEval: { decodeUrl(u: string): Promise<{ seconds: number; ms: number; gapS: number }> } }).tramaEval.decodeUrl(u), url),
      );
      const row = { decode: url, audioS: value.seconds, ms: value.ms, gapS: value.gapS, xRealtime: value.seconds / (value.ms / 1000), peakMB, baseMB };
      console.log(JSON.stringify(row));
      results.push(row);
    });
  }

  for (const entry of MATRIX) {
    const [model, dtype, flag] = entry.split(':');
    test(`${model} ${dtype}${flag ? ` ${flag}` : ''} on WASM`, async ({ page }) => {
      test.setTimeout(60 * 60_000);
      await page.goto(flag === 'coi' ? '/eval.html?coi=1' : '/eval.html');
      const audio = process.env.TRAMA_MEASURE_AUDIO;
      const h = await page.evaluateHandle(() => (window as unknown as { tramaEval: Record<string, (...a: unknown[]) => Promise<unknown>> }).tramaEval);
      if (audio) await h.evaluate((a, u) => a.decodeUrl(u), `/eval-data/${audio}`);
      else await page.setInputFiles('#audio', new URL('../fixtures/speech-ca-es.webm', import.meta.url).pathname);
      page.on('console', (m) => m.type() === 'error' && console.log(`console: ${m.text()}`));
      page.on('pageerror', (e) => console.log(`pageerror: ${e.message}`));
      await expect(page.locator('#estat-audio')).toContainText(/16 kHz|Error/, { timeout: 120_000 });
      await expect(page.locator('#estat-audio')).toContainText('16 kHz');
      const ref = process.env.TRAMA_MEASURE_REF
        ? await page.evaluate(async (u) => (await fetch(u)).text(), `/eval-data/${process.env.TRAMA_MEASURE_REF}`)
        : audio
          ? null
          : readFileSync(new URL('../fixtures/speech-ca-es.txt', import.meta.url), 'utf8');
      if (ref) await h.evaluate((a, r) => a.setReference(r), ref);

      const load = await sampled(() => h.evaluate((a, o) => a.load(o), { model, dtype, device: 'wasm' }));
      for (const mode of MODES) {
        const { value, peakMB } = await sampled(() => h.evaluate((a, m) => a.run(m), mode));
        const r = value as {
          result: { segments: { lang: string; text: string; start: number; end: number }[]; stats: Record<string, number> };
          score: { overall: { wer: number }; byLang: Record<string, { wer: number; words: number }>; tagAccuracy: number } | null;
          textScore: { tagAccuracy: number } | null;
        };
        const row = {
          model,
          dtype,
          coi: flag === 'coi',
          load: load.value,
          loadPeakMB: load.peakMB,
          mode,
          peakMB,
          stats: r.result.stats,
          wer: r.score?.overall.wer,
          werCa: r.score?.byLang.ca.wer,
          werEs: r.score?.byLang.es.wer,
          tagModel: r.score?.tagAccuracy,
          tagText: r.textScore?.tagAccuracy,
          segments: r.result.segments,
        };
        results.push(row);
        const pct = (x?: number) => (x === undefined ? '–' : `${(x * 100).toFixed(0)}%`);
        console.log(
          `${model.split('/').pop()} ${dtype}${flag ? ' coi' : ''} ${mode}: RTF ${r.result.stats.rtf.toFixed(2)} ` +
            `(enc ${(r.result.stats.encodeMs / 1000).toFixed(0)} s, dec ${(r.result.stats.decodeMs / 1000).toFixed(0)} s, lid ${(r.result.stats.lidMs / 1000).toFixed(0)} s, fallbacks ${r.result.stats.fallbacks}), ` +
            `peak ${peakMB} MB, WER ${pct(row.wer)} ca ${pct(row.werCa)} es ${pct(row.werEs)}, tags ${pct(row.tagModel)}/${pct(row.tagText)}`,
        );
        for (const s of r.result.segments) console.log(`   ${s.start.toFixed(1).padStart(6)} [${s.lang}] ${s.text}`);
      }
    });
  }
});
