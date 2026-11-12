# Trama — plan

*Trama* (Catalan/Spanish): the weft of a fabric, and the plot of a story. The app weaves
tracks together: video, audio, subtitles, translations.

Status: scaffold live on both URLs; recording spike (§5.2) on the `spike` branch, under
manual testing; step 3 started (WebM repair, Playwright suite). The original brief for phase 1 is
[spec/especificacion_mvp_grabador_reuniones.md](spec/especificacion_mvp_grabador_reuniones.md)
(Spanish); this plan adapts it to this server and to the wider product.

## 1. Product scope

| Phase | Feature | Where it runs |
|---|---|---|
| **1 (urgent)** | Record a Teams meeting open in a Chrome/Edge tab: video + tab audio, no mic/camera, saved locally | Browser only |
| 2 | Import existing recordings (WebM, MP4); transcription (Catalan first) with timestamps; search and jump to the moment in the video | Browser first; server only if quality requires it |
| 3 | Subtitle editor (SRT/VTT); translation into Catalan keeping timings; bilingual view; export | Browser + possibly server |
| 4 | Burned-in subtitles; more formats, starting with converting a saved WebM to MP4 (H.264/AAC re-encode in the browser, see §7); downloading/streaming features, possible native-app capture via a local component | Mixed |

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
- **State machine:** `idle → requesting → recording → stopping → saved | error`, plus
  `recovering` for the leftover-file path.
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
  tests (`tests/e2e`) in the Playwright image, with `--network none`; every browser test also
  fails on a CSP violation or a request to another origin.
  Chromium only (capture only matters in Chrome/Edge); avoid running alongside other projects'
  browser suites, which load the 6-core server heavily.
- **Manual (Mac, real Teams):** the brief's §6 checklist, recorded in `docs/manual-tests.md`
  with browser versions and results.
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
3. **Harden** — error handling (denied permission, no audio, share ended, low space,
   unexpected close), WebM repair, recovery UI, Playwright suite.
4. **Polish UI** — Catalan UI, recording indicator, stopwatch, audio status, player, editable
   name, "Desar WebM".
5. **Release v0.1** — README (ca/en), limitations log (brief deliverable 4), screenshots,
   tag, production deploy.

## 6. Acceptance criteria (phase 1)

The brief's §7 list, plus:
- [ ] Killing the recorder tab mid-recording leaves a recoverable file up to the cut.
- [ ] The exported WebM is seekable and shows its duration.
- [ ] CSP and Permissions-Policy headers are present on both URLs.

## 7. Open questions

- UI language: Catalan only, or Catalan + Spanish/English?
- Access: public static page with `noindex` (assumed), or behind authentication?
- Phase 2 transcription: in-browser model (privacy, slower) vs. server-side (quality, needs a
  consent and data design)? Decide after phase 1.

### Decided

- **Phase 1 records WebM only** (decided 2026-11-12). Stability comes first: VP8/VP9 + Opus
  WebM is MediaRecorder's most tested path in Chrome and Edge, and the OPFS writer, recovery
  and repair are built around it. MP4 comes later as a separate feature that converts a
  saved WebM: re-encode to H.264/AAC in the browser (WebCodecs + a bundled MP4 muxer), so no
  media leaves the machine and the CSP stays unchanged. Planned in phase 4 ("more formats");
  phase 2 import accepts both WebM and MP4.
