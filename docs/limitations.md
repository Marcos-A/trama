# Limitations (v0.1)

What Trama v0.1 does not do, what has not been tested, and how it behaves when something goes
wrong. This is deliverable 4 of the original brief
([spec](spec/especificacion_mvp_grabador_reuniones.md) §10): the limitations log and a reasoned
proposal on moving to a browser extension. The test results behind each point are in
[manual-tests.md](manual-tests.md).

## Not tested with a real Teams meeting

v0.1 has been tested with Chrome's real tab capture of a stand-in meeting tab, not with a real
Teams meeting. The session with real Teams was postponed on 2026-11-18 and v0.1 is released
without it.

What has been tested instead:

- **Real tab capture, automated** (`tests/capture`): a second tab plays a stand-in meeting
  (flashes on screen and beeps out loud) and Chrome's own tab capture records it, with Trama
  unchanged except for the picker, which a browser switch answers. On the macOS test VM
  (Sequoia 15.8.2): a 2-hour recording in Chrome 157 with Trama and the meeting tab minimised
  throughout, and 6-minute hidden runs in Chrome 157 and Edge 156. Picture and sound stayed
  within 0.1 s of each other at every marker, in the WebM and in the MP4.
- **By hand on a Mac** (macOS Tahoe 26.7.3, Chrome and Edge 157): ordinary tabs with video and
  sound, up to 2 h 29 min in Edge, played back and converted to MP4 in QuickTime.

Untested, and still to check in a session with real Teams:

| Check | Why it is not covered |
|---|---|
| Recording a real Teams meeting (brief §6 checks 1 and 2) | The stand-in tab plays its own markers; Teams' video and sound pipeline was never in the loop |
| The real picker and its "Share tab audio" box | The tests answer the picker with a browser switch. Cancelling it (7a) and recording without sound (7e) are tested with a simulated stream |
| Stopping from the browser's "Stop sharing" bar (7b) | The tests end the shared track or close the shared tab; none clicks the bar |
| WebRTC | Teams plays the other participants through a WebRTC call. The automated WebRTC variants are skipped: the test container has no network, and the loopback call does not connect on the macOS runner |
| Hearing the meeting while it is recorded (check 4) | Trama asks the browser to keep the tab audible (`suppressLocalAudioPlayback: false`), but nobody has listened to a Teams meeting while recording it |
| Listening to an AAC MP4 of speech or music | The MP4's sound timing was checked by measurement after the 2026-11-17 change, not by ear |

## Where it works

- **Chrome and Edge on the desktop only.** Firefox and Safari cannot record a tab's audio, so
  Trama disables recording there. Brave and other Chromium browsers are not tested. Phones
  and tablets are not supported.
- **Tested on macOS only.** Windows is untested. On Windows the MP4's AAC sound may start a few
  tens of milliseconds early or late (see below).
- **The meeting has to be open in a browser tab.** The Teams desktop app cannot be recorded
  from a web page: that would need a native component (ScreenCaptureKit on macOS), which is out
  of scope.
- **Only the shared tab is recorded.** Trama never asks for the microphone or the camera, so
  **your own voice is not in the recording**: Teams does not play your own voice back to you
  in the tab. Neither are notifications or other apps' sounds.
- **The browser asks every time.** A web page cannot pick the Teams tab by itself: each
  recording starts with the browser's picker, and the user has to keep "Share tab audio" on.
- **Trama's tab has to stay open.** Closing it, reloading it or the browser crashing stops the
  recording. What was recorded up to that moment stays in the browser and can be recovered
  (below).

## When something goes wrong

| Situation | What Trama does |
|---|---|
| The picker is cancelled or permission is denied | Back to the start, with a message |
| The shared tab has no sound ("Share tab audio" off) | Records anyway and shows **Sense so** for the whole recording, so the file is not taken for a full recording |
| Sharing is stopped from the browser, or the shared tab is closed | The recording stops and is kept up to that moment |
| The browser runs out of storage | The recording stops with a message and is kept up to that moment |
| Trama's tab is closed, or the browser crashes | On the next visit the recording is listed under **Còpies al navegador**; **Recupera** repairs it (the cut-off tail is dropped) and it plays up to the cut |
| Not enough free space for the repair, or the repair fails | The video is offered unrepaired, with a warning: it plays, but without a duration and with unreliable seeking |
| The MP4 conversion fails (for example an encoder error) | The WebM is kept untouched and a message is shown; the conversion can be tried again |
| The MP4 conversion is cancelled | Back to the recording; nothing is left at the chosen location |

## Known limitations

- The repair needs free space for a second copy while it runs. Without it, the video is still
  offered and saved, unrepaired, with a warning.
- The browser copy is deleted by hand (**Esborra la còpia del navegador**) after saving.
- **Desa en MP4** re-encodes the whole video, so it takes a while on long recordings (2–2½-hour
  recordings took 9–17 minutes on the Macs tested) and Trama's tab must stay open. Where
  the browser has no AAC encoder, the MP4 keeps Opus audio (VLC and browsers play it;
  QuickTime may not). The MP4 has its index at the end, which only matters when streaming it
  from a web server.
- **Desa en MP4** keeps the sound on the WebM's recorded timing: where the recording has a gap,
  or the tab's audio clock ran slower than the computer's, silence is inserted; where it ran
  faster, a little audio is skipped. Each correction brings the sound back within 20 ms of
  where it was recorded and fades in and out (2.5 ms, less in very short chunks), so it should
  not click: 60-minute test recordings in Chrome and Edge had no clicks in the MP4. Builds
  before v0.1 could click there (a skip of 57.5 ms or more, or silence inserted into a very
  short chunk, had no fade). The log's `mp4.audioRetime` counts the corrections and lists
  where they fall. On the Mac the clocks agree closely (0.12–0.31 % on the test VM: about one
  25 ms correction every 5–20 s).
- AAC: the MP4 skips the encoder's 2112-frame priming with an edit list. 2112 is the delay of
  Apple's encoder, which Chrome and Edge use on macOS; Windows' encoder is untested, and a
  different delay there would put the sound a few tens of milliseconds early or late.
- Choosing to replace an existing file in the save dialog empties it straight away (Chrome and
  Edge do this, not Trama), so cancelling or failing the save afterwards loses the old file.

Seen only on the macOS test VM, whose hardware codecs fail now and then (each passed on its
one retry):

- One MP4 conversion failed with an `EncodingError`. Trama kept the WebM and showed a message.
  If this happens on a real Mac, the converter could retry with the software encoder.
- The MP4's first flash came 50–95 ms late in some runs: the hardware encoder made the first
  white frame slightly grey. Sync was otherwise unaffected.

## Extension or native capture: proposal

**Not needed for now.** The brief (§6) asks whether a web page captures a tab and its sound
reliably enough, and otherwise suggests a Chrome extension using `tabCapture`, or a native
macOS component with ScreenCaptureKit if the Teams desktop app must be recorded. The web page
has met the criteria set at the decision gate (PLAN §5.2, decided 2026-11-15):

- 2-hour recordings with the window minimised the whole time, without gaps, memory growth or
  drift (Chrome's background throttling does not affect it: recording and writing are driven
  by the recorder's own events and a worker, not by timers);
- recovery of a cut recording after the tab closes;
- picture and sound within 0.1 s at every marker over 2 hours.

An extension would be worth building only if one of these shows up with real Teams or real
users:

- recordings in a background tab losing picture or sound, or stalling, in a way the page
  cannot avoid;
- the picker or the "Share tab audio" box causing recordings without sound in practice
  (an extension can capture the current tab's sound without the picker);
- a need to record without Trama's tab staying open.

A native component is the only way to record the Teams desktop app, and would be considered
only if that becomes a requirement. The first opportunity to revisit this is the postponed
session with real Teams.
