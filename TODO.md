# TODO

Pending work, in order. Each item says enough to pick it up cold. The roadmap (phases, scope,
decisions) stays in [docs/PLAN.md](docs/PLAN.md) §1 and §7; test results are in
[docs/manual-tests.md](docs/manual-tests.md), limitations and untested checks in
[docs/limitations.md](docs/limitations.md). Remove an item when it is done; record results in
those docs, not here.

Ask Marcos before committing, pushing, tagging, publishing a release or deploying.

## Now: release v0.1

State on 2026-11-19:

- `main` has one code change since production's `336650d`: the MP4 click fix (`da52d12`,
  `retimer()` in `src/media/audio-retime.ts` cut without a fade on trims of ≥ 57.5 ms and on
  pads in short chunks). The rest is tests, test scripts, the Mac workflow, docs and the version
  number (0.1.0). No tag and no GitHub release yet.
- Done: the MP4 click investigation and the Mac reruns one browser at a time (runs
  44381063662 Chrome, 44408947226 Edge, on `0dbbe2f`). Both browsers' MP4s were click-free in
  60-minute soaks and neither hung; results in `docs/manual-tests.md`. The two test-helper bugs
  those runs found are fixed (`measureSync` dropping the last marker on a slow audio clock;
  `DevToolsActivePort` read before Chrome wrote the port).
- Mac runs: one browser per run (`-f browsers=chrome` or `msedge`); two 60-minute soaks in
  parallel stalled the VM (run 44305733454). macOS minutes are free (public repo, standard
  `macos-15` runner).

- Decided 2026-11-19, two VM-only failures from run 44381063662, both now let through by the
  tests: a flash lost as the window minimises in the hidden capture test (one marker, with its
  beep, near the minimise), and a lone MP4 flash up to 0.15 s late (was 0.1 s; 103 ms seen,
  the VM encoder's grey first frame).

### Then: tag, release and deploy

With Marcos's go-ahead for each step. Recommended: tag after the commit with the test fixes and
these docs, without another Mac run.

1. Commit the docs (and any fix from the decisions above) before the tag, so the tag's docs match
   the code.
2. Tag `v0.1` and publish the GitHub release: what v0.1 does, the MP4 click fix (v0.1 is not
   docs-only), its limitations (link `docs/limitations.md`; not tested with a real Teams
   meeting), and the docs changes. No Claude or Anthropic credit anywhere.
3. Preview: bring the `preview` branch (worktree `/srv/apps/trama-preview`) up to the release
   commit, `bash scripts/deploy_preview.sh`, check the site.
4. Production: from `/srv/apps/trama` with `main` checked out, `bash scripts/deploy_production.sh`.
5. On both sites: `/build-info.json` shows the release commit and `release` v0.1; headers have
   CSP `connect-src 'self'` and `Permissions-Policy: display-capture=(self), camera=(), microphone=()`
   (`curl -sI`).
6. Update the status in `CLAUDE.md` (local, not committed) and
   `~/server-ops/docs/services/trama.md`.

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
