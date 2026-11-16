import { defineConfig } from '@playwright/test';

// Headless Chromium for everything (capture matters in Chrome/Edge); Firefox and WebKit only
// for tests/other-browsers, which checks that they are turned away. tests/soak runs only with
// SOAK_MINUTES set. Run through scripts/test.sh, which
// uses the Playwright Docker image pinned to the same version as @playwright/test.
// The app is served by `vite preview`, which sends the production CSP and Permissions-Policy.

const PORT = 4173;

const chromium = {
  browserName: 'chromium' as const,
  baseURL: `http://127.0.0.1:${PORT}`,
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  acceptDownloads: true,
};

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 2, // the server is shared with other projects; keep the load modest
  reporter: [['list']],
  forbidOnly: !!process.env.CI,
  projects: [
    { name: 'unit', testMatch: 'unit/**/*.spec.ts' },
    { name: 'chromium', testMatch: 'e2e/**/*.spec.ts', use: chromium },
    ...(['firefox', 'webkit'] as const).map((browserName) => ({
      name: browserName,
      testMatch: 'other-browsers/**/*.spec.ts',
      use: { browserName, baseURL: `http://127.0.0.1:${PORT}` },
    })),
    // Long synthetic recording; only with SOAK_MINUTES set (see tests/soak/soak.spec.ts).
    ...(process.env.SOAK_MINUTES ? [{ name: 'soak', testMatch: 'soak/**/*.spec.ts', use: chromium }] : []),
  ],
  webServer: {
    command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
