# Trama — brand brief

## The name

*Trama* is a word in Catalan and Spanish with two meanings:

- the **weft** of a fabric: the threads that run across the warp and bind it into cloth;
- the **plot** of a story: what happens, in order.

Both fit. The app weaves separate tracks into one piece (video, audio, a transcript, subtitles,
translations), and what it works with is a recording of something that happened, which you
later want to follow, search and retell. The name is written "Trama", with a capital T and no
other styling.

## What it is

Trama is a web app for working with video, and it runs entirely in the browser. There is
nothing to install and no account. It is being built in phases.

**Phase 1, now in development: recording a meeting.** You open a Microsoft Teams meeting in a
Chrome or Edge tab, open Trama in another tab and press record. The browser asks which tab to
share; you choose the meeting, and Trama records its picture and sound while you go on
listening and working in other windows. When you stop, you can play the recording back, name
it and save it as a video file on your own computer.

It records only the tab you choose. It never turns on your microphone or camera, and it never
sends the recording anywhere.

**What comes next:**

| Phase | What it adds |
| --- | --- |
| 2 | Bring in existing recordings. Transcribe them, Catalan first, with timestamps; search the transcript and jump to that moment in the video. |
| 3 | Edit subtitles; translate them into Catalan while keeping the timing; show both languages side by side; export subtitle files. |
| 4 | Subtitles burned into the video, more export formats, and other ways to get video in and out. |

The arc goes from capturing a moment, to understanding it (transcript, search), to making it
readable by others (subtitles, translation).

## Who it's for

People who need a faithful record of an online meeting or class and want to work with it
afterwards: find what was said, quote it, subtitle it, translate it. The interface is in
**Catalan** first, and the content it focuses on is Catalan too: Catalan is the first
transcription language and the target of translation.

## Aim and philosophy

**Your recording is yours.** Recording happens on your computer and the file stays there. This
is enforced by the page itself, not just promised: the site's security policy stops the
browser from sending data anywhere else and blocks the microphone and camera. If a later
feature ever needs a server (for example, higher-quality transcription), it will ask first and
say exactly what leaves the computer.

**Capture only what you chose.** One tab, its picture and its sound. Nothing from you, nothing
in the background.

**Honest about what it's doing.** If the shared tab has no sound, Trama says so plainly and
doesn't pretend the recording is complete. While recording, it is always obvious that it is
recording, for how long, and whether sound is coming through.

**Reliable before clever.** A two-hour meeting is recorded once and can't be repeated, so the
first priority is that recording doesn't fail, and that if the tab crashes, what was recorded
up to that point can be recovered.

**Small and quiet.** A few clear controls, plain language, no clutter. The app should feel
like a dependable tool, closer to a well-made tape recorder than to a media platform.

**Catalan first.** Built for Catalan speakers and Catalan content, from the interface to the
transcription and translation targets.

## Personality

Calm, trustworthy, careful, crafted. A tool you rely on, not a product that wants your
attention. Warm rather than corporate; precise rather than flashy.

What it is **not**: a cloud service, an "AI" product with sparkles and gradients, a
social or streaming platform, or anything that looks like it belongs to Microsoft. Teams is
just the first thing it records; the brand shouldn't borrow its look or name.

## Starting points for the visual identity

These are ideas to explore, not requirements.

- **Weaving:** threads crossing, warp and weft, a woven grid. Tracks as parallel threads
  (video, sound, text, a second language) bound together.
- **Timeline and story:** a line through time, a thread you can follow and pick up at any
  point, as you can in a transcript.
- **A recording that stays home:** local, contained, kept.

## Practical constraints

- **Light and dark themes.** The app follows the system setting, so colours and the logo must
  work on both.
- **Small sizes.** The mark has to read as a browser tab icon (favicon, 16–32 px) and in a
  GitHub avatar, as well as at large sizes.
- **Red is taken.** A red dot means "recording" in the interface, the convention people
  already know. The brand colour should leave room for that signal and not be confused with it.
- **States to design for:** ready to record, recording (indicator, stopwatch, sound status),
  stopped (player, file name, save button), warnings (no sound, sharing stopped, low disk
  space), and recovering a recording after a crash.
- **Accented text.** The interface is in Catalan, so typefaces need full Latin coverage
  (à, è, é, í, ï, ò, ó, ú, ü, ç, and the middle dot in "l·l").
- **Lightweight.** It's a static web app with no framework. Fonts and assets should be few
  and small; a well-chosen system font stack is acceptable.

## What exists today

A placeholder page with the word "Trama" and "En construcció" ("Under construction") on a
warm off-white background (`#f6f5f2`) with near-black text (`#23262b`), or the dark
equivalents. These are placeholders, not decisions, and the brand can replace them.
