# TODO

Pending work, in order. Each item says enough to pick it up cold. The roadmap (phases, scope,
decisions) stays in [docs/PLAN.md](docs/PLAN.md) §1 and §7; test results are in
[docs/manual-tests.md](docs/manual-tests.md), limitations and untested checks in
[docs/limitations.md](docs/limitations.md). Remove an item when it is done; record results in
those docs, not here.

Ask Marcos before committing, pushing, tagging, publishing a release or deploying.

## Done: v0.1

Released 2026-11-19: tag `v0.1` on `20093ea`, GitHub release published, deployed to preview and
production (`/build-info.json` shows release v0.1 on both). Mac runs: one browser per run
(`-f browsers=chrome` or `msedge`); two 60-minute soaks in parallel stalled the VM.

## Now: v0.1.1, browser storage

Found in the first real Teams session (2026-11-20, Results row in `docs/manual-tests.md`): on a
managed Mac, Chrome's storage is a 6.17 GB volume and Trama's per-site limit was about 1.3 GB.
The 54-minute recording (1,229 MB) fitted, but the repair's second copy did not, twice
(`QuotaExceededError` on the copy's first writes). `navigator.storage.estimate()` reported
usage + 10,737 MB throughout, so the pre-check in `src/spike/repair.worker.ts` passed.

1. **Repair while saving.** **Desa el vídeo** writes the repaired WebM straight into the file
   from the save dialog (and the download path), reading the OPFS original, so no second copy
   is needed in OPFS. `repairWebm` already takes a source and a sink; the sink becomes the
   picked file's writable. Keep the in-OPFS repair only where it fits, or drop it and show the
   player from the unrepaired file with the duration from the recording.
2. **Don't trust `estimate()`.** Treat its quota as unknown: try, and handle
   `QuotaExceededError` (already done for recording and repair). Check the message shown when
   the recording itself hits the limit.
3. **Test:** reproduce a small per-site limit (for example `?debug&quota=` for the repair as
   well, or a Chromium switch) in `tests/e2e`.
4. **Decide (Marcos): long meetings on such machines.** Either record straight to a file
   chosen on disk at the start (no browser limit at all; bigger change, and the recovery
   after a crash works differently), or cap the capture size (2558×2534 here; near 1080p
   would about halve the file).
5. Release as v0.1.1: docs (limitations entry, README if the saving flow changes), tag,
   release notes, preview, production.

## Open, ask Marcos first

- GitHub social preview image: set `docs/brand/social/github-social-preview.png` in the repo's
  Settings (the API cannot upload it). Never on Marcos's personal profile.
- MP4 conversion `EncodingError` (seen once on the VM; WebM kept, message shown). If it happens
  on a real Mac, retry the conversion with the software encoder
  (`hardwareAcceleration: 'prefer-software'`).
- WebRTC variants of `tests/capture` are skipped on the server (no network in the test
  container) and on the macOS runner (the loopback call does not connect, probably macOS's
  local-network permission). Find a way to run them.
- Real Teams: one meeting recorded on 2026-11-20 (Chrome, listening only). Still to check:
  the real picker and "Share tab audio" box, the "Stop sharing" bar, and Edge (sync and
  hearing the meeting passed in that session). The list is in `docs/limitations.md`.

## Next features

The phases are in [docs/PLAN.md](docs/PLAN.md) §1. Beyond v0.1:

- **Phase 2, transcription** (Catalan first, Spanish close behind, mixed-language meetings as the
  normal case): spike on the `transcription` branch, worktree `/srv/apps/trama-transcription`,
  notes in `docs/transcription-spike.md` on that branch; models in `/srv/apps/trama-models`,
  test audio (never committed) in `/srv/apps/trama-eval-data`.
- **Phase 3:** subtitle editor (SRT/VTT), translation into Catalan keeping timings, bilingual
  view.
- **Phase 4:** burned-in subtitles, more formats.
- **Windows:** untested. Check AAC priming with Windows' encoder (Trama assumes Apple's 2112
  frames).
- **Teams desktop app support:** out of scope since 2026-11-15 (PLAN §7). A web page cannot
  capture it; it needs a native component (ScreenCaptureKit on macOS, an equivalent on
  Windows). See the proposal in `docs/limitations.md`; reconsider only if it becomes a
  requirement.
- **Browser extension (`tabCapture`):** only if one of the triggers in `docs/limitations.md`
  shows up.
- Open questions in PLAN §7: UI language (Catalan only or more), access (public `noindex` page
  or behind authentication).
