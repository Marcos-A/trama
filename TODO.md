# TODO

Pending work, in order. Each item says enough to pick it up cold. The roadmap (phases, scope,
decisions) stays in [docs/PLAN.md](docs/PLAN.md) §1 and §7; test results are in
[docs/manual-tests.md](docs/manual-tests.md), limitations and untested checks in
[docs/limitations.md](docs/limitations.md). Remove an item when it is done; record results in
those docs, not here.

Ask Marcos before committing, pushing, tagging, publishing a release or deploying.

## Now: release v0.1

State on 2026-11-18:

- Release docs and version 0.1.0 are committed and pushed (`63f7fb5` on `main`). Production
  and preview still run `336650d`; the commits since change only tests, test scripts, the Mac
  workflow, docs and the version number. No tag and no GitHub release yet.
- The Mac run on `63f7fb5` failed (run 44305733454, `soak_minutes=60`, Chrome and Edge in
  parallel; log only, the `mac-results` upload failed with `ENOTFOUND`):
  - The e2e suite passed in both browsers on the first attempt.
  - **Chrome soak, attempt 1, failed on one click:** the MP4's sound has one click at
    182.942 s (`jump` 0.033, `level` 0.048) where the WebM has none. Everything else passed:
    3,602 s, 317 MB, no bad events, heap 3 MB flat, repair 3.8 s, seeks exact, WebM sync −48 to
    +13 ms, MP4 (AAC) in 700 s, AVFoundation decoded both tracks to 3,600.6 s. The VM's audio
    clock ran 0.31 % slow (earlier runs: 0.12–0.13 %), so the converter padded 421 times
    (11.4 s) and trimmed 4 times (0.2 s). The synthetic soak requires no clicks in either file
    (`expectNoClicks` in `tests/soak/soak.spec.ts`).
  - **Then nothing progressed:** Edge's soak started its MP4 conversion at 13:44 UTC and never
    logged another step; Chrome's retry started recording at 13:56, never reached "stopping",
    and failed at 16:06 (test timeout). The job hit its 300-minute limit at 17:38 and the
    real-capture step was skipped. The same settings passed in 75 min on 2026-11-17
    (run 44078454240), so the VM is the likely cause, but a hang in the converter is not ruled
    out.

### 1. Find out whether the MP4 converter adds clicks

Goal: know whether the click at 182.9 s sits on one of the converter's pads or trims (a bug in
Trama's fades) or away from them (an AAC encoder glitch on the VM).

Done on 2026-11-18 (branch `mp4-clicks`, merged to `main`):

- `retimer()` had two cuts without a fade, both now fixed and unit-tested
  (`tests/unit/audio-retime.spec.ts`, `expectContinuous`): a trim of 57.5 ms or more dropped a
  whole chunk with no crossfade (a jump of 1.0 between frames; the failed run's 4 trims averaged
  50 ms, so this is a likely cause of its click), and a pad on a chunk under two fades had no
  fade (0.87). A trim now drops at most all but one fade's worth per chunk, and fades shrink to
  fit short chunks.
- `RetimeStats.cuts` lists where the first 1,000 pads and trims fall (in the app log's
  `mp4.audioRetime`), and the soak's summary matches each MP4 click to its nearest cut
  (`clicks.mp4NearestCut`, printed before the click assertions).

Left:

1. **Server soak result:** `SOAK_MINUTES=60 bash scripts/test.sh --project=soak
   --output=soak-results` was started on the fix (results in `soak-results/`, summary in
   `soak-summary.json`). Opus, not AAC, on the server. Record it in `docs/manual-tests.md`.
2. **Read the Mac runs from item 2:**
   - no MP4 clicks → the fix was it; note it in the Results rows;
   - a click a few ms from a cut (`distanceMs`; cut times are on the encoder's timeline, up to
     ~48 ms of AAC priming off) → the fades still click: look at that cut's kind and size;
   - a click far from any cut, only on the VM with AAC → most likely the VM's hardware encoder.
     Ask Marcos whether to make MP4 clicks report-only on the VM (as for real capture) and add
     a line to `docs/limitations.md` ("seen only on the macOS test VM").

### 2. Rerun the Mac soak one browser at a time

Goal: a clean 60-minute run in each browser on the release commit, and telling the VM's load
apart from a hang in Trama. The browser tests step runs Playwright with its default workers, so
with both browsers the two soaks and their MP4 conversions overlap; one browser per run avoids
that.

1. Start Chrome first (macOS minutes are free: the repo is public and `macos-15` is a standard
   runner):

   ```sh
   gh workflow run mac.yml --ref main -f soak_minutes=60 -f browsers=chrome
   gh run list --workflow mac.yml -L 1     # run id
   gh run watch <id> --interval 120 --exit-status   # in the background
   ```

   Expect about 1.5 h: e2e ~4 min, soak 60 min + ~12 min MP4 + ~5 min checks, real-capture
   tests ~10 min. If a run passes 2.5 h, look at it rather than wait for the 5-hour job limit.
   Then the same with `-f browsers=msedge`.
2. Results: `gh run download <id> -n mac-results -D <scratch dir>`; the soak writes
   `soak-summary.json`, `soak-sync.json` and `soak-log.json` under
   `test-results/soak-*-mac-<browser>/`. If the upload fails again (`ENOTFOUND`), the summary
   JSON is also printed in `gh run view <id> --log`. A step's log is only available once the
   step has finished.
3. Add a row per run to the Results table in `docs/manual-tests.md` (follow the earlier macos-15
   rows: run id, commit, soak figures, MP4 time, `audioRetime`, clicks, AVFoundation, retries),
   and a row for the failed run 44305733454 with the findings above.
4. If Edge hangs in the MP4 conversion again on its own: treat it as a Trama bug. Look at the
   converter's progress in `soak-log.json` (`mp4-sample` events), and consider a stall watchdog
   in the converter that fails with a message instead of hanging. Also consider a
   `timeout-minutes` on the browser tests step, so the real-capture tests and the upload still
   run.

### 3. Tag, release and deploy

Only after items 1–2, and with Marcos's go-ahead for each step:

1. Commit the docs from item 2 (and any fix) before the tag, so the tag's docs match the code.
2. Tag `v0.1` and publish the GitHub release: what v0.1 does, its limitations (link
   `docs/limitations.md`; not tested with a real Teams meeting), and the docs changes. No
   Claude or Anthropic credit anywhere.
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
