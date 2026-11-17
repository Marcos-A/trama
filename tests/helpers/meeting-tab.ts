// A stand-in for the Teams tab, recorded through Chrome's real tab capture instead of the
// synthetic stream in tests/e2e/fixtures.ts. The browser is launched with
// --auto-select-tab-capture-source-by-title=<MEETING_TITLE>, so the picker picks this tab on its
// own, and Trama's getDisplayMedia call, constraints and all, runs unchanged.
//
// The page plays the same A/V markers as the synthetic stream (a quiet 440 Hz hum, a loud beep
// and an all-white frame every `markers` seconds, timed on the audio clock), but shows them on
// screen and plays them out loud, so what Trama records is what tab capture makes of them. With
// `webrtc`, picture and sound first go through a WebRTC call inside the page (two peer
// connections over loopback) and are played from the received stream, as Teams plays a remote
// participant: jitter buffer, Opus, and WebRTC's own lip sync.
//
// Needs a headed browser (Xvfb on the server, see scripts/test.sh): headless Chromium captures
// the tab's picture but only silence.

import type { BrowserContext, Page } from '@playwright/test';

export const MEETING_TITLE = 'Trama test meeting';
const MEETING_PATH = '/__test__/meeting.html';

export interface MeetingOptions {
  /** Seconds between markers. */
  markers: number;
  /** Send picture and sound through a loopback WebRTC call first, as in a real meeting. */
  webrtc?: boolean;
}

/** Runs in the meeting tab. */
async function meeting({ markers, webrtc }: MeetingOptions): Promise<void> {
  const MARKER = 0.2;
  const w = window as unknown as Record<string, unknown>;
  const ac = new AudioContext();
  const firstMarker = ac.currentTime + 1;
  const flashing = () => ac.currentTime >= firstMarker && (ac.currentTime - firstMarker) % markers < MARKER;

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const g = canvas.getContext('2d')!;
  let n = 0;
  const draw = () => {
    g.fillStyle = flashing() ? '#fff' : `hsl(${n % 360} 60% 50%)`;
    n++;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#fff';
    g.font = '40px sans-serif';
    g.fillText(String(n), 40, 80);
  };
  // A timer, not requestAnimationFrame: it keeps drawing whether or not the browser shows the
  // tab, so a frozen picture in the recording is down to capture, not to this page.
  setInterval(draw, 16);
  w.__frames = () => n;

  const osc = ac.createOscillator();
  const gain = ac.createGain();
  gain.gain.value = 0.05;
  osc.connect(gain);
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
  osc.start();

  const screen = document.createElement('video');
  screen.autoplay = true;
  screen.playsInline = true;
  screen.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:fill;background:#000';
  document.body.append(screen);

  if (!webrtc) {
    gain.connect(ac.destination);
    screen.muted = true;
    screen.srcObject = canvas.captureStream(60);
    await screen.play();
    w.__ready = true;
    return;
  }

  // Loopback call: canvas + tone in, received stream out to the <video>, which plays the sound.
  const dst = ac.createMediaStreamDestination();
  gain.connect(dst);
  const local = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...dst.stream.getAudioTracks()]);
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const remote = new MediaStream();
  b.ontrack = (e) => remote.addTrack(e.track);
  for (const t of local.getTracks()) a.addTrack(t, local);
  await a.setLocalDescription();
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription();
  await a.setRemoteDescription(b.localDescription!);
  await new Promise<void>((ok, fail) => {
    const t0 = performance.now();
    const check = () => {
      if (b.connectionState === 'connected' && remote.getTracks().length === 2) ok();
      else if (b.connectionState === 'failed' || performance.now() - t0 > 15_000) fail(new Error(`WebRTC loopback: ${b.connectionState}`));
      else setTimeout(check, 100);
    };
    check();
  });
  w.__rtc = { a, b };
  screen.srcObject = remote;
  await screen.play();
  w.__ready = true;
}

/** A new tab in `app`'s window (window.open, not a new window as `context.newPage()` gives). */
async function openTab(app: Page, url: string): Promise<Page> {
  const [tab] = await Promise.all([app.context().waitForEvent('page'), app.evaluate((u) => void window.open(u), url)]);
  await tab.waitForLoadState();
  return tab;
}

/**
 * Opens the meeting tab next to Trama (on the app's origin, without its CSP), waits until it
 * plays, and switches back to Trama, so the meeting tab is in the background as a Teams tab
 * would be.
 */
export async function openMeetingTab(app: Page, opts: MeetingOptions): Promise<Page> {
  await app.context().route(`**${MEETING_PATH}`, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>${MEETING_TITLE}</title><style>html,body{margin:0;background:#000;overflow:hidden}</style>`,
    }),
  );
  const page = await openTab(app, new URL(MEETING_PATH, app.url()).href);
  await page.evaluate(meeting, opts);
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
  await app.bringToFront();
  return page;
}

/**
 * Hides Trama and the meeting tab, as a user switching to other work does: a blank tab in front
 * of both, and the window minimised too (where there is a window manager: not under Xvfb).
 * Returns a function that brings `app` back.
 */
export async function hideTabs(app: Page): Promise<() => Promise<void>> {
  const other = await openTab(app, 'about:blank');
  await other.bringToFront();
  const cdp = await app.context().newCDPSession(other);
  const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  return async () => {
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.detach();
    await other.close();
    await app.bringToFront();
  };
}

/**
 * Whether a loopback WebRTC call can connect here. Chromium gathers no ICE candidates without a
 * network route, so not in scripts/test.sh's `--network none` container; it can on the macOS
 * runner.
 */
export async function webrtcWorks(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    return await page.evaluate(async () => {
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
      b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
      a.createDataChannel('probe');
      await a.setLocalDescription();
      await b.setRemoteDescription(a.localDescription!);
      await b.setLocalDescription();
      await a.setRemoteDescription(b.localDescription!);
      for (let i = 0; i < 50 && a.connectionState !== 'connected'; i++) await new Promise((r) => setTimeout(r, 100));
      const ok = a.connectionState === 'connected';
      a.close();
      b.close();
      return ok;
    });
  } finally {
    await page.close();
  }
}
