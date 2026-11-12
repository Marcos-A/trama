import { defineConfig } from '@playwright/test';

// Headless Chromium only (capture matters in Chrome/Edge). Run through scripts/test.sh, which
// uses the Playwright Docker image pinned to the same version as @playwright/test.
// The app is served by `vite preview`, which sends the production CSP and Permissions-Policy.
//
// The transcription spike (tests/e2e/transcription*.spec.ts) gets its own build with the eval
// page (TRAMA_EVAL=1, into dist-eval/) on a second port, so the recorder tests keep running
// against the production build.

const PORT = 4173;
const EVAL_PORT = 4174;
const TRANSCRIPTION = /e2e\/transcription.*\.spec\.ts/;

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 2, // the server is shared with other projects; keep the load modest
  reporter: [['list']],
  forbidOnly: !!process.env.CI,
  projects: [
    { name: 'unit', testMatch: 'unit/**/*.spec.ts' },
    {
      name: 'chromium',
      testMatch: 'e2e/**/*.spec.ts',
      testIgnore: TRANSCRIPTION,
      use: {
        browserName: 'chromium',
        baseURL: `http://127.0.0.1:${PORT}`,
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
        acceptDownloads: true,
      },
    },
    {
      name: 'transcription',
      testMatch: TRANSCRIPTION,
      use: { browserName: 'chromium', baseURL: `http://127.0.0.1:${EVAL_PORT}`, acceptDownloads: true },
    },
  ],
  webServer: [
    {
      command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npx vite build --outDir dist-eval && npx vite preview --outDir dist-eval --host 127.0.0.1 --port ${EVAL_PORT} --strictPort`,
      url: `http://127.0.0.1:${EVAL_PORT}/eval.html`,
      env: { TRAMA_EVAL: '1' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
