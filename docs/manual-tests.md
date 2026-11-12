# Manual tests

Real-capture tests run by hand on macOS (brief §6, [PLAN.md](PLAN.md) §4–5). Automated tests
only cover headless Chromium with a synthetic stream; anything involving a real Teams tab,
real audio or long runs is recorded here.

## How to run a spike session

1. Open the spike build (preview URL, or `npm run dev` forwarded to `http://localhost:5173`).
2. Join or start a Teams meeting in another tab of the same browser, with someone sharing
   video and talking (a second device works).
3. In Trama: **Grava una pestanya** → pick the Teams tab → keep "share tab audio" ticked.
4. Do the checks below, then **Atura**, play back, **Desa el vídeo**.
5. Open **Registre de proves** → **Baixa el registre (JSON)** and keep the file with the run
   (attach or summarise it in the table). The log samples file size, JS heap, storage and
   write time every ~30 s, and records chunk gaps, track mute/end and tab visibility.

Simulating low space: open the page with `?quota=<MB>` (for example `?quota=50`); the
recording stops as if the browser ran out of space once the file passes that size.

Reading the log: `chunk-gap` means the recorder delivered nothing for over 2.5 s (throttling
or a stalled encoder); `audio-silence-start` means 15 s of digital silence on the tab audio;
`sample.heapMB` should stay flat (the recording is not held in memory).

## Spike checklist (brief §6)

| # | Check | Pass criteria |
|---|---|---|
| 1 | Chrome, Teams tab, video + audio | Plays back with image and sound in sync |
| 2 | Edge, same | Same |
| 3 | Switch tabs, minimise the window, work in other apps for ≥ 10 min | Video keeps updating, no audio drop-outs, no `chunk-gap` in the log |
| 4 | Meeting stays audible while recording | You hear the meeting the whole time |
| 5a | 60-minute run | File plays to the end; heap flat; note file size |
| 5b | 120-minute run | Same; note file size and A/V sync at the end |
| 6 | Pick the native Teams window instead of a tab (experiment) | Record what happens to audio; not expected to work |
| 7a | Cancel the picker / deny permission | Clear message, back to start |
| 7b | Stop sharing from Chrome's bar mid-recording | Recording stops, file kept up to that point |
| 7c | Close the Trama tab mid-recording, reopen it | Recording listed under "Gravacions sense desar", recovers and plays to the cut |
| 7d | Low space (`?quota=50`) | Stops with the space message, file kept |
| 7e | Untick "share tab audio" | "Sense so" warning shown during recording |

## Results

| Date | Browser + version | macOS | Check | Result | Notes (file size, heap, gaps, sync) |
|---|---|---|---|---|---|
| | | | | | |

## Known spike limitations

- Exported WebM has no duration or cues: players show no total length and seeking is
  unreliable. WebM repair is step 3 (Harden).
- The browser copy is deleted by hand (**Esborra la còpia del navegador**) after export.
