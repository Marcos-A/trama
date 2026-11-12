// Transcription spike building blocks that run without a browser or a model: WebM audio
// demux, resampling, text language ID and scoring.

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openWebmAudio } from '../../src/media/webm-audio.ts';
import type { RepairSource } from '../../src/media/webm-repair.ts';
import { scoreText, splitByLanguage } from '../../src/transcription/lid.ts';
import { Resampler } from '../../src/transcription/resample.ts';
import { hypothesisWords, normalise, parseReference, score } from '../../src/transcription/score.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const source = (d: Uint8Array): RepairSource => ({ size: d.length, read: async (pos, len) => d.slice(pos, pos + len) });

async function packetsOf(d: Uint8Array) {
  const { track, durationS, packets } = await openWebmAudio(source(d));
  const all = [];
  for await (const p of packets()) all.push(p);
  return { track, durationS, all };
}

test.describe('webm audio demux', () => {
  test('MediaRecorder recording (video + Opus): finds the audio track and every packet', async () => {
    const { track, all } = await packetsOf(fixture('chromium-158-vp9-opus-7s.webm'));
    expect(track).toMatchObject({ codecId: 'A_OPUS', codec: 'opus', sampleRate: 48000 });
    expect(track!.codecPrivate!.subarray(0, 8)).toEqual(new TextEncoder().encode('OpusHead'));
    // Chrome writes 60 ms Opus packets: ~116 over 7 s, in order.
    expect(all.length).toBeGreaterThan(100);
    expect(all.at(-1)!.timeUs / 1e6).toBeGreaterThan(6);
    for (let i = 1; i < all.length; i++) expect(all[i].timeUs).toBeGreaterThanOrEqual(all[i - 1].timeUs);
  });

  test('audio-only WebM with known sizes (ffmpeg) and a Duration', async () => {
    const { track, durationS, all } = await packetsOf(fixture('speech-ca-es.webm'));
    expect(track).toMatchObject({ codec: 'opus', sampleRate: 48000, channels: 2 });
    expect(durationS).toBeCloseTo(30.77, 1);
    expect(all.at(-1)!.timeUs / 1e6).toBeCloseTo(30.75, 0);
  });

  test('a file cut off mid-cluster yields the packets before the cut', async () => {
    const d = fixture('chromium-158-vp9-opus-7s.webm');
    const full = (await packetsOf(d)).all.length;
    const cut = (await packetsOf(d.subarray(0, Math.floor(d.length * 0.6)))).all.length;
    expect(cut).toBeGreaterThan(full * 0.4);
    expect(cut).toBeLessThan(full);
  });
});

test.describe('resampler', () => {
  function tone(rate: number, hz: number, seconds: number): Float32Array {
    const a = new Float32Array(Math.round(rate * seconds));
    for (let i = 0; i < a.length; i++) a[i] = Math.sin((2 * Math.PI * hz * i) / rate);
    return a;
  }
  function run(rate: number, input: Float32Array, chunk = 960): Float32Array {
    const r = new Resampler(rate, 16000);
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length; i += chunk) parts.push(r.push([input.subarray(i, i + chunk)]));
    parts.push(r.flush());
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) out.set(p, at), (at += p.length);
    return out;
  }
  const amplitude = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) * Math.SQRT2;
  const zeroCrossings = (a: Float32Array) => a.reduce((n, x, i) => n + (i > 0 && Math.sign(x) !== Math.sign(a[i - 1]) ? 1 : 0), 0);

  for (const rate of [48000, 44100]) {
    test(`${rate} Hz → 16 kHz keeps length, pitch and level of speech-band audio`, () => {
      const out = run(rate, tone(rate, 1000, 2));
      expect(Math.abs(out.length - 32000)).toBeLessThanOrEqual(2);
      const mid = out.subarray(1000, 31000); // skip filter edges
      expect(zeroCrossings(mid) / 2 / (mid.length / 16000)).toBeCloseTo(1000, -1);
      expect(amplitude(mid)).toBeGreaterThan(0.97);
      expect(amplitude(mid)).toBeLessThan(1.03);
    });
  }

  test('removes content above 8 kHz instead of folding it into speech', () => {
    const out = run(48000, tone(48000, 12000, 1)).subarray(500, 15500);
    expect(amplitude(out)).toBeLessThan(0.01); // > 40 dB down
  });

  test('downmixes stereo and fills gaps with silence', () => {
    const r = new Resampler(48000);
    const l = tone(48000, 500, 0.5);
    const out1 = r.push([l, new Float32Array(l.length)]);
    const out2 = r.pushSilence(48000);
    const out3 = r.flush();
    expect(out1.length + out2.length + out3.length).toBeCloseTo(24000, -1);
    expect(amplitude(out1.subarray(500, 7000))).toBeCloseTo(0.5, 1);
    expect(Math.max(...out3.map(Math.abs))).toBeLessThan(1e-6);
  });
});

test.describe('text language ID', () => {
  test('tells Catalan from Spanish on ordinary meeting sentences', () => {
    const ca = ["D'acord, ho mirem demà amb l'equip.", 'Perquè encara no tenim les dades.', 'Molt bé, gràcies a tots.', 'Jo crec que això és massa car.'];
    const es = ['Vale, lo miramos mañana con el equipo.', 'Porque todavía no tenemos los datos.', 'Muy bien, gracias a todos.', 'Yo creo que eso es demasiado caro.'];
    for (const s of ca) expect(scoreText(s).lang, s).toBe('ca');
    for (const s of es) expect(scoreText(s).lang, s).toBe('es');
  });

  test('says nothing when there is no evidence', () => {
    expect(scoreText('Sí, sí.').lang).toBeNull();
    expect(scoreText('Ok.').lang).toBeNull();
  });

  test('splits a turn that switches language at a clause boundary', () => {
    const spans = splitByLanguage(
      { start: 10, end: 20, text: 'Creo que deberíamos retrasarlo dos semanas, perquè l’equip encara no té tota la informació.' },
      'ca',
    );
    expect(spans.map((s) => s.lang)).toEqual(['es', 'ca']);
    expect(spans[0].start).toBe(10);
    expect(spans[1].end).toBe(20);
    expect(spans[0].end).toBeGreaterThan(13);
    expect(spans[0].end).toBeLessThan(17);
  });

  test('a clause with no evidence joins its neighbours', () => {
    const spans = splitByLanguage({ start: 0, end: 4, text: 'Bé, sí, d’acord, ho farem així.' }, 'es');
    expect(spans).toHaveLength(1);
    expect(spans[0].lang).toBe('ca');
  });
});

test.describe('scoring', () => {
  test('normalises case, punctuation and apostrophes, keeps l·l', () => {
    expect(normalise('D’acord, l’equip; «col·laboració»!  ¿Vale?')).toEqual(["d'acord", "l'equip", 'col·laboració', 'vale']);
    expect(normalise('col.laboració')).toEqual(['col·laboració']);
  });

  test('reads tags inline, in SRT/VTT, and as JSON', () => {
    const txt = parseReference('[ca] Bon dia. [es] Hola [riures] qué tal');
    expect(txt.map((w) => `${w.lang}:${w.w}`)).toEqual(['ca:bon', 'ca:dia', 'es:hola', 'es:qué', 'es:tal']);
    const vtt = parseReference('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n[ca] Bon dia\n\n2\n00:00:02.000 --> 00:00:03.000\n[es] buenos días\n');
    expect(vtt.map((w) => w.lang)).toEqual(['ca', 'ca', 'es', 'es']);
    const json = parseReference('[{"start":0,"end":1,"lang":"es","text":"Hola."},{"lang":"ca","text":"Adéu"}]');
    expect(json).toEqual([{ w: 'hola', lang: 'es' }, { w: 'adéu', lang: 'ca' }]);
  });

  test('perfect transcript: no errors, all tags right', () => {
    const ref = parseReference('[ca] bon dia a tothom [es] buenos días');
    const s = score(ref, hypothesisWords([{ lang: 'ca', text: 'Bon dia a tothom.' }, { lang: 'es', text: 'Buenos días.' }]));
    expect(s.overall.wer).toBe(0);
    expect(s.tagAccuracy).toBe(1);
  });

  test('charges errors to the language of the reference words', () => {
    const ref = parseReference('[ca] avui parlem del pressupost [es] pero antes una cosa');
    // Spanish part "translated" into Catalan: 3 substitutions in es, ca untouched.
    const hyp = hypothesisWords([{ lang: 'ca', text: 'avui parlem del pressupost però abans una cosa' }]);
    const s = score(ref, hyp);
    expect(s.byLang.ca).toMatchObject({ words: 4, sub: 0, del: 0, ins: 0, wer: 0 });
    expect(s.byLang.es).toMatchObject({ words: 4, sub: 2, del: 0, ins: 0 });
    expect(s.byLang.es.wer).toBeCloseTo(0.5);
    // Every Spanish word was tagged ca.
    expect(s.tagAccuracy).toBeCloseTo(4 / 8);
    expect(s.confusion.es.ca).toBe(4);
  });

  test('counts deletions and insertions', () => {
    const ref = parseReference('[ca] un dos tres quatre');
    const s = score(ref, hypothesisWords([{ lang: 'ca', text: 'un tres quatre cinc' }]));
    expect(s.overall).toMatchObject({ words: 4, sub: 0, del: 1, ins: 1 });
    expect(s.overall.wer).toBeCloseTo(0.5);
  });
});
