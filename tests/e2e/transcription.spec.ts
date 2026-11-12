// Transcription spike harness in headless Chromium (eval build, served with the production
// CSP on the page and 'wasm-unsafe-eval' on the transcription worker only). Model tests use
// the ONNX files mounted by scripts/test.sh and are skipped without them.

import { readFileSync } from 'node:fs';
import { test as base, expect, type Page } from '@playwright/test';

const fixturePath = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname;

export const test = base.extend<{ evalPage: Page }>({
  evalPage: async ({ context, baseURL }, use) => {
    const problems: string[] = [];
    const origin = new URL(baseURL!).origin;
    context.on('request', (r) => {
      const url = r.url();
      if (!url.startsWith(origin) && !url.startsWith('blob:') && !url.startsWith('data:')) problems.push(`request: ${url}`);
    });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to/.test(m.text())) problems.push(`csp: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto('/eval.html');
    await use(page);
    expect(problems, 'CSP violations, page errors or requests to other origins').toEqual([]);
  },
});

type Api = {
  decodeUrl(url: string): Promise<{ seconds: number; gapS: number; inputRate: number; peak: number[] }>;
  setReference(text: string): void;
  load(o: { model: string; dtype: string; device: string }): Promise<{ ms: number; threads: number }>;
  run(mode: string): Promise<{
    result: { raw: string[]; segments: { start: number; end: number; lang: string; p?: number; text: string }[]; stats: { totalMs: number; rtf: number; windows: number; fallbacks: number } };
    score: { overall: { wer: number; words: number }; byLang: Record<string, { words: number; wer: number }>; tagAccuracy: number } | null;
    textScore: { tagAccuracy: number } | null;
  }>;
};
const api = (page: Page) => page.evaluateHandle(() => (window as unknown as { tramaEval: Api }).tramaEval);

async function models(page: Page): Promise<{ id: string; dtypes: string[] }[]> {
  return page.evaluate(async () => (await fetch('/models/index.json')).json());
}

test('the page keeps the production CSP; only the transcription worker may compile WebAssembly', async ({ evalPage: page, request }) => {
  const pageCsp = (await request.get('/eval.html')).headers()['content-security-policy'];
  expect(pageCsp).toContain("connect-src 'self'");
  expect(pageCsp).not.toContain('wasm-unsafe-eval');
  const workerUrl = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('transcribe.worker')),
  );
  expect(workerUrl).toBeTruthy();
  const workerCsp = (await request.get(workerUrl!)).headers()['content-security-policy'];
  expect(workerCsp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(workerCsp).toContain("connect-src 'self'");
});

test('decodes a recording’s audio track to 16 kHz mono (picked as a file)', async ({ evalPage: page }) => {
  await page.setInputFiles('#audio', fixturePath('chromium-158-vp9-opus-7s.webm'));
  await expect(page.locator('#estat-audio')).toContainText('d’àudio a 16 kHz');
  const r = await page.evaluate(() => (window as unknown as { tramaEval: { report(): { audio: { seconds: number; decode: { inputRate: number } } } } }).tramaEval.report());
  expect(r.audio.seconds).toBeGreaterThan(6.5);
  expect(r.audio.seconds).toBeLessThan(7.5);
  expect(r.audio.decode.inputRate).toBe(48000);
});

test('decodes the synthetic speech fixture with sound throughout', async ({ evalPage: page }) => {
  await page.setInputFiles('#audio', fixturePath('speech-ca-es.webm'));
  await expect(page.locator('#estat-audio')).toContainText('d’àudio a 16 kHz');
  const r = await page.evaluate(() => (window as unknown as { tramaEval: { report(): { audio: { seconds: number } } } }).tramaEval.report());
  expect(r.audio.seconds).toBeCloseTo(30.77, 0);
});

test('transcribes mixed Catalan/Spanish speech with whisper-base on WASM, detecting the language per window', async ({ evalPage: page }) => {
  test.setTimeout(4 * 60_000);
  const model = 'onnx-community/whisper-base';
  test.skip(!(await models(page)).some((m) => m.id === model && m.dtypes.includes('q8')), `${model} q8 not in the models dir`);

  await page.setInputFiles('#audio', fixturePath('speech-ca-es.webm'));
  await expect(page.locator('#estat-audio')).toContainText('d’àudio a 16 kHz');
  const reference = readFileSync(fixturePath('speech-ca-es.txt'), 'utf8');
  const h = await api(page);
  await h.evaluate((a, ref) => a.setReference(ref), reference);
  const loaded = await h.evaluate((a, m) => a.load({ model: m, dtype: 'q8', device: 'wasm' }), model);
  expect(loaded.threads).toBe(1); // not cross-origin isolated

  // One mode keeps the default suite short; tests/e2e/transcription-measure.spec.ts runs them all.
  for (const mode of ['window-lid']) {
    const row = await h.evaluate((a, m) => a.run(m), mode);
    const segs = row.result.segments;
    console.log(
      `${mode}: ${segs.length} segments, WER ${(row.score!.overall.wer * 100).toFixed(0)} % ` +
        `(ca ${(row.score!.byLang.ca.wer * 100).toFixed(0)}, es ${(row.score!.byLang.es.wer * 100).toFixed(0)}), ` +
        `tags model ${(row.score!.tagAccuracy * 100).toFixed(0)} % / text ${(row.textScore!.tagAccuracy * 100).toFixed(0)} %, ` +
        `${(row.result.stats.totalMs / 1000).toFixed(1)} s, RTF ${row.result.stats.rtf.toFixed(2)}, fallbacks ${row.result.stats.fallbacks}`,
    );
    // whisper-base cannot follow robotic TTS: it loops, and the temperature fallback samples at
    // random, so its text varies run to run (small and turbo do follow it, see
    // docs/transcription-spike.md §4). This checks the plumbing, which holds for any output:
    // the whole 30.8 s was walked (the trailing 0.8 s is digital silence, skipped without
    // decoding), segments lie inside the audio with sane times and a ca/es label, and the
    // score was computed.
    expect(row.result.stats.windows, row.result.raw.join('\n')).toBe(2);
    expect(row.result.raw.length).toBeGreaterThanOrEqual(1);
    for (const s of segs) {
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeGreaterThanOrEqual(s.start);
      expect(s.end).toBeLessThan(31.5);
      expect(['ca', 'es']).toContain(s.lang);
    }
    expect(row.score!.overall.words).toBe(64);
  }
  await expect(page.locator('#resultats tbody tr')).toHaveCount(1);
});
