// Shared setup for the browser tests: a synthetic "tab" stream in place of getDisplayMedia, and
// guards that fail any test whose page breaks the CSP, throws, or requests another origin.

import { test as base, expect, type Page } from '@playwright/test';
import { openMeetingTab } from '../helpers/meeting-tab.ts';
import { launchRealBrowser } from '../helpers/real-browser.ts';

export interface CaptureOptions {
  audio?: boolean;
  /** Canvas size; larger makes conversions slow enough to cancel. Default 640×360. */
  width?: number;
  height?: number;
  /**
   * A/V sync markers every `markers` seconds: the frame turns white and the tone jumps from a
   * quiet hum to a loud beep at the same moment, both timed on the audio clock. Off by default.
   */
  markers?: number;
}

/** Runs in the page: canvas video (numbered frames) + oscillator audio. */
function fakeCapture({ audio, width = 640, height = 360, markers }: CaptureOptions): void {
  const MARKER = 0.2; // length of a marker's flash and beep, in seconds
  navigator.mediaDevices.getDisplayMedia = async (options?: DisplayMediaStreamOptions) => {
    (window as unknown as { __displayMediaOptions: unknown }).__displayMediaOptions = options;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const g = c.getContext('2d')!;
    let n = 0;
    // Markers are timed on the audio clock; the first comes 1 s after the stream starts.
    const ac = audio !== false ? new AudioContext() : undefined;
    const firstMarker = (ac?.currentTime ?? 0) + 1;
    const flashing = () => !!markers && !!ac && ac.currentTime >= firstMarker && (ac.currentTime - firstMarker) % markers < MARKER;
    setInterval(() => {
      g.fillStyle = flashing() ? '#fff' : `hsl(${n % 360} 60% 50%)`;
      n++;
      g.fillRect(0, 0, width, height);
      g.fillStyle = '#fff';
      g.font = '40px sans-serif';
      g.fillText(String(n), 40, 80);
    }, 33);
    const stream = c.captureStream(30);
    if (ac) {
      const osc = ac.createOscillator();
      const dst = ac.createMediaStreamDestination();
      if (markers) {
        // Quiet hum (so the silence detector stays quiet) with a loud beep at each marker,
        // scheduled a few seconds ahead at a time.
        const gain = ac.createGain();
        gain.gain.value = 0.05;
        osc.connect(gain).connect(dst);
        let next = firstMarker;
        const schedule = () => {
          while (next < ac.currentTime + 5) {
            gain.gain.setValueAtTime(0.8, next);
            gain.gain.setValueAtTime(0.05, next + MARKER);
            next += markers;
          }
        };
        schedule();
        setInterval(schedule, 1000);
      } else {
        osc.connect(dst);
      }
      osc.start();
      stream.addTrack(dst.stream.getAudioTracks()[0]);
    }
    (window as unknown as { __fakeStream: MediaStream }).__fakeStream = stream;
    return stream;
  };
}

export interface OpenOptions extends CaptureOptions {
  /** Extra query string, e.g. `?quota=0.2`. */
  query?: string;
  /** Open with `?debug` (log panel, `?quota`). Default true. */
  debug?: boolean;
  /**
   * 'real': record a meeting tab through Chrome's own tab capture (tests/helpers/meeting-tab.ts;
   * the `capture` project), instead of the synthetic stream. Needs `markers`.
   */
  capture?: 'synthetic' | 'real';
  /** With capture 'real': the meeting tab's sound and picture go through a WebRTC call first. */
  webrtc?: boolean;
}

export const test = base.extend<{ openApp: (opts?: OpenOptions) => Promise<Page> }>({
  // The real-capture project (`capture` in playwright.config.ts) records in a browser started as
  // a user would have it, not one launched by Playwright: tests/helpers/real-browser.ts.
  context: async ({ context, channel, launchOptions }, use, testInfo) => {
    if (!testInfo.project.name.includes('capture')) {
      await use(context);
      return;
    }
    const real = await launchRealBrowser(channel, launchOptions.args ?? []);
    await use(real.context);
    await real.close();
  },
  openApp: async ({ context, baseURL }, use) => {
    const problems: string[] = [];
    const origin = new URL(baseURL!).origin;
    const pages: Page[] = [];
    await use(async ({ audio = true, width, height, markers, query = '', debug = true, capture = 'synthetic', webrtc } = {}) => {
      const page = await context.newPage();
      pages.push(page);
      page.on('console', (m) => {
        if (/Content Security Policy|Refused to/.test(m.text())) problems.push(`csp: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('request', (r) => {
        const url = r.url();
        if (!url.startsWith(origin) && !url.startsWith('blob:') && !url.startsWith('data:')) problems.push(`request: ${url}`);
      });
      page.on('dialog', (d) => void d.accept());
      if (capture === 'synthetic') await page.addInitScript(fakeCapture, { audio, width, height, markers });
      const params = new URLSearchParams(query);
      if (debug) params.set('debug', '');
      await page.goto(new URL('/?' + params.toString(), baseURL).href); // absolute: a CDP-attached context has no baseURL
      // The startup scan of OPFS (tidying repairs, listing leftovers) must finish before a test
      // writes files there itself, or the scan meets half-written files.
      await expect(page.locator('#registre')).toContainText(' leftovers ');
      if (capture === 'real') await openMeetingTab(page, { markers: markers!, webrtc });
      return page;
    });
    expect(problems, 'CSP violations, page errors or requests to other origins').toEqual([]);
  },
});

export { expect };

/** Replaces the save dialog with one that "picks" a file in OPFS (`picked/<name>`). */
export async function fakeSavePicker(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('picked', { create: true });
      return dir.getFileHandle(suggestedName, { create: true }); // the real dialog creates it too
    };
  });
}

export async function opfsFiles(page: Page): Promise<{ name: string; size: number }[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('recordings', { create: true });
    const out: { name: string; size: number }[] = [];
    for await (const [name, h] of dir.entries()) out.push({ name, size: (await (h as FileSystemFileHandle).getFile()).size });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** Events from the on-page log (`HH:MM:SS ev {json}` lines). */
export async function logEvents(page: Page, ev: string): Promise<unknown[]> {
  const text = (await page.locator('#registre').textContent()) ?? '';
  return text
    .split('\n')
    .filter((l) => l.slice(9).split(' ')[0] === ev)
    .map((l) => {
      const json = l.slice(9 + ev.length + 1);
      return json ? JSON.parse(json) : undefined;
    });
}

export async function record(page: Page, ms: number): Promise<void> {
  await page.click('#grava');
  await expect(page.locator('#vista-gravant')).toBeVisible();
  await page.waitForTimeout(ms);
}

export async function stopAndWaitSaved(page: Page): Promise<void> {
  await page.click('#atura');
  await expect(page.locator('#vista-desat')).toBeVisible({ timeout: 30_000 });
}

export async function playerReady(page: Page): Promise<{ duration: number; width: number; height: number }> {
  await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('#reproductor')!.readyState >= 1, null, {
    timeout: 15_000,
  });
  return page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('#reproductor')!;
    return { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  });
}
