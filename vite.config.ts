import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';

// Same policy as deploy/security-headers.conf, so that `vite preview` and the browser tests run
// under the real CSP and Permissions-Policy.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Permissions-Policy': 'display-capture=(self), camera=(), microphone=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// ---------------------------------------------------------------- transcription spike (dev only)
//
// TRAMA_EVAL=1 adds eval.html (the transcription harness) to the build and serves model files
// from TRAMA_MODELS_DIR at /models/ (and test audio from TRAMA_EVAL_DATA_DIR at /eval-data/).
// Nothing here reaches the production image: the deploy build runs without TRAMA_EVAL, and
// nginx is unchanged.
//
// ONNX Runtime compiles WebAssembly, which CSP only allows with 'wasm-unsafe-eval'. A dedicated
// worker gets its CSP from its own script response, so the harness grants it to the
// transcription worker (and ORT's thread workers) only; the page keeps the production policy.
// This is the scoping proposed for production in PLAN §7, not applied there yet.
const EVAL = process.env.TRAMA_EVAL === '1';
const MODELS_DIR = process.env.TRAMA_MODELS_DIR ?? '/srv/apps/trama-models';
// Test audio and reference transcripts (meeting excerpts are never committed to the repo).
const DATA_DIR = process.env.TRAMA_EVAL_DATA_DIR ?? '/srv/apps/trama-eval-data';
const WORKER_CSP = CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'");
const isTranscriptionWorker = (url: string) =>
  /\/assets\/(transcribe\.worker|ort-wasm-simd-threaded)[^/]*\.m?js(\?|$)/.test(url) || // build
  /transcribe\.worker\.ts|onnxruntime-web\/dist\/ort-wasm/.test(url); // dev

function listModels(): { id: string; dtypes: string[] }[] {
  const out: { id: string; dtypes: string[] }[] = [];
  if (!existsSync(MODELS_DIR)) return out;
  for (const org of readdirSync(MODELS_DIR)) {
    if (!statSync(join(MODELS_DIR, org)).isDirectory()) continue;
    for (const name of readdirSync(join(MODELS_DIR, org))) {
      const onnx = join(MODELS_DIR, org, name, 'onnx');
      if (!existsSync(onnx)) continue;
      const files = readdirSync(onnx);
      const dtypes = ['fp32', 'fp16', 'q8', 'q4', 'q4f16'].filter((d) => {
        const s = d === 'fp32' ? '' : d === 'q8' ? '_quantized' : `_${d}`;
        return files.includes(`encoder_model${s}.onnx`) && files.includes(`decoder_model_merged${s}.onnx`);
      });
      if (dtypes.length) out.push({ id: `${org}/${name}`, dtypes });
    }
  }
  return out;
}

function evalMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = req.url ?? '/';
  if (isTranscriptionWorker(url)) {
    const set = res.setHeader.bind(res);
    res.setHeader = ((k: string, v: number | string | readonly string[]) =>
      set(k, k.toLowerCase() === 'content-security-policy' ? WORKER_CSP : v)) as typeof res.setHeader;
    set('Content-Security-Policy', WORKER_CSP);
    // So the worker can run inside a cross-origin-isolated page (?coi=1) and be isolated too.
    set('Cross-Origin-Embedder-Policy', 'require-corp');
    set('Cross-Origin-Resource-Policy', 'same-origin');
  }
  // ?coi=1 on the harness: cross-origin isolation, so ORT can use WASM threads.
  if (/^\/eval\.html\?(.*&)?coi=1/.test(url)) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  const prefix = url.startsWith('/models/') ? '/models/' : url.startsWith('/eval-data/') ? '/eval-data/' : null;
  if (!prefix) return next();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const path = decodeURIComponent(url.slice(prefix.length).split('?')[0]);
  if (prefix === '/models/' && path === 'index.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(listModels()));
    return;
  }
  const root = resolve(prefix === '/models/' ? MODELS_DIR : DATA_DIR);
  const file = resolve(root, normalize(path));
  if (!file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  res.setHeader('Content-Length', statSync(file).size);
  res.setHeader('Cache-Control', 'no-cache');
  createReadStream(file).pipe(res);
}

const transcriptionSpike: Plugin = {
  name: 'trama-transcription-spike',
  configureServer: (server) => void server.middlewares.use(evalMiddleware),
  configurePreviewServer: (server) => void server.middlewares.use(evalMiddleware),
};

export default defineConfig({
  plugins: EVAL ? [transcriptionSpike] : [],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: { input: EVAL ? { main: 'index.html', eval: 'eval.html' } : { main: 'index.html' } },
  },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  preview: { headers: SECURITY_HEADERS },
});
