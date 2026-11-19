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

## Open, ask Marcos first

- GitHub social preview image: set `docs/brand/social/github-social-preview.png` in the repo's
  Settings (the API cannot upload it). Never on Marcos's personal profile.
- MP4 conversion `EncodingError` (seen once on the VM; WebM kept, message shown). If it happens
  on a real Mac, retry the conversion with the software encoder
  (`hardwareAcceleration: 'prefer-software'`).
- WebRTC variants of `tests/capture` are skipped on the server (no network in the test
  container) and on the macOS runner (the loopback call does not connect, probably macOS's
  local-network permission). Find a way to run them.
- Session with real Teams, postponed indefinitely on 2026-11-18: the checks it would cover are
  listed in `docs/limitations.md`; the plan for it is "Suggested session order" in
  `docs/manual-tests.md`.

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
