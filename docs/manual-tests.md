# Manual tests

Real-capture tests run by hand on macOS (brief §6, [PLAN.md](PLAN.md) §4–5). Automated tests
only cover headless Chromium with a synthetic stream; anything involving a real Teams tab,
real audio or long runs is recorded here.

## How to run a spike session

1. Open the spike build (preview URL, or `npm run dev` forwarded to `http://localhost:5173`).
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

Simulating low space: open the page with `?quota=<MB>` (for example `?quota=50`); the
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

Long runs cover several checks at once:

1. **Chrome, 120 min** in a real meeting: checks 1, 3 (background for the first ≥ 10 min:
   other tabs, minimise, other apps), 4, 5a (note the size at 60 min from the log) and 5b.
   Check A/V sync near the start, at ~60 min and at the end (a clap or a spoken number on camera).
2. **Edge, 60 min**: checks 2, 3 again, 4, 5a.
3. **Short runs (2–5 min) in each browser**: 7a–7e, then 6 (native Teams window) last.

Download the log after each recording, before reloading the page.

### Decision gate (PLAN §5.2)

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
| 6 | Pick the native Teams window instead of a tab (experiment) | Record what happens to audio; not expected to work |
| 7a | Cancel the picker / deny permission | Clear message, back to start |
| 7b | Stop sharing from Chrome's bar mid-recording | Recording stops, file kept up to that point |
| 7c | Close the Trama tab mid-recording, reopen it | Recording listed under "Gravacions sense desar", recovers (repair drops the cut-off tail) and plays to the cut with a duration |
| 7d | Low space (`?quota=50`) | Stops with the space message, file kept |
| 7e | Untick "share tab audio" | "Sense so" warning shown during recording |
| 8a | **Desa en MP4** (Chrome), after a ≥ 5-min recording | Save dialog first, then progress; the saved `.mp4` plays in QuickTime with sound and the same duration, seeks; log `mp4.audioCodec` is `aac`; note `mp4.ms` and the size against the WebM |
| 8b | Same in Edge | Same |
| 8c | **Desa en MP4** on the 60-min recording, tab in the background meanwhile | Completes; note `mp4.ms`, heap flat; A/V sync at the end matches the WebM |
| 8d | Cancel·la midway through a conversion | Back to the recording with "Conversió cancel·lada"; nothing left at the chosen location (an existing file chosen to overwrite keeps its old contents) |

## Results

| Date | Browser + version | macOS | Check | Result | Notes (file size, heap, gaps, sync) |
|---|---|---|---|---|---|
| 2026-11-15 | Chrome 157 | ? | 8a (smoke, 23 s only) | Pass, pending QuickTime check | Save dialog used (`download: false`), `audioCodec` aac; WebM 0.67 MB → MP4 1.29 MB in 1,266 ms (~18× real time); 2558×2426; heap 4 MB. `mp4.durationS` 22.768 s against repaired WebM 23.164 s (field is the input's duration as Mediabunny computes it; check the MP4's real length in QuickTime). Tab audio mono with voice processing on (`echoCancellation`/`noiseSuppression`/`autoGainControl` true). |
| 2026-11-15 | Chrome 157 | ? | 8a | Pass (duration checked in QuickTime) | 5 min 16 s, mostly static tab. Save dialog used, `audioCodec` aac; WebM 5.98 MB → MP4 12.58 MB (2.1×) in 3,245 ms (~97× real time, few changed frames); 3036×2880; heap 4 MB throughout, `maxWriteMs` ≤ 8. MP4 and WebM same length in QuickTime (`mp4.durationS` 315.675 s against repaired 315.735 s). Frames 3036×2880 though the track reported 2558×2426 at start (same aspect ratio). |

## Known spike limitations

- The repair needs free space for a second copy while it runs. Without it, the video is still
  offered and saved, unrepaired, with a warning.
- The browser copy is deleted by hand (**Esborra la còpia del navegador**) after export.
- **Desa en MP4** re-encodes the whole video, so it takes a while on long recordings and the tab
  must stay open. Where the browser has no AAC encoder, the MP4 keeps Opus audio (VLC and
  browsers play it; QuickTime may not). The MP4 has its index at the end, which only matters
  when streaming it from a web server.
