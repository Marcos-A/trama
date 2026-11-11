import { defineConfig } from 'vite';

// Same policy as deploy/security-headers.conf, so that `vite preview` and the browser tests run
// under the real CSP and Permissions-Policy.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Permissions-Policy': 'display-capture=(self), camera=(), microphone=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
  preview: { headers: SECURITY_HEADERS },
});
