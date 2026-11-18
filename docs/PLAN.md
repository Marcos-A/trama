# Trama — plan

*Trama* (Catalan/Spanish): the weft of a fabric, and the plot of a story. The app weaves
tracks together: video, audio, subtitles, translations.

Status (2026-11-18): phase 1 released as v0.1 (§5 step 5): tab recording to OPFS, WebM repair
and recovery, WebM→MP4 conversion in the browser (§2, §7) keeping the audio's recorded timing,
raw tab audio; Playwright suite with A/V sync markers, real tab capture of a stand-in meeting
tab and an on-demand soak, also run on macOS in Chrome and Edge through GitHub Actions
(`.github/workflows/mac.yml`). Scope: **web-only** (§7); target browsers Chrome and Edge. Not
tested with a real Teams meeting: that session is postponed (§7, 2026-11-18); the untested
checks and known limitations are in [limitations.md](limitations.md). The original brief for phase 1 is
[spec/especificacion_mvp_grabador_reuniones.md](spec/especificacion_mvp_grabador_reuniones.md)
(Spanish); this plan adapts it to this server and to the wider product.

## 1. Product scope

| Phase | Feature | Where it runs |
|---|---|---|
| **1 (urgent)** | Record a Teams meeting open in a Chrome/Edge tab: video + tab audio, no mic/camera, saved locally | Browser only |
| 2 | Import existing recordings (WebM, MP4); transcription (Catalan first, Spanish a close second) with timestamps; search and jump to the moment in the video | Browser first; server only if quality requires it |
| 3 | Subtitle editor (SRT/VTT); translation into Catalan keeping timings; bilingual view; export | Browser + possibly server |
| 4 | Burned-in subtitles; more formats (WebM→MP4 is already done, see §2 and §7); downloading/streaming features | Mixed |

**Scope: web-only** (decided 2026-11-15, §7). Trama records meetings open in a browser tab;
the Teams desktop app is out of scope, as is any extension or native component, until a
future need justifies a different approach.

Principle carried from the brief: **recording never depends on the server.** Later phases may
add server-side processing, but each one needs its own consent and data-handling design
(brief §8) before any media leaves the user's machine.

## 2. Phase 1 architecture (adapted from the brief)

- **Stack:** TypeScript + Vite, no framework required. Static bundle served by nginx.
- **Capture:** `getDisplayMedia` with hints that steer the user to a tab and keep the meeting
  audible:
  `{ video: { displaySurface: "browser" }, audio: { suppressLocalAudioPlayback: false },
  selfBrowserSurface: "exclude", monitorTypeSurfaces: "exclude", surfaceSwitching: "include" }`.
  After the picker: verify one video and one audio track; if audio is missing, say so and do
  not label the result as audiovisual. Listen to `ended`/`mute` on every track.
- **Encoding:** `MediaRecorder`, pick the first supported of `video/webm;codecs=vp9,opus`,
  `video/webm;codecs=vp8,opus`, `video/webm`; record with a timeslice (~1–2 s).
- **Persistence (changed from the brief):** the brief suggests progressive writing via the
  File System Access API. In Chrome, `createWritable()` writes to a `.crswap` temp file that
  only becomes the real file on `close()`, so a crash loses everything. Instead:
  1. During recording, a worker appends each chunk to a file in the Origin Private File System
     via `createSyncAccessHandle()` + `flush()`. Writes happen in place, so a crash leaves a
     file playable up to the cut.
  2. On load, detect leftover OPFS recordings and offer to recover them.
  3. On stop, repair the WebM (MediaRecorder output has no duration/cues and is not seekable),
     then export via `showSaveFilePicker`, falling back to a download. *Done:*
     `src/media/webm-repair.ts`, our own streaming EBML rewrite instead of `ts-ebml` (which
     parses the whole file in memory): one pass from the OPFS file to a temporary OPFS file,
     size/Duration placeholders patched at the end, Cues per video keyframe after the last
     Cluster, then renamed over the original. A cut-off tail is dropped. 1 GB / 2 h took 10 s
     in headless Chromium on the server; seeking to 1 h 56 min took 0.3 s. Needs free space for
     the copy; if the repair fails, the unrepaired file is offered as before.
  4. Check space before and during recording with `navigator.storage.estimate()`
     (2 h ≈ 1–3 GB). Delete the OPFS copy only after a confirmed export.
  *To verify in the spike*, not assume.
- **MP4 export** (§7 decision; *done* on `mp4-convert`): **Desa en MP4** next to **Desa el
  vídeo**. A worker (`src/spike/convert.worker.ts`, `src/media/webm-to-mp4.ts`) re-encodes the
  OPFS recording with WebCodecs, using [Mediabunny](https://mediabunny.dev) (MPL-2.0, pinned)
  to demux the WebM and mux the MP4. Video: H.264 at the recording's size (even-rounded; later
  frames of a resized tab are letterboxed into it), medium quality, keyframe every 5 s. Audio:
  AAC from the platform encoder (Chrome/Edge on macOS and Windows); where there is none (Linux
  Chromium, so also the test suite) it is re-encoded to Opus and the user is told QuickTime may
  not play it. No WebAssembly (Mediabunny's AAC extension would need
  `'wasm-unsafe-eval'`), so the CSP is unchanged.
  - With the save dialog, the location is chosen first (the click still counts as a gesture)
    and the worker writes straight to it, so no second copy in OPFS; without it, the MP4 is
    built in OPFS (`exports/`, cleared on the next load or conversion) and downloaded.
  - The output is committed only when complete: cancel or error aborts the writable stream
    (Mediabunny closes its stream on cancel, which would commit a partial file, so it writes
    through a wrapper with no `close`) and removes the empty file the dialog created.
  - moov at the end (no fast start): one streaming pass, little memory, fine for local files.
  - Audio timing (`src/media/audio-retime.ts`, 2026-11-16): the WebM stamps each 60 ms Opus
    packet with capture time, but decoding and re-encoding lay the audio back to back, so the
    MP4 drifted by any difference between the tab's audio clock and the system clock. The
    converter now reads the packet stamps alongside the conversion and, in Mediabunny's
    `audio.process` hook, inserts silence or drops audio whenever the output is more than 20 ms
    off the recorded time (2.5 ms fades at each cut). Pad and trim rather than resampling:
    the real-world case is gaps, where silence is right, and Mac clock skew is too small to
    need correcting more than every few minutes.
  - Chrome's MediaRecorder marks the track `AlphaMode=1` when the source frames have alpha (the
    test canvas does). Mediabunny would then merge alpha in a `blob:` worker, which
    `worker-src 'self'` blocks, so the header is read with AlphaMode as 0
    (`src/media/webm-alpha.ts`).
  - Holds the recording's Web Lock while converting; the recording itself is never changed.
- **State machine:** `idle → requesting → recording → stopping → saved | error`, plus
  `recovering` for the leftover-file path and `saved → converting → saved` for MP4.
- **Background tabs:** Chrome throttles timers in hidden pages (to once a minute after 5 min).
  The stopwatch is derived from timestamps, and health checks hang off recorder/track events,
  not `setInterval`.

## 3. Deployment on this server

Same pattern as `full` (static Vite build → nginx), with a preview copy like `tempo` and `alias`.

| | production | preview |
|---|---|---|
| URL | `https://trama.marcos-a.com` | `https://trama-preview.marcos-a.com` |
| Checkout | `/srv/apps/trama` (`main`) | `/srv/apps/trama-preview` (git worktree, `preview` branch) |
| Compose file / project | `docker-compose.production.yml` / `trama` | `docker-compose.preview.yml` / `trama-preview` |
| Container / image | `trama-web` / `trama-web:local` | `trama-preview-web` / `trama-preview-web:local` |
| Host port | `127.0.0.1:8099` | `127.0.0.1:8100` |
| Deploy | `bash scripts/deploy_production.sh` | `bash scripts/deploy_preview.sh` |

No database, no secrets, no data volume: the only mount is `build-meta/` (read-only) for
`/build-info.json` (app-build-info convention: commit SHA, published-release only).

Files to copy from `/srv/apps/full` and adapt: `Dockerfile`, `docker-compose.production.yml`,
`deploy/nginx.conf`, `deploy/security-headers.conf`, `scripts/build-env.sh`,
`scripts/deploy_production.sh`, `scripts/write-build-info.sh`, `scripts/update-release-info.sh`.

**Header changes versus `full`** (otherwise the app breaks or loses guarantees):
- CSP: add `media-src 'self' blob:` (review player) and `worker-src 'self'` (OPFS writer).
  Keep `connect-src 'self'`: the browser itself then refuses to send media anywhere else.
- `Permissions-Policy: display-capture=(self), camera=(), microphone=()` — enforces the brief's
  "no mic/camera" in the browser.
- nginx: allow only `GET`/`HEAD`.

**Caddy** (`/srv/config/caddy/Caddyfile`): two blocks, both `import noindex`, tiny
`request_body max_size`, reverse proxy to 8099 / 8100. Validate as the `caddy` user, not with
sudo (root-owned log files break reload).

**Ops:** always run compose with `-f <file>` (never a bare `docker compose down`), add
`~/server-ops/docs/services/trama.md`, and add uptime-kuma monitors for both URLs.

Cost on the server: ~6 MiB RAM per container, ~95 MB per image. Recording uses no server
resources.

## 4. Development and testing

- **Dev server:** `vite dev` on the server; VS Code Remote forwards it to `localhost` on the
  Mac, which counts as a secure context, so `getDisplayMedia` works without HTTPS.
- **Automated (server, headless Chromium only):** Playwright with a synthetic stream (canvas
  `captureStream()` + WebAudio oscillator) replacing `getDisplayMedia`. Covers the state
  machine, missing-audio warning, track `ended`, OPFS writes, recovery, WebM repair and export.
  `bash scripts/test.sh` runs the type check, Node unit tests (`tests/unit`, repair against a
  real Chromium recording in `tests/fixtures`, including 200+ truncation points) and the browser
  tests (`tests/e2e`, including MP4 conversion with the download fallback, a stubbed save
  dialog, cancel and no-audio; H.264 + Opus, since Linux Chromium has no AAC encoder) in the Playwright image, with `--network none`; every browser test also
  fails on a CSP violation or a request to another origin. A/V sync is measured on flash-and-beep
  markers in the synthetic stream, decoded with Mediabunny (`tests/e2e/sync.spec.ts`; the MP4
  must be in sync on its own and match the WebM's marker times); the soak
  test (`tests/soak`, `SOAK_MINUTES=120`) runs the same checks plus heap, gaps, repair, seeking
  and MP4 over a long recording. Headless Firefox and WebKit only check that recording is
  disabled there (`tests/other-browsers`).
  Chromium only otherwise (capture only matters in Chrome/Edge, the only target browsers; Safari
  and Brave are out of scope); avoid running alongside other projects' browser suites, which
  load the 6-core server heavily.
- **Manual (Mac, real Teams):** the brief's §6 checklist, recorded in `docs/manual-tests.md`
  with browser versions and results. The session with real Teams is postponed (2026-11-18,
  §7); real tab capture is automated instead (`tests/capture`, with a stand-in meeting tab).
- **Flow:** work on branches → deploy to preview → manual test on the Mac → merge to `main` →
  deploy production. Docs (README in each language, screenshots) updated before each release
  tag.

## 5. Work order

1. **Scaffold** — Vite + TS project, Docker/compose/nginx/scripts adapted from `full`, the
   `preview` branch and `/srv/apps/trama-preview` worktree, Caddy blocks, DNS check. Deploy a
   placeholder page to both URLs.
2. **Spike** (brief §6) — minimal page: pick tab, record, OPFS write, stop, export. Run the Mac
   checklist in Chrome and Edge, including a 60- and 120-minute run, background tabs, killing
   the tab mid-recording (recovery), and native Teams window as an experiment.
   **Decision gate:** web-only if reliable; otherwise a Chrome extension (`tabCapture`) as
   capturer with the web app as UI; ScreenCaptureKit only if native Teams audio is required.
   **Decided 2026-11-15: web-only** (§7). The checklist ran on the Mac by hand in Chrome and
   Edge with ordinary tabs (Edge for 2 h 29 min) and, from 2026-11-17, automatically with real
   tab capture of a stand-in meeting tab (2 h hidden in Chrome on the macOS VM). The session
   with real Teams (a real meeting, the real picker, the "Stop sharing" bar, WebRTC) is
   postponed indefinitely (2026-11-18, §7); v0.1 is released without it.
3. **Harden** — error handling (denied permission, no audio, share ended, low space,
   unexpected close), WebM repair, recovery UI, Playwright suite.
4. **Polish UI** — Catalan UI, recording indicator, stopwatch, audio status, player, editable
   name, "Desar WebM".
5. **Release v0.1** — README (en/ca/es), limitations log ([limitations.md](limitations.md),
   brief deliverable 4), screenshots (none in the READMEs yet), tag, production deploy.

## 6. Acceptance criteria (phase 1)

Status at v0.1 (2026-11-18). Anything that needs a real Teams meeting is marked *not
verified*: that session is postponed (§7). Results in [manual-tests.md](manual-tests.md);
untested checks in [limitations.md](limitations.md).

The brief's §7 list:
- [ ] Records real video and audio of a Teams meeting in a tab, without microphone or camera.
  *Not verified with Teams.* Real tab capture of a stand-in meeting tab passes (`tests/capture`,
  Chrome and Edge on macOS); the microphone and camera are never requested and are blocked by
  the Permissions-Policy.
- [ ] The user can hear the meeting while it is recorded. *Not verified with Teams*
  (`suppressLocalAudioPlayback: false` is requested).
- [x] Recording keeps working while the user switches to another application, in the
  conditions tested: 2 h in Chrome with the window minimised (macOS VM, real tab capture),
  6 min hidden in Chrome and Edge.
- [x] The file plays with picture and sound in sync: within 0.1 s at every marker, WebM and
  MP4, over 2 h (stand-in tab); by hand in QuickTime (Edge's 2 h 29 min MP4). Not verified
  with Teams' own stream.
- [x] 90-minute continuous run, with 120 minutes as an extra target: 2 h 29 min in Edge by
  hand; 2 h real-capture soak in Chrome on the macOS VM.
- [x] Missing audio is detected and reported: **Sense so** (automated, 7e). The real picker's
  "Share tab audio" box has not been unticked by hand.
- [x] The file is saved locally, without upload: CSP `connect-src 'self'`; every browser test
  fails on a request to another origin.
- [x] The full video is not kept in memory while recording: heap flat at 3–10 MB over 2-hour
  runs.
- [x] Limitations and failure cases are documented: [limitations.md](limitations.md).

Plus:
- [x] Killing the recorder tab mid-recording leaves a recoverable file up to the cut
  (automated 7c, plus the cut-file repair unit tests).
- [x] The exported WebM is seekable and shows its duration (soaks; by hand in the page).
- [x] CSP and Permissions-Policy headers are present on both URLs (checked live 2026-11-18).

## 7. Open questions

- UI language: Catalan only, or Catalan + Spanish/English?
- Access: public static page with `noindex` (assumed), or behind authentication?
- Phase 2 transcription: in-browser model (privacy, slower) vs. server-side (quality, needs a
  consent and data design)? Decide after phase 1.
- Transcription languages: Catalan is the priority, Spanish a close second (decided
  2026-11-12). **Mixed meetings are the normal case, not an edge case:** in Catalan-speaking
  areas people switch between Catalan and Spanish freely, between speakers and within one
  person's turn. Requirement: each passage is transcribed in the language it was spoken in
  (never translated or forced into one language), with the language marked per segment so
  search, subtitles and phase 3 translation can use it. Evaluate candidate models on real
  mixed-language meeting audio, comparing a forced language against per-segment detection
  and models tuned on Catalan/Spanish code-switching.

### Decided

- **v0.1 without a real Teams session** (decided 2026-11-18). The manual Mac session with real
  Teams is postponed indefinitely and v0.1 is released without it. Real tab capture is covered
  by automated tests with a stand-in meeting tab (`tests/capture`, `SOAK_CAPTURE=real`: 2 h
  hidden in Chrome on the macOS VM, 6 min hidden in Chrome and Edge). The checks that need
  Teams are listed as untested in [limitations.md](limitations.md): a real Teams meeting, the
  real picker, the "Stop sharing" bar, and WebRTC (the automated WebRTC variants are skipped).
  Revisit when a session with real Teams is possible, or if users report problems.

- **Web-only** (decided 2026-11-15, at the §5.2 gate). Tab capture records video and tab audio
  reliably in Chrome and Edge 157 on macOS: 2 h 29 min without memory growth or drift, the tab
  in the background, recovery after a closed tab, MP4 conversion (docs/manual-tests.md). Capture
  from the Teams desktop app is out of reach from a browser (it would need ScreenCaptureKit in a
  native component), and nothing seen so far calls for a `tabCapture` extension, so both are
  left out of scope. Consequence for users: the meeting has to be open in a Chrome or Edge tab,
  and it is that tab that gets shared. Revisit only if the desktop app becomes a requirement.

- **Phase 1 records WebM only** (decided 2026-11-12). Stability comes first: VP8/VP9 + Opus
  WebM is MediaRecorder's most tested path in Chrome and Edge, and the OPFS writer, recovery
  and repair are built around it. MP4 comes later as a separate feature that converts a
  saved WebM: re-encode to H.264/AAC in the browser (WebCodecs + a bundled MP4 muxer), so no
  media leaves the machine and the CSP stays unchanged. Planned in phase 4 ("more formats"),
  built early (2026-11-12, `mp4-convert` branch; design in §2); phase 2 import accepts both
  WebM and MP4. AAC needs the platform encoder; without it the MP4 keeps Opus audio rather
  than loosening the CSP for a WebAssembly encoder.
