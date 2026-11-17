import { defineConfig } from '@playwright/test';
import { MEETING_TITLE } from './tests/helpers/meeting-tab.ts';

// Headless Chromium for everything (capture matters in Chrome/Edge); Firefox and WebKit only
// for tests/other-browsers, which checks that they are turned away. tests/soak runs only with
// SOAK_MINUTES set. Run through scripts/test.sh, which
// uses the Playwright Docker image pinned to the same version as @playwright/test.
// The app is served by `vite preview`, which sends the production CSP and Permissions-Policy.
//
// On macOS (.github/workflows/mac.yml), MAC_BROWSERS=chrome,msedge replaces all of that with the
// browser tests in the installed Chrome and Edge, where MP4 audio is AAC from the platform
// encoder, plus the soak test when SOAK_MINUTES is set.

const PORT = 4173;

const chromium = {
  browserName: 'chromium' as const,
  baseURL: `http://127.0.0.1:${PORT}`,
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  acceptDownloads: true,
};

// Chrome's real tab capture of a meeting tab (tests/capture), headed (under Xvfb on the server:
// headless Chromium captures the tab's picture but not its sound), the picker answered by a
// command-line switch. These projects start the browser themselves, as a user would have it, and
// attach to it (tests/helpers/real-browser.ts); only `args` and `channel` are used.
const realCapture = {
  ...chromium,
  headless: false,
  launchOptions: {
    args: [
      ...chromium.launchOptions.args,
      `--auto-select-tab-capture-source-by-title=${MEETING_TITLE}`,
      // The meeting tab's WebRTC call runs over loopback, which Chrome otherwise leaves out.
      '--allow-loopback-in-peer-connection',
    ],
  },
};

const soak = !!Number(process.env.SOAK_MINUTES);
// SOAK_CAPTURE=real: the soak records the meeting tab through real tab capture, with both tabs
// hidden for most of it (check 3 at length).
const soakReal = process.env.SOAK_CAPTURE === 'real';
const macBrowsers = (process.env.MAC_BROWSERS ?? '').split(',').map((b) => b.trim()).filter(Boolean);

const serverProjects = [
  { name: 'unit', testMatch: 'unit/**/*.spec.ts' },
  { name: 'chromium', testMatch: 'e2e/**/*.spec.ts', use: chromium },
  { name: 'capture', testMatch: 'capture/**/*.spec.ts', use: realCapture },
  ...(['firefox', 'webkit'] as const).map((browserName) => ({
    name: browserName,
    testMatch: 'other-browsers/**/*.spec.ts',
    use: { browserName, baseURL: `http://127.0.0.1:${PORT}` },
  })),
  // Long synthetic recording; only with SOAK_MINUTES set (see tests/soak/soak.spec.ts).
  ...(soak ? [{ name: 'soak', testMatch: 'soak/**/*.spec.ts', use: soakReal ? realCapture : chromium }] : []),
];

// The CI VM's hardware video encoder and decoder fail now and then (EncodingError); a retry is
// reported as flaky, not hidden.
const macProjects = macBrowsers.flatMap((channel) => [
  {
    name: `mac-${channel}`,
    testMatch: soak && !soakReal ? ['e2e/**/*.spec.ts', 'soak/**/*.spec.ts'] : 'e2e/**/*.spec.ts',
    use: { ...chromium, channel },
    retries: 1,
  },
  {
    name: `mac-${channel}-capture`,
    testMatch: soak && soakReal ? ['capture/**/*.spec.ts', 'soak/**/*.spec.ts'] : 'capture/**/*.spec.ts',
    use: { ...realCapture, channel },
    retries: 1,
  },
]);

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 2, // the server is shared with other projects; keep the load modest (on macOS, one per browser)
  reporter: [['list']],
  forbidOnly: !!process.env.CI,
  projects: macProjects.length ? macProjects : serverProjects,
  webServer: {
    command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
