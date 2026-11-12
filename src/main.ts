import './tokens.css';
import './style.css';
import { log, logAsBlob, onLog, storageMB } from './spike/log.ts';
import { deleteRecording, exportRecording, getRecording, leftoverRecordings } from './spike/opfs.ts';
import { Recording, requestTabStream, type StopReason, type TrackEvent } from './spike/recorder.ts';

// ---------------------------------------------------------------- elements

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const app = el('app');
const vistaInici = el('vista-inici');
const vistaGravant = el('vista-gravant');
const vistaDesat = el('vista-desat');
const btnGrava = el<HTMLButtonElement>('grava');
const btnAtura = el<HTMLButtonElement>('atura');
const btnDesa = el<HTMLButtonElement>('desa');
const btnEsborra = el<HTMLButtonElement>('esborra');
const btnNova = el<HTMLButtonElement>('nova');
const cronometre = el('cronometre');
const estatSo = el('estat-so');
const mida = el('mida');
const reproductor = el<HTMLVideoElement>('reproductor');
const inputNom = el<HTMLInputElement>('nom');
const missatge = el('missatge');
const avisEspai = el('avis-espai');
const anunci = el('estat-anunci');
const pendents = el('pendents');
const llistaPendents = el('llista-pendents');
const registre = el('registre');
const favicon = el<HTMLLinkElement>('favicon');

// ---------------------------------------------------------------- state

type State = 'idle' | 'requesting' | 'recording' | 'stopping' | 'saved' | 'error';

let recording: Recording | null = null;
let current: { name: string; file: File } | null = null;
let playerUrl: string | null = null;

// `?quota=<MB>` simulates running out of space (checklist item 7) without filling the disk.
const quotaParam = new URLSearchParams(location.search).get('quota');
const quotaLimitBytes = quotaParam ? Number(quotaParam) * 1e6 : undefined;

function setState(s: State): void {
  app.dataset.state = s;
  vistaInici.hidden = !(s === 'idle' || s === 'requesting' || s === 'error');
  vistaGravant.hidden = !(s === 'recording' || s === 'stopping');
  vistaDesat.hidden = s !== 'saved';
  btnGrava.disabled = s === 'requesting';
  btnAtura.disabled = s === 'stopping';
  btnAtura.textContent = s === 'stopping' ? 'Aturant…' : 'Atura';
  if (s !== 'recording' && s !== 'stopping') setRecordingTab(false);
  log('state', s);
}

function announce(text: string): void {
  anunci.textContent = text;
}

function showMessage(text: string): void {
  missatge.textContent = text;
  missatge.hidden = false;
  announce(text);
}

function hideMessage(): void {
  missatge.hidden = true;
}

function setRecordingTab(on: boolean, elapsed = ''): void {
  favicon.href = on ? '/icons/favicon-recording.svg' : '/icons/favicon.svg';
  document.title = on ? `● ${elapsed} · Trama` : 'Trama';
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

// ---------------------------------------------------------------- stopwatch
// Derived from timestamps, so background timer throttling only delays the display.

let clockTimer = 0;
let lastTitleSecond = -1;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

function startClock(startedAt: number): void {
  lastTitleSecond = -1;
  const tick = () => {
    const ms = Date.now() - startedAt;
    const text = formatElapsed(ms);
    cronometre.textContent = text;
    const sec = Math.floor(ms / 1000);
    if (sec !== lastTitleSecond) {
      lastTitleSecond = sec;
      setRecordingTab(true, text);
    }
  };
  tick();
  clockTimer = window.setInterval(tick, 500);
}

function stopClock(): void {
  clearInterval(clockTimer);
}

// ---------------------------------------------------------------- audio level
// Shows that tab audio is actually arriving. The analyser is not connected to the speakers,
// so it never doubles the meeting audio.

let audioCtx: AudioContext | null = null;
let meterTimer = 0;
let audioState: 'ok' | 'none' | 'muted' | 'ended' = 'none';

function renderAudioState(level = 0): void {
  const labels = { ok: 'Amb so', none: 'Sense so', muted: 'Sense so: la pestanya no envia àudio', ended: "Sense so: l'àudio s'ha tallat" };
  estatSo.dataset.so = audioState;
  estatSo.textContent = labels[audioState];
  estatSo.style.setProperty('--nivell', audioState === 'ok' ? String(Math.min(1, level * 4)) : '0');
}

function startMeter(stream: MediaStream): void {
  const track = stream.getAudioTracks()[0];
  if (!track || !audioCtx) return;
  void audioCtx.resume();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let silentSince = 0;
  let silenceLogged = false;
  meterTimer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    renderAudioState(rms);
    const now = Date.now();
    if (rms < 0.001) {
      silentSince ||= now;
      if (!silenceLogged && now - silentSince > 15_000) {
        silenceLogged = true;
        log('audio-silence-start', { since: new Date(silentSince).toISOString() });
      }
    } else {
      if (silenceLogged) log('audio-silence-end', { seconds: Math.round((now - silentSince) / 1000) });
      silentSince = 0;
      silenceLogged = false;
    }
  }, 250);
}

function stopMeter(): void {
  clearInterval(meterTimer);
  void audioCtx?.close();
  audioCtx = null;
}

// ---------------------------------------------------------------- recording

const stopMessages: Record<StopReason, string> = {
  user: '',
  'share-ended': "Has deixat de compartir la pestanya. La gravació s'ha aturat i està desada fins aquí.",
  quota: "S'ha acabat l'espai del navegador. La gravació s'ha aturat i està desada fins aquí.",
  'write-error': "No s'ha pogut continuar escrivint la gravació. Està desada fins on s'ha pogut.",
  'recorder-error': "El navegador ha aturat la gravació per un error. Està desada fins aquí.",
};

btnGrava.addEventListener('click', async () => {
  hideMessage();
  setState('requesting');
  // Created inside the click: after the picker the user gesture may have expired.
  audioCtx = new AudioContext();

  let stream: MediaStream;
  try {
    stream = await requestTabStream();
  } catch (err) {
    const e = err as DOMException;
    log('picker-failed', { name: e.name, message: e.message });
    stopMeter();
    setState('idle');
    showMessage(
      e.name === 'NotAllowedError'
        ? "No s'ha començat a gravar: has tancat el selector o no has donat permís."
        : `No s'ha pogut començar a gravar (${e.name}).`,
    );
    return;
  }

  const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
  const rec = new Recording(
    stream,
    {
      onProgress: (total) => (mida.textContent = `${mb(total)} desats al navegador`),
      onTrack: (ev: TrackEvent) => {
        if (ev === 'audio-ended') {
          audioState = 'ended';
          showMessage("L'àudio de la pestanya s'ha tallat. La gravació continua només amb imatge.");
        } else if (ev === 'audio-muted') audioState = 'muted';
        else if (ev === 'audio-unmuted') audioState = 'ok';
        renderAudioState();
      },
      onLowSpace: (free) => showMessage(`Queda poc espai per a la gravació (${free} MB). Atura-la aviat.`),
      onStopped: (reason, total) => void onStopped(rec, reason, total),
    },
    quotaLimitBytes,
  );

  try {
    await rec.start();
  } catch (err) {
    const e = err as DOMException;
    log('start-failed', { name: e.name, message: e.message });
    for (const t of stream.getTracks()) t.stop();
    stopMeter();
    setState('error');
    showMessage(`No s'ha pogut preparar el fitxer al navegador (${e.name}: ${e.message}).`);
    return;
  }

  recording = rec;
  audioState = rec.hasAudio ? 'ok' : 'none';
  renderAudioState();
  mida.textContent = '';
  setState('recording');
  startClock(rec.startedAt);
  startMeter(stream);
  announce('Gravació iniciada.');

  if (!rec.hasAudio) {
    showMessage(
      "Sense so. S'està gravant només la imatge. Si vols el so, atura i torna a començar deixant marcada l'opció per compartir l'àudio de la pestanya.",
    );
  } else if (surface && surface !== 'browser') {
    showMessage("Has triat una finestra o una pantalla, no una pestanya. És possible que el so de l'aplicació no es gravi.");
  }
  if (surface !== 'browser') log('non-tab-surface', { surface });
});

btnAtura.addEventListener('click', () => {
  setState('stopping');
  recording?.stop('user');
});

async function onStopped(rec: Recording, reason: StopReason, total: number): Promise<void> {
  stopClock();
  stopMeter();
  recording = null;
  announce('Gravació aturada.');
  if (total === 0) {
    await deleteRecording(rec.name).catch(() => {});
    setState('idle');
    showMessage("No s'ha gravat res.");
    return;
  }
  await showRecording(rec.name);
  if (stopMessages[reason]) showMessage(stopMessages[reason]);
  else hideMessage();
}

// ---------------------------------------------------------------- review and export

function clearPlayer(): void {
  reproductor.removeAttribute('src');
  reproductor.load();
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  playerUrl = null;
}

async function showRecording(name: string): Promise<void> {
  clearPlayer();
  const file = await getRecording(name);
  current = { name, file };
  playerUrl = URL.createObjectURL(file);
  reproductor.src = playerUrl;
  inputNom.value = name;
  setState('saved');
  await refreshLeftovers();
}

reproductor.addEventListener('loadedmetadata', () =>
  log('player-metadata', {
    duration: reproductor.duration, // Infinity until the WebM is repaired (step 3)
    width: reproductor.videoWidth,
    height: reproductor.videoHeight,
  }),
);
reproductor.addEventListener('error', () => log('player-error', { code: reproductor.error?.code, message: reproductor.error?.message }));

function exportName(): string {
  const base = inputNom.value.trim().replace(/[\\/:*?"<>|]+/g, '-') || current?.name || 'trama.webm';
  return base.toLowerCase().endsWith('.webm') ? base : `${base}.webm`;
}

btnDesa.addEventListener('click', async () => {
  if (!current) return;
  const name = exportName();
  const t0 = performance.now();
  try {
    const result = await exportRecording(current.file, name);
    log('export', { result, name, size: current.file.size, ms: Math.round(performance.now() - t0) });
    if (result === 'saved') showMessage("Vídeo desat. Ja pots esborrar la còpia del navegador.");
    else if (result === 'downloaded')
      showMessage("S'ha baixat el vídeo. Comprova que és a la carpeta de baixades abans d'esborrar la còpia del navegador.");
  } catch (err) {
    const e = err as DOMException;
    log('export-failed', { name: e.name, message: e.message });
    showMessage(`No s'ha pogut desar el vídeo (${e.name}). La còpia del navegador es manté.`);
  }
});

btnEsborra.addEventListener('click', async () => {
  if (!current) return;
  if (!confirm("Vols esborrar la còpia del navegador? Si no has desat el vídeo, es perdrà.")) return;
  const { name } = current;
  clearPlayer();
  current = null;
  await deleteRecording(name);
  log('deleted', { name });
  hideMessage();
  setState('idle');
  await refreshLeftovers();
});

btnNova.addEventListener('click', async () => {
  clearPlayer();
  current = null;
  hideMessage();
  setState('idle');
  await refreshLeftovers(); // the one just recorded stays listed until it is deleted
});

// ---------------------------------------------------------------- leftovers (recovery)

async function refreshLeftovers(initial = false): Promise<void> {
  const files = (await leftoverRecordings()).filter((f) => f.name !== current?.name);
  if (initial) log('leftovers', files.map((f) => ({ name: f.name, size: f.size, modified: new Date(f.lastModified).toISOString() })));
  llistaPendents.replaceChildren(
    ...files.map((f) => {
      const li = document.createElement('li');
      const info = document.createElement('span');
      info.textContent = `${f.name} · ${mb(f.size)}`;
      const recupera = document.createElement('button');
      recupera.type = 'button';
      recupera.className = 'boto-secundari';
      recupera.textContent = 'Recupera';
      recupera.disabled = recording !== null;
      recupera.addEventListener('click', () => {
        hideMessage();
        log('recover', { name: f.name, size: f.size });
        void showRecording(f.name);
      });
      const esborra = document.createElement('button');
      esborra.type = 'button';
      esborra.className = 'boto-secundari';
      esborra.textContent = 'Esborra';
      esborra.addEventListener('click', async () => {
        if (!confirm(`Vols esborrar ${f.name}? No es podrà recuperar.`)) return;
        await deleteRecording(f.name);
        log('deleted', { name: f.name });
        await refreshLeftovers();
      });
      li.append(info, recupera, esborra);
      return li;
    }),
  );
  pendents.hidden = files.length === 0;
}

// ---------------------------------------------------------------- page lifecycle and log

document.addEventListener('visibilitychange', () => log('visibility', document.visibilityState));
window.addEventListener('pagehide', () => log('pagehide'));
window.addEventListener('beforeunload', (e) => {
  if (recording) e.preventDefault(); // asks before closing or reloading mid-recording
});

const MAX_LOG_LINES = 300;
onLog((e) => {
  registre.textContent += `${e.at.slice(11, 19)} ${e.ev}${e.data === undefined ? '' : ' ' + JSON.stringify(e.data)}\n`;
  const lines = registre.textContent!.split('\n');
  if (lines.length > MAX_LOG_LINES) registre.textContent = lines.slice(-MAX_LOG_LINES).join('\n');
});

el('baixa-registre').addEventListener('click', () => {
  const url = URL.createObjectURL(logAsBlob());
  const a = document.createElement('a');
  a.href = url;
  a.download = `trama-registre-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

// ---------------------------------------------------------------- start-up

interface BuildInfo {
  environment: string;
  build: { shortSha: string };
  release: { version: string } | null;
}

// Shows which build is deployed, so both URLs can be checked after a deploy.
async function showBuild(): Promise<void> {
  const footer = document.getElementById('build');
  if (!footer) return;
  try {
    const res = await fetch('/build-info.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const info = (await res.json()) as BuildInfo;
    const version = info.release ? `v${info.release.version} · ` : '';
    footer.textContent = `${version}${info.build.shortSha} · ${info.environment}`;
  } catch {
    // No build info in dev; nothing to show.
  }
}

async function init(): Promise<void> {
  log('page-loaded', { url: location.pathname + location.search, simulatedQuotaMB: quotaParam ?? undefined });
  setState('idle');
  const unsupported = [
    !navigator.mediaDevices?.getDisplayMedia && 'getDisplayMedia',
    typeof MediaRecorder === 'undefined' && 'MediaRecorder',
    !navigator.storage?.getDirectory && 'OPFS',
    !navigator.locks && 'Web Locks',
  ].filter(Boolean);
  if (unsupported.length) {
    log('unsupported', unsupported);
    btnGrava.disabled = true;
    showMessage(`Aquest navegador no pot gravar pestanyes (falta: ${unsupported.join(', ')}). Fes servir Chrome o Edge d'escriptori.`);
    return;
  }
  const storage = await storageMB();
  log('storage', storage);
  if (storage && storage.free < 3000) {
    avisEspai.textContent = `Hi ha ${storage.free} MB lliures per a gravacions. Una reunió de 2 hores pot ocupar entre 1 i 3 GB.`;
    avisEspai.hidden = false;
  }
  await refreshLeftovers(true);
}

void showBuild();
void init();
