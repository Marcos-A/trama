// The browser as a user runs it, for the real-capture tests (tests/capture, and the soak with
// SOAK_CAPTURE=real): started here rather than by Playwright, with a normal on-disk profile and
// none of Playwright's launch switches (which turn background throttling off), then attached
// over CDP with `noDefaults`, so Playwright leaves its focus emulation off as well. That
// emulation keeps every page "visible" whichever tab is in front, which would hide exactly what
// check 3 is about.

import { chromium, type BrowserContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAC_APPS: Record<string, string> = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  msedge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
};

export async function launchRealBrowser(
  channel: string | undefined,
  args: string[],
): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const exe = channel ? MAC_APPS[channel] : chromium.executablePath();
  if (!exe) throw new Error(`no executable known for channel ${channel}`);
  const profile = mkdtempSync(join(tmpdir(), 'trama-real-'));
  const proc = spawn(
    exe,
    [
      ...args,
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--window-size=1280,800',
      ...(process.platform === 'darwin' ? ['--use-mock-keychain', '--password-store=basic'] : ['--no-sandbox']),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  // Chrome creates the file before it writes the port, so wait for a port number, not the file.
  const readPort = () => (existsSync(portFile) ? readFileSync(portFile, 'utf8').split('\n')[0].trim() : '');
  let port = readPort();
  for (let i = 0; i < 300 && !/^\d+$/.test(port); i++) {
    await new Promise((r) => setTimeout(r, 100));
    port = readPort();
  }
  if (!/^\d+$/.test(port)) throw new Error(`no DevTools port in ${portFile} after 30 s`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  return {
    context: browser.contexts()[0],
    close: async () => {
      await browser.close().catch(() => {});
      proc.kill();
      await new Promise((r) => setTimeout(r, 500));
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
