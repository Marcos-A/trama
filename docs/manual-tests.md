# Manual tests

Real-capture tests run by hand on macOS (brief §6, [PLAN.md](PLAN.md) §4–5). Automated tests
only cover headless Chromium with a synthetic stream; anything involving a real Teams tab or
real audio is recorded here. Target browsers: Chrome and Edge on the desktop. Safari and Brave
are out of scope (2026-11-16); the app says it has only been tested in Chrome and Edge.

## What the automated tests already cover

`bash scripts/test.sh` runs these on every change (headless Chromium, synthetic tab stream).
They exercise Trama's own logic; the manual runs below confirm the real browser interface and
real Teams capture.

| Check | Automated test |
|---|---|
| 1, 5a/5b (sync) | `tests/e2e/sync.spec.ts`: flash-and-beep markers, A/V offset in the WebM and the MP4 |
| 1, 2 (real capture) | `tests/capture`: Chrome's own tab capture of a meeting tab, in sync in the WebM and the MP4 (below) |
| 3 | `tests/capture`: Trama and the meeting tab hidden (`CAPTURE_HIDDEN_S`, default 60 s); the soak with `SOAK_CAPTURE=real` for the whole recording |
| 5a, 5b, 8c | `tests/soak` (on demand, below): long recording, heap, gaps, repair, seeking, MP4, sync |
| 7a | "cancelling the picker returns to the start with a message" |
| 7b | "stopping the share from the browser bar stops and keeps the file" (ends the track); `tests/capture`: the shared tab closing ends the capture from the browser's side. Neither clicks the real bar |
| 7c | "closed tab mid-recording …", plus the cut-file repair unit tests |
| 7d | "simulated full storage (?quota=) …" |
| 7e | "no audio track: 'Sense so' warning" |
| 7f | `tests/capture`: the captured tab's audio track has `echoCancellation`, `noiseSuppression` and `autoGainControl` `false`, stereo |
| 7g | `tests/other-browsers`: headless Firefox and WebKit are turned away |
| 8d | "cancelling the MP4 conversion leaves no file …" |

### Real tab capture (`tests/capture`)

The other suites feed Trama a canvas stream generated inside its own page. The `capture` project
records the way a user does: a second tab plays a stand-in meeting (`tests/helpers/meeting-tab.ts`:
the same flash-and-beep markers, shown on screen and played out loud, optionally through a
loopback WebRTC call as Teams plays a participant), and Chrome's real tab capture records it.
Trama's `getDisplayMedia` call runs unchanged; only the picker is answered by the switch
`--auto-select-tab-capture-source-by-title`. The browser is started as a user has it
(`tests/helpers/real-browser.ts`: normal profile, none of Playwright's switches, which turn
background throttling off) and Playwright attaches over CDP with `noDefaults`, because its focus
emulation would otherwise keep every tab "visible". As for a user, Chrome brings the shared tab to
the front once picked, so Trama records in the background.

On the server it runs headed under Xvfb (headless Chromium captures a tab's picture but only
silence). There is no sound card there: Chromium's stand-in output glitches under load, so the
captured WebM has a few clicks of its own and the test only requires that the MP4 adds none; on
macOS the WebM must be clean too. WebRTC needs a network route, which the server's test container
has none of (`--network none`), so the WebRTC variant runs only on the macOS runner. Hiding a
window by minimising it needs a window manager, so under Xvfb "hidden" means another tab in front;
on macOS the window is minimised as well.

What stays manual: Teams itself, the real picker and its "share tab audio" box, the "Stop sharing"
bar, hearing the meeting (4), and listening to the result.

Soak test: `SOAK_MINUTES=120 bash scripts/test.sh --project=soak --output=soak-results`
records that long with markers every 10 s, then checks the full log (no `chunk-gap`,
silence, track or write errors; heap flat), the repaired WebM (duration, seeks to the middle
and end, sync at 25 markers: each within 0.15 s, no drift between the first and last five) and
its MP4 (seeks, in sync on its own by the same measure, and picture and sound at the WebM's
times, marker by marker). It runs in a normal browser profile, since Playwright's default
private-mode context has too little storage for the repair's copy.
`soak-results/` keeps `soak-summary.json`, `soak-sync.json` and the full log. It occupies the
shared server for the whole run; avoid running it next to other projects' browser suites.
The synthetic stream comes from Trama's own page, so this soak does not replace check 3;
`SOAK_CAPTURE=real` does: it records the meeting tab through real tab capture, with Trama and the
meeting tab hidden from the first minute to the last and during the MP4 conversion, past Chrome's
intensive throttling (after 5 minutes hidden).

On macOS, in the installed Chrome and Edge, the same e2e suite and soak run in GitHub Actions
(`.github/workflows/mac.yml`, started by hand: `gh workflow run mac.yml -f soak_minutes=60`),
plus `tests/capture` headed in each browser (hidden for `capture_hidden_s`, default 360 s). For
check 3 at length: `gh workflow run mac.yml -f soak_minutes=120 -f soak_capture=real -f
browsers=chrome`.
There the MP4's audio is AAC from Apple's encoder, which the server's Chromium lacks, and the
MP4 is also opened with AVFoundation (`scripts/avfoundation-check.swift`, QuickTime's framework):
playable, H.264 + AAC, same length, both tracks decode to the end. Both suites also look for
clicks in the WebM's and the MP4's sound (`tests/helpers/clicks.ts`). The macOS runner is a VM
whose hardware codecs fail now and then, so tests there get one retry. Results are kept as the
run's `mac-results` artifact (the soak's MP4 left out; the e2e sync test's is kept, to look into a
failed attempt) for 14 days.

## How to run a spike session

1. Open the build with `?debug` (preview URL, or `npm run dev` forwarded to
   `http://localhost:5173`): for example `https://trama-preview.marcos-a.com/?debug`. Without it
   the **Registre de proves** panel is hidden.
2. Join or start a Teams meeting in another tab of the same browser, with someone sharing
   video and talking (a second device works).
3. In Trama: **Grava una pestanya** → pick the Teams tab → keep "share tab audio" ticked.
4. Do the checks below, then **Atura**. The page shows **Preparant el vídeo** while it adds the
   duration and seek index (about 10 s per GB on the server; note the time on the Mac), then
   play back, **Desa el vídeo**.
5. Open **Registre de proves** → **Baixa el registre (JSON)** and keep the file with the run
   (attach or summarise it in the table). The log samples file size, JS heap, storage and
   write time every ~30 s, and records chunk gaps, track mute/end and tab visibility.

Use a normal window, not incognito/InPrivate: Chrome gives incognito pages a small storage
quota, so a long recording would stop early with the "out of space" message.

Simulating low space: open the page with `?debug&quota=<MB>` (for example `?debug&quota=50`;
`?quota` is ignored without `?debug`); the
recording stops as if the browser ran out of space once the file passes that size.

Reading the log: `chunk-gap` means the recorder delivered nothing for over 2.5 s (throttling
or a stalled encoder); `audio-silence-start` means 15 s of digital silence on the tab audio;
`sample.heapMB` should stay flat (the recording is not held in memory); `repair` gives the
duration found, the number of seek points (`cues`) and how long the repair took (`ms`);
`repair-failed` means the video is offered unrepaired (no duration, unreliable seeking).

Summarising logs: `node scripts/spike-log-summary.mjs <log.json> ...` (or, without Node on the
host, `docker run --rm --network none -v "$PWD/scripts:/s:ro" -v <logs dir>:/logs:ro
node:24-slim node /s/spike-log-summary.mjs /logs/<file>.json`). It prints each recording's
size, duration, gaps, heap trend, hidden time, audio events and errors, plus a draft Results
row; fill in macOS, the check number and A/V sync by hand.

The log lives in page memory only: for 7c, the killed recording's own log is lost. Download
the log of the reopened page (it shows `leftovers` and `recover`) and note by hand roughly
when you killed the tab, to compare with the recovered file's length.

### Suggested session order

Most of the length, background and sync checks now run without Teams (`tests/capture`, the soak
with `SOAK_CAPTURE=real`, and both on macOS in the workflow). What a session with real Teams still
adds:

1. **Chrome, 60–120 min** in a real meeting (Edge has 2 h 29 min; Chrome only 5 min): checks 1, 3
   (Trama and Teams in the background for a good part of it: other tabs, minimised, other apps;
   note when), 4 (you hear the meeting throughout) and 5a/5b. A clap or a spoken number on camera
   near the start, at ~60 min and at the end for A/V sync.
2. **Desa en MP4** on that recording with the tab in the background (8c in Chrome), then listen
   in QuickTime: sync at the three markers, and no clicks or gaps where `mp4.audioRetime` says
   audio was padded or trimmed (the log gives counts only: with any, listen to a few 5-minute
   stretches of continuous speech).
3. **Short runs (2–5 min)** for the real browser interface only: cancel the picker (7a), stop
   from the "Stop sharing" bar (7b), close the Trama tab (7c), `?debug&quota=50` (7d), untick
   "share tab audio" (7e). Check 6 is optional: the desktop app is out of scope.

Download the log after each recording, before reloading the page, and summarise it with
`scripts/spike-log-summary.mjs` (it prints the MP4 lines and the audio track settings too).

### Decision gate (PLAN §5.2)

**Decided 2026-11-15: web-only.** The criteria below stay as quality checks for the remaining
runs; the extension and native options are out of scope (PLAN §7).

- **Web-only** if, in both browsers, 1–5b pass: no audio drop-outs, no `chunk-gap` beyond the
  occasional isolated one, heap flat, A/V sync within ~0.5 s at 120 min, and 7b–7d keep the file.
- **`tabCapture` extension** if a background tab loses video or audio, gaps repeat while
  hidden, or long runs drift or stall in a way the page cannot avoid.
- **Native capture (ScreenCaptureKit)** only if recording the native Teams app (check 6)
  turns out to be a requirement; it is not expected to work from the browser.

## Spike checklist (brief §6)

| # | Check | Pass criteria |
|---|---|---|
| 1 | Chrome, Teams tab, video + audio | Plays back with image and sound in sync; the player shows the duration and seeking works |
| 2 | Edge, same | Same |
| 3 | Switch tabs, minimise the window, work in other apps for ≥ 10 min | Video keeps updating, no audio drop-outs, no `chunk-gap` in the log |
| 4 | Meeting stays audible while recording | You hear the meeting the whole time |
| 5a | 60-minute run | File plays to the end; heap flat; note file size and repair time; seek to the middle and the end, in the page and in the saved file (VLC/QuickTime-compatible player) |
| 5b | 120-minute run | Same; note file size and A/V sync at the end |
| 6 | *(Optional; out of scope since 2026-11-15)* Pick the native Teams window instead of a tab | Record what happens to audio; not expected to work |
| 7a | Cancel the picker / deny permission | Clear message, back to start |
| 7b | Stop sharing from Chrome's bar mid-recording | Recording stops, file kept up to that point |
| 7c | Close the Trama tab mid-recording, reopen it | Recording listed under "Còpies al navegador", recovers (repair drops the cut-off tail) and plays to the cut with a duration |
| 7d | Low space (`?debug&quota=50`) | Stops with the space message, file kept |
| 7e | Untick "share tab audio" | "Sense so" warning shown during recording |
| 7f | Any recording with a Teams meeting (Chrome, then Edge) | In `recording-started`, the audio track shows `echoCancellation`, `noiseSuppression` and `autoGainControl` `false` (note `channelCount`); the saved file sounds normal, with no change in level or quality against earlier recordings |
| 7g | *(Postponed; Safari and Brave out of scope since 2026-11-16)* Open Trama in Safari | **Grava una pestanya** disabled, message asks for Chrome or Edge on desktop. Headless Firefox and WebKit are covered by `tests/other-browsers` |
| 8a | **Desa en MP4** (Chrome), after a ≥ 5-min recording | Save dialog first, then progress; the saved `.mp4` plays in QuickTime with sound and the same duration, seeks; log `mp4.audioCodec` is `aac`; note `mp4.ms` and the size against the WebM |
| 8b | Same in Edge | Same |
| 8c | **Desa en MP4** on the 60-min recording, tab in the background meanwhile | Completes; note `mp4.ms`, heap flat; A/V sync at the end matches the WebM |
| 8d | Cancel·la midway through a conversion | Back to the recording with "Conversió cancel·lada"; nothing left at the chosen location. An existing file chosen to replace is gone too: Chrome and Edge empty it as the save dialog closes, before the conversion starts |

### Re-check after the MP4 audio timing change

Done in the macOS workflow on 2026-11-17 (Results); left by hand: one listen to a real AAC MP4
with speech or music. The original checklist:

- **8a** (Chrome, ≥ 5-min recording, preferably with speech or music throughout): QuickTime
  plays with sound, same length as the WebM (within 0.1 s), seeks; `mp4.audioCodec` `aac`.
  Note `mp4.audioRetime`. If it has any `pads` or `trims`, listen through: no clicks or
  dropouts you would notice.
- **8c** (the 60-min recording or longer): completes, heap flat; A/V in sync at the end and
  matches the WebM played at the same moment. Note `mp4.audioRetime` and `mp4.ms` (against the
  earlier 8c rows: the audio is re-encoded either way, so the time should be about the same).

## Results

| Date | Browser + version | macOS | Check | Result | Notes (file size, heap, gaps, sync) |
|---|---|---|---|---|---|
| 2026-11-15 | Chrome 157 | Tahoe 26.7.3 | 8a (smoke, 23 s only) | Pass, pending QuickTime check | Save dialog used (`download: false`), `audioCodec` aac; WebM 0.67 MB → MP4 1.29 MB in 1,266 ms (~18× real time); 2558×2426; heap 4 MB. `mp4.durationS` 22.768 s against repaired WebM 23.164 s (field is the input's duration as Mediabunny computes it; check the MP4's real length in QuickTime). Tab audio mono with voice processing on (`echoCancellation`/`noiseSuppression`/`autoGainControl` true). |
| 2026-11-15 | Chrome 157 | Tahoe 26.7.3 | 8a | Pass | 5 min 16 s, mostly static tab. Save dialog used, `audioCodec` aac; WebM 5.98 MB → MP4 12.58 MB (2.1×) in 3,245 ms (~97× real time, few changed frames); 3036×2880; heap 4 MB throughout, `maxWriteMs` ≤ 8. In QuickTime: plays with sound, seeks, same length as the WebM (`mp4.durationS` 315.675 s against repaired 315.735 s). Frames 3036×2880 though the track reported 2558×2426 at start (same aspect ratio). |
| 2026-11-15 | Chrome 157 | Tahoe 26.7.3 | 7f | Pass | Preview 2e938a0, local video file in a tab, 75 s. Audio track `echoCancellation`/`noiseSuppression`/`autoGainControl` `false`, now `channelCount` 2 at 44,100 Hz (was 1 at 48,000 Hz with processing on). No `audio-silence-start`; WebM 4.4 MB plays with picture and sound. |
| 2026-11-15 | Edge 157 | Tahoe 26.7.3 | 7f | Pass | After restarting Edge, a YouTube video in a new tab, 32 s each: production settings (`?audio=default`, all on, mono 48 kHz) 11.5 MB and all off (`?audio=none`, stereo 44.1 kHz) 15.3 MB, both with sound and no `audio-silence-start`. The earlier silent Edge runs (17:02–17:25, any setting, including production's) shared the account-2 Teams tab while account 1, in Brave on the same Mac, played the video: its sound most likely never entered the meeting (no tab share with sound from Brave), so the Edge tab played nothing, and what was heard came straight from Brave. Check for next time: mute Brave's tab; if the meeting is still heard, it reaches the shared tab and is recorded. Also seen: `noiseSuppression` or `autoGainControl` alone is ignored; only `echoCancellation` switches between the processed path (mono 48 kHz) and the raw one. |
| 2026-11-15 | Edge 157 | Tahoe 26.7.3 | 8b | Pass | Same recording as the 8d row (5 min 17 s, portrait tab with motion). Save dialog used, `audioCodec` aac; WebM 31.2 MB → MP4 6.8 MB (0.22×) in 6,318 ms and 6,133 ms on two runs (~50× real time), identical output size both times; 1608×2684. In QuickTime: plays with sound, seeks, same length as the WebM (`mp4.durationS` 317.007 s against repaired 317.067 s). |
| 2026-11-15 | Edge 157 | Tahoe 26.7.3 | 8c | Pass (background only ~40 s) | 2 h 28 min 56 s recording: 2.82 GB WebM, heap 5–7 MB and `maxWriteMs` ≤ 19 throughout, repair 5.9 s. MP4 801 MB (0.28×) in 559 s (~16× real time), AAC, 1072×1790; `mp4.durationS` 8,936.33 s against repaired 8,936.38 s. In QuickTime: sound, moving image, seeks, A/V in sync at the end. Tab hidden for only ~40 s of the conversion; no heap figures during conversion (logged since as `mp4-sample`). Found: the WebM save (12 s) and the MP4 conversion ran at once, and the WebM's "Vídeo desat" message appeared over the conversion; fixed by disabling the other actions while saving. |
| 2026-11-15 | Edge 157 | Tahoe 26.7.3 | 8c (background) | Pass | Preview b2c4966. 35 min 33 s recording, 1608×2684 with motion: WebM 616 MB, heap 5–7 MB, repair 1.2 s. Tab hidden for the whole conversion (all 9 `mp4-sample` during it `hidden: true`); progress a steady ~10.5 % per 30 s, so no background throttling. MP4 450 MB (0.73×) in 281 s (~7.6× real time; the 2 h 29 min run was 16× at 2.25× fewer pixels), AAC; `mp4.durationS` 2,133.18 s against repaired 2,133.28 s. Page heap 5–7 MB during conversion; `workerHeapMB` absent (Edge reports no heap in workers), so converter memory isn't logged. In QuickTime: sound, A/V in sync in the last minutes, matches the WebM. |
| 2026-11-15 | Edge 157 | Tahoe 26.7.3 | 8d | Pass | 5 min 17 s, portrait tab 1608×2684 with motion: WebM 31.2 MB, repair 73 ms, heap 6–7 MB. Cancelled 7.5 s into the conversion: "Conversió cancel·lada" shown, back to the recording, nothing at a new location. Replacing an existing file: the browser emptied it as soon as the dialog closed, and after the cancel it was gone (expected result revised). |
| 2026-11-17 | Headless Chromium (Playwright 1.65, server) | — | 5a, 5b, 8c (soak, synthetic) | Pass | `SOAK_MINUTES=120`, 640×360 with markers every 10 s. 7,200 s, 693 MB, no `chunk-gap`, silence, track or write errors; heap 10 MB flat throughout (recording and conversion), `maxWriteMs` ≤ 56. Repair 7.3 s, 3,497 cues; seeks to the middle and end exact. WebM sync −48 to +83 ms at 25 markers, no drift (median first five −37 ms, last five −33 ms). MP4 (Opus, Linux) 394 MB in 687 s, same length, seeks; picture and beeps match the WebM at all 25 markers. On its own the MP4 drifts to +6.2 s at the end: headless audio clock 0.086 % slow, laid back to back by the converter (known limitation). A first run (2026-11-16) skipped the repair for lack of space: Playwright's private-mode context has a small quota; the soak now uses a normal profile (10.7 GB). |
| 2026-11-17 | Headless Chromium (Playwright 1.65, server) | — | 8c (soak, synthetic), MP4 audio timing | Pass | Branch `mp4-audio-timing`, `SOAK_MINUTES=10`. Audio clock 0.50 % slow (unevenly). No bad events, heap 10 MB flat. MP4 (Opus) in 59 s; `audioRetime` 122 pads (3.19 s) and 10 trims (0.22 s). MP4 beeps within ±20 ms of the WebM's at all 25 markers (flashes identical); MP4 alone −48 to +5 ms, no drift. Without the fix it would have ended ~3 s out. Whether the cuts are audible is for the Mac check. |
| 2026-11-17 | Chrome 157, Edge 156 (GitHub Actions macos-15 VM, synthetic stream) | Sequoia 15.8.2 | 8a, 8c (automated), MP4 audio timing, AAC priming | Pass | Run 44078454240, branch `mac-ci`: e2e suite and `SOAK_MINUTES=60` in each browser, 43 passed. Soak: 3,600 s, 322 / 320 MB, no bad events, heap 3 MB flat, repair 1.4 / 1.6 s, seeks exact. MP4 (AAC) in 472 / 497 s, heap 4–5 MB; `audioRetime` 180 / 177 pads (4.7 / 4.6 s, audio clock 0.13 % slow), no trims; no clicks in WebM or MP4; MP4 sync −43 to +16 / −48 to +42 ms at 25 markers, no drift. AVFoundation: playable, avc1 + aac, both tracks decoded to 3,600.1–3,600.3 s. An earlier run found the AAC MP4's sound a constant 41–47 ms late (encoder priming, 2112 frames); fixed by starting the audio that much earlier, with an edit list (`src/media/webm-to-mp4.ts`), then −10 to +3 ms against the WebM. One flaky e2e attempt in Chrome (MP4's first flash 95 ms after the WebM's, the rest exact; passed on retry). |
| 2026-11-17 | Chromium 158 headed under Xvfb (server), real tab capture | — | 1, 3, 7b, 7f (`tests/capture`), 3 + 8c (`SOAK_CAPTURE=real`, 10 min) | Pass | Branch `real-capture`. Captured audio stereo 44.1 kHz with `echoCancellation`/`noiseSuppression`/`autoGainControl` `false`; WebM sync −41 to −79 ms, MP4 the same marker by marker. Chrome put the shared tab in front once picked, so Trama recorded in the background, as for a user. Soak: Trama hidden for 9 of the 10 min (past intensive throttling) and during the MP4 conversion; no `chunk-gap`, silence or track events, heap 4 MB flat, `maxWriteMs` ≤ 33; repair 0.85 s to 600.72 s; sync −49 to −82 ms at 25 markers, no drift; MP4 (Opus) in 156 s, 16 pads (0.37 s), matches the WebM. Clicks in the WebM (122) come from the server's stand-in sound output, not Trama; the MP4 adds none in the short test. WebRTC variant not run (no network route in the test container). |

## Known spike limitations

- The repair needs free space for a second copy while it runs. Without it, the video is still
  offered and saved, unrepaired, with a warning.
- The browser copy is deleted by hand (**Esborra la còpia del navegador**) after export.
- **Desa en MP4** re-encodes the whole video, so it takes a while on long recordings and the tab
  must stay open. Where the browser has no AAC encoder, the MP4 keeps Opus audio (VLC and
  browsers play it; QuickTime may not). The MP4 has its index at the end, which only matters
  when streaming it from a web server.
- **Desa en MP4** keeps the audio on the WebM's recorded timing (since 2026-11-16): where the recording has a gap, or the tab's audio clock ran slower than
  the computer's, silence is inserted; where it ran faster, a little audio is skipped. Each
  correction brings the sound back within 20 ms of where it was recorded and has a 2.5 ms fade,
  so it should not click; the log's `mp4.audioRetime` counts them (`pads`, `paddedS`, `trims`,
  `trimmedS`). On the Mac the clocks agree closely, so expect few or none; headless Chromium's
  fake audio device runs 0.1–3 % slow, unevenly (0.5 % in a 10-min soak: 122 pads and 10 trims,
  one every ~4.5 s). Before this the MP4 laid the audio back to back and drifted by the clock
  difference (+6.2 s after 2 h in the 2026-11-17 soak).
- AAC: the MP4 skips the encoder's 2112-frame priming with an edit list (since 2026-11-17).
  2112 is the delay of Apple's encoder, which Chrome and Edge use on macOS; Windows' encoder is
  untested, and a different delay there would put the sound a few tens of ms early or late.
- Choosing to replace an existing file in the save dialog empties it straight away (Chrome and
  Edge do this, not the app), so cancelling or failing the export afterwards loses the old file.
