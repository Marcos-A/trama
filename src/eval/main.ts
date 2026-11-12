// Transcription spike harness: decode a recording's audio in the browser, run Whisper in a
// worker, score against a reference transcript. Also driven by Playwright through
// `window.tramaEval` (tests/e2e/transcription.spec.ts).

import '../tokens.css';
import '../style.css';
import './eval.css';
import { hypothesisWords, parseReference, score, type Score } from '../transcription/score.ts';
import type { Reply, Request } from '../transcription/transcribe.worker.ts';
import type { Device, LoadOptions, Mode, RunResult } from '../transcription/whisper.ts';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const inAudio = el<HTMLInputElement>('audio');
const inRef = el<HTMLInputElement>('referencia');
const selModel = el<HTMLSelectElement>('model');
const selDtype = el<HTMLSelectElement>('dtype');
const selDevice = el<HTMLSelectElement>('dispositiu');
const btnLoad = el<HTMLButtonElement>('carrega');
const btnRun = el<HTMLButtonElement>('executa');
const btnSave = el<HTMLButtonElement>('desa');
const progress = el<HTMLProgressElement>('progres');
const tbody = el('resultats').querySelector('tbody')!;

interface ModelEntry {
  id: string;
  dtypes: string[];
}

interface Row {
  model: LoadOptions;
  result: RunResult;
  score: Score | null;
  textScore: Score | null;
}

const state = {
  audioS: 0,
  audioName: '',
  reference: '',
  loaded: null as (LoadOptions & { ms: number; isolated: boolean; threads: number }) | null,
  rows: [] as Row[],
  decode: null as Extract<Reply, { type: 'decoded' }> | null,
};

// ---------------------------------------------------------------- worker RPC

const worker = new Worker(new URL('../transcription/transcribe.worker.ts', import.meta.url), { type: 'module' });
let pending: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
worker.onmessage = (ev: MessageEvent<Reply>) => {
  const r = ev.data;
  if (r.type === 'progress') {
    progress.hidden = false;
    progress.value = r.fraction;
    return;
  }
  const p = pending;
  pending = null;
  progress.hidden = true;
  if (!p) return;
  if (r.type === 'error') p.reject(new Error(r.message));
  else p.resolve(r);
};
worker.onerror = (e) => {
  pending?.reject(new Error(e.message || 'worker error'));
  pending = null;
};

function call<T extends Reply['type']>(req: Request, transfer: Transferable[] = []): Promise<Extract<Reply, { type: T }>> {
  if (pending) return Promise.reject(new Error('busy'));
  return new Promise((resolve, reject) => {
    pending = { resolve: resolve as (r: Reply) => void, reject };
    worker.postMessage(req, transfer);
  });
}

// ---------------------------------------------------------------- steps

const say = (id: string, text: string) => {
  el(id).textContent = text;
  el('anunci').textContent = text;
};

async function isWebm(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
}

/** Non-WebM excerpts (WAV, MP3, M4A…): the browser decodes and resamples to 16 kHz. */
async function decodeOther(file: Blob): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

async function setAudio(file: Blob, name: string) {
  say('estat-audio', 'Descodificant l’àudio…');
  let r: Extract<Reply, { type: 'decoded' }>;
  if (await isWebm(file)) r = await call<'decoded'>({ type: 'decode', file });
  else {
    const audio = await decodeOther(file);
    r = await call<'decoded'>({ type: 'audio', audio }, [audio.buffer]);
  }
  state.audioS = r.seconds;
  state.audioName = name;
  state.decode = r;
  say('estat-audio', `${fmt(r.seconds)} d’àudio a 16 kHz${r.ms ? `, descodificat en ${(r.ms / 1000).toFixed(1)} s` : ''}${r.gapS > 0.05 ? `, ${r.gapS.toFixed(1)} s de buits omplerts amb silenci` : ''}.`);
  ready();
  return r;
}

async function load(opts: LoadOptions) {
  say('estat-model', `Carregant ${opts.model} (${opts.dtype}, ${opts.device})…`);
  const r = await call<'loaded'>({ type: 'load', opts });
  state.loaded = { ...opts, ms: r.ms, isolated: r.isolated, threads: r.threads };
  say('estat-model', `Model carregat en ${(r.ms / 1000).toFixed(1)} s · ${opts.device === 'wasm' ? `${r.threads} fil(s) WASM` : 'WebGPU'}${r.isolated ? ' · aïllament d’origen actiu' : ''}.`);
  ready();
  return r;
}

async function run(mode: Mode): Promise<Row> {
  if (!state.loaded) throw new Error('no model');
  say('estat-execucio', `Transcrivint (${mode})…`);
  const { result } = await call<'result'>({ type: 'run', mode });
  const ref = state.reference ? parseReference(state.reference) : null;
  const row: Row = {
    model: { model: state.loaded.model, dtype: state.loaded.dtype, device: state.loaded.device },
    result,
    score: ref ? score(ref, hypothesisWords(result.segments)) : null,
    textScore: ref ? score(ref, hypothesisWords(result.textSpans)) : null,
  };
  state.rows.push(row);
  render(row);
  say('estat-execucio', `Fet: ${mode}, ${(result.stats.totalMs / 1000).toFixed(1)} s.`);
  btnSave.disabled = false;
  return row;
}

// ---------------------------------------------------------------- UI

const pct = (x: number | undefined) => (x === undefined ? '–' : `${(x * 100).toFixed(1)} %`);
function fmt(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

function render(row: Row) {
  const tr = document.createElement('tr');
  const s = row.score;
  const cells = [
    `${row.model.model.split('/').pop()} ${row.model.dtype} ${row.model.device}`,
    row.result.mode,
    pct(s?.overall.wer),
    pct(s?.byLang.ca.words ? s.byLang.ca.wer : undefined),
    pct(s?.byLang.es.words ? s.byLang.es.wer : undefined),
    pct(s?.tagAccuracy),
    pct(row.textScore?.tagAccuracy),
    `${(row.result.stats.totalMs / 1000).toFixed(1)} s`,
    row.result.stats.rtf.toFixed(2),
  ];
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = c;
    tr.append(td);
  }
  tbody.append(tr);
  el('segments').textContent = row.result.segments
    .map((x) => `${x.start.toFixed(2).padStart(8)} ${x.end.toFixed(2).padStart(8)}  [${x.lang}${x.p ? ` ${x.p.toFixed(2)}` : ''}]  ${x.text}`)
    .join('\n');
}

function ready() {
  btnRun.disabled = !(state.audioS > 0 && state.loaded) || !!pending;
}

function fillDtypes(models: ModelEntry[]) {
  const m = models.find((x) => x.id === selModel.value);
  selDtype.replaceChildren(...(m?.dtypes ?? []).map((d) => new Option(d, d)));
  // WebGPU wants fp16 weights, WASM wants int8.
  const prefer = selDevice.value === 'webgpu' ? ['q4f16', 'fp16', 'q4', 'q8'] : ['q8', 'q4', 'fp32'];
  const pick = prefer.find((d) => m?.dtypes.includes(d));
  if (pick) selDtype.value = pick;
}

async function init() {
  if (!('gpu' in navigator)) selDevice.value = 'wasm';
  let models: ModelEntry[] = [];
  try {
    models = await (await fetch('/models/index.json')).json();
  } catch {
    say('estat-model', 'No hi ha models disponibles a /models/.');
  }
  selModel.replaceChildren(...models.map((m) => new Option(m.id, m.id)));
  fillDtypes(models);
  selModel.onchange = selDevice.onchange = () => fillDtypes(models);

  inAudio.onchange = () => {
    const f = inAudio.files?.[0];
    if (f) setAudio(f, f.name).catch((e) => say('estat-audio', `Error: ${e.message}`));
  };
  inRef.onchange = async () => {
    const f = inRef.files?.[0];
    if (!f) return;
    state.reference = await f.text();
    const words = parseReference(state.reference);
    const n = (l: string) => words.filter((w) => w.lang === l).length;
    say('estat-referencia', `${words.length} paraules: ${n('ca')} en català, ${n('es')} en castellà${n('und') ? `, ${n('und')} sense etiqueta` : ''}.`);
  };
  btnLoad.onclick = () =>
    load({ model: selModel.value, dtype: selDtype.value, device: selDevice.value as Device }).catch((e) => say('estat-model', `Error: ${e.message}`));
  btnRun.onclick = async () => {
    btnRun.disabled = true;
    try {
      for (const box of document.querySelectorAll<HTMLInputElement>('input[name=mode]:checked')) await run(box.value as Mode);
    } catch (e) {
      say('estat-execucio', `Error: ${(e as Error).message}`);
    }
    ready();
  };
  btnSave.onclick = () => {
    const blob = new Blob([JSON.stringify(report(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trama-transcripcio-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
}

function report() {
  return {
    when: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory,
    crossOriginIsolated: self.crossOriginIsolated,
    audio: { name: state.audioName, seconds: state.audioS, decode: state.decode && { ...state.decode, peak: undefined } },
    loaded: state.loaded,
    runs: state.rows,
  };
}

// For Playwright.
(window as unknown as { tramaEval: object }).tramaEval = {
  decodeUrl: async (url: string) => {
    const b = await (await fetch(url)).blob();
    return setAudio(b, url);
  },
  setReference: (text: string) => {
    state.reference = text;
  },
  load,
  run,
  report,
  score: (ref: string, segments: { lang: string; text: string }[]) => score(parseReference(ref), hypothesisWords(segments)),
};

init();
