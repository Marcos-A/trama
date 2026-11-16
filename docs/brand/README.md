# Trama — brand pack v2 · “mesh & plot”

Integration guide for the Trama web app (static, no framework). Brand pack v2 replaced v1 (the
“woven T”) completely on 2026-11-16; no v1 assets remain in the repository.

## Where the pack lives in this repository

| Pack path | Repository path | Why |
| --- | --- | --- |
| `css/tokens.css` | `src/tokens.css` | imported by `src/main.ts`, bundled by Vite |
| `icons/favicon.ico` | `public/favicon.ico` | root path, where browsers look by default |
| `icons/manifest.webmanifest` | `public/manifest.webmanifest` | icon paths made absolute (`/icons/…`) |
| `icons/*` (the rest) | `public/icons/` | served at `/icons/` |
| `logo/trama-mark-small(-dark).svg` | `public/logo/` | app header; add other logo files there when the app uses them |
| `logo/`, `motif/`, `avatar/`, `social/` | `docs/brand/` | masters for the READMEs and GitHub settings; not shipped |

Section 1 below lists the pack as it was delivered.

## 0. The idea, in one paragraph (for copy, about page, README)

*Trama* is Catalan and Spanish for the **weft** of a fabric and for the **plot** of a story. In
weaving, the weft is one thread passed back and forth through the warp; row by row, it becomes a
mesh that holds what passes through it. The mark is exactly that: three indigo warps (*ordit*) and
one saffron weft (*trama*) in a real over-under weave. Seen whole it is a net, so nothing in the
video slips through; followed with a finger it is a story with a beginning, three passes and an
end. Trama works with any video (a meeting, a class, a stream): it captures picture and sound,
then weaves in transcripts, subtitles and translations.

## 1. Files

```text
trama-brand/
├── css/tokens.css                   colour, type, spacing tokens (light + dark via prefers-color-scheme)
├── icons/
│   ├── favicon.svg                  main favicon (indigo tile, weave tuned for 16–32 px)
│   ├── favicon.ico                  16/32/48 fallback
│   ├── favicon-32.png
│   ├── favicon-recording.svg/.ico   red dot, only while recording
│   ├── apple-touch-icon.png         180×180, square (iOS rounds it)
│   ├── icon-192.png, icon-512.png
│   ├── icon-maskable-512.png        weave inside the 80 % safe zone
│   └── manifest.webmanifest         icon paths are relative to this file
├── logo/
│   ├── trama-mark.svg               light-theme colours
│   ├── trama-mark-dark.svg          dark-theme colours
│   ├── trama-mark-auto.svg          switches with prefers-color-scheme (use as <img>)
│   ├── trama-mark-mono.svg          currentColor (inline it to inherit text colour)
│   ├── trama-mark-small(-dark).svg  wider crossing gaps; use when shown at 40 px or less
│   ├── trama-lockup*.svg            mark + wordmark (same four colour variants)
│   └── trama-wordmark.svg           “Trama” outlined, currentColor
├── motif/trama-weave*.svg           the weave pattern (light / dark / auto / mono)
├── avatar/github-avatar-500.png     GitHub org/repo avatar (+ .svg); survives the circle crop
└── social/github-social-preview.png 1280×640 → GitHub repo Settings → Social preview
```

All SVGs are self-contained: no fonts, no external references, no scripts. The wordmark is
outlined from Inter Display SemiBold (SIL OFL), so no font file ships with the app.

## 2. `<head>` snippet

As used in `index.html`. `tokens.css` is not linked here: `src/main.ts` imports it.

```html
<html lang="ca">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Trama</title>
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#F6F5F2" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#16171A" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" href="/icons/favicon.svg" type="image/svg+xml" id="favicon">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.webmanifest">
</head>
```

**CSP:** all brand assets are same-origin, so they need only `img-src 'self'` and
`manifest-src 'self'` (both covered by `default-src 'self'`). The manifest sits at the site root
and its icon paths are absolute (`/icons/…`). Don't use `data:` URLs for the favicon swap; swap the `href` to the shipped
file (below). Any network permission the YouTube feature needs is separate from the brand and
should be as narrow as that feature allows.

## 3. Recording state in the browser tab

The brand steps aside for the signal:

```js
const favicon = document.getElementById('favicon');
function setRecordingTab(isRecording, elapsed /* "00:42" */) {
  favicon.href = isRecording ? '/icons/favicon-recording.svg' : '/icons/favicon.svg';
  document.title = isRecording ? `● ${elapsed} · Trama` : 'Trama';
}
```

Update the title at most once a second.

## 4. Logo in the app header

As used in `index.html`: the `-small` mark (it is shown below 40 px), in a `<picture>` so dark
mode gets the dark variant.

```html
<a class="marca" href="/" aria-label="Trama">
  <picture>
    <source srcset="/logo/trama-mark-small-dark.svg" media="(prefers-color-scheme: dark)">
    <img src="/logo/trama-mark-small.svg" width="24" height="24" alt="">
  </picture>
  <span>Trama</span>
</a>
```

```css
.marca { display: inline-flex; align-items: center; gap: 10px;
         font-weight: 600; font-size: 1.125rem; letter-spacing: -0.02em;
         color: var(--tinta); text-decoration: none; }
.marca img { display: block; }
```

In the UI the name is set in the system font, matching the interface. Use the outlined
`trama-lockup*.svg` where the exact wordmark matters: README, about page, social card.

### Logo rules

- Clear space: one row (a quarter of the mark's width) on every side. Minimum size 16 px (mark), 100 px wide (lockup).
- Below 40 px use the `-small` mark (or the favicon tile), whose crossing gaps survive downscaling.
- Never break the saffron weft, recolour the warps saffron, use red, add gradients or glows, outline,
  stretch or rotate it. The plot reads left to right, top to bottom.

## 5. Colour roles

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--lli` | `#F6F5F2` | `#16171A` | page ground |
| `--superficie` | `#FFFFFF` | `#1F2125` | cards, inputs, panels |
| `--tinta` | `#23262B` | `#ECEAE4` | text, Stop button |
| `--fum` | `#5B5F66` | `#A3A6AD` | secondary text |
| `--indi` | `#33407A` | `#9AA8E0` | **ordit / warp**: structure, played timeline, tracks, primary action, links, focus |
| `--safra` / `--safra-text` | `#B07A1E` / `#8A5A12` | `#E0B25C` | **trama / weft**: “look here” — search hits (knots), current transcript line, 2nd language, warnings |
| `--malla` | `#A4ABD0` | `#4E5788` | **mesh at rest**: unplayed timeline, tracks not made yet. Decoration only, never text |
| `--gravant` | `#C4352B` | `#F0645A` | **only** the live-recording indicator |

Rules:

- One indigo primary action per screen.
- Red means “recording is live” and nothing else. Errors and warnings use saffron and words.
- Stop is neutral (ink outline + square icon), never red: stopping is safe.
- `--safra` is too light for text on the light ground; use `--safra-text` for words.

## 6. Type

- Interface: `var(--font-ui)` (system stack, full Catalan coverage including `l·l`).
- Time (stopwatch, timestamps, durations): `.temps` → `var(--font-temps)` with tabular figures, so digits don't jitter.
- Scale 13 / 16 / 20 / 25 / 31 px, stopwatch 64 px. Weights 400 and 600 only.

## 7. The weave motif

`motif/trama-weave*.svg`: five tracks (from top: vídeo, so, transcripció, subtítols, traducció)
bound by one saffron thread. Use it large and alone: empty states, about page, README header,
loading/processing screens. Never behind controls or text. Add labels in HTML next to it if needed.

In the product the metaphor becomes literal:

- **Timeline** = a warp thread: played part `--indi`, unplayed `--malla`, playhead `--tinta`.
- **Search hits** = saffron *knots* on the timeline (16–20 px circle, `--safra`, 4 px ring in `--lli`),
  and `<mark class="nus">` in the transcript text.
- **Tracks panel** = one row per thread (Imatge, So, Transcripció, Subtítols, Traducció): active in
  `--indi`, not yet created in `--malla` with a short status (“Després de gravar”, “Pendent”).

## 8. Screens and copy (Catalan)

One centred column (`--amplada-app`, 560 px) for capture; transcript and subtitle views can widen to 960 px.

| State | Header pill | Content | Primary action |
| --- | --- | --- | --- |
| Ready | “Preparat” | “Preparat per gravar”; how-to: “Quan premis Grava, tria la pestanya que vols gravar i marca l’opció de compartir-ne l’àudio.”; privacy line | **Grava** (indigo, small red dot icon) |
| Recording | red dot + “Gravant” | red dot + stopwatch; tracks panel (Imatge, So with live meter); tab name; size | **Atura** (ink outline, square icon) |
| Recording, no sound | same | So row replaced by saffron “Sense so · Només imatge” + how to fix | Atura |
| Converting | “Convertint” | “Convertint a MP4…” + determinate progress bar in `--indi` over `--malla`, percentage in `.temps` | “Cancel·la” (secondary) |
| Stopped / ready to save | “Aturat · 01:12:40” | player; “Nom del fitxer” input with `.mp4` suffix | **Desa el vídeo** (indigo, download icon) + “Descarta” link |
| Transcribing | “Transcrivint” | progress as time: “Transcrivint… 00:12:31 de 01:12:40” | “Atura la transcripció” (secondary) |
| Transcript | — | timeline with knots; search field “Cerca a la transcripció”; lines with timestamp links | context-dependent (Exporta / Descarrega els subtítols, later) |
| Recovery | “Recuperació” | “Hi ha una gravació sense desar”: duration, name, last time saved | **Recupera la gravació** + “Descarta” |

Warnings: saffron panel, icon, bold title, one sentence with the consequence, then the fix.

- **Sense so** — La pestanya compartida no té so. La gravació només tindrà imatge.
- **S’ha deixat de compartir** (neutral panel) — La gravació s’ha aturat a 00:42:17. El que s’ha gravat fins ara està a punt per desar.
- **Queda poc espai** — Al disc hi cap uns 20 minuts més de gravació.

Privacy lines (state only what is true for the build you ship):

- Capture: *Només es grava la pestanya que triïs. El micròfon i la càmera no s’activen mai. El que graves es queda al teu ordinador.*
- YouTube transcript capture (show before the first request): say exactly what is sent and to whom,
  e.g. *Per obtenir la transcripció, Trama es connecta a YouTube amb l’adreça del vídeo. No s’envia res del teu ordinador.* Adjust the wording to the actual implementation.

> Check: the how-to line paraphrases Chrome's “share tab audio” option. If you quote it, use the
> exact label in Chrome/Edge's Catalan UI.

## 9. Voice

Plain, calm, exact. Informal *tu*, short sentences, no exclamation marks, no emoji, no hype. Say
what is happening and what it means for the recording or the file, then what to do. Name sources
generically (“la pestanya”, “el vídeo”), not “la reunió”, since Trama is not limited to meetings.
Core words: **Grava**, **Atura**, **Desa el vídeo**, **Converteix**, **Transcriu**, **Cerca**,
**Recupera**, **Gravant**, **Sense so**.

Taglines for external use (social card, README):
*Imatge, so i text de qualsevol vídeo, teixits al navegador. El que graves es queda al teu ordinador.*

## 10. Accessibility

- Text contrast ≥ 4.5:1 in both themes (ratios in `tokens.css`).
- Buttons ≥ 44 px tall (primary 52 px); icon-only buttons need `aria-label`.
- Progress (conversion, transcription): `<progress>` or `role="progressbar"` with `aria-valuenow`;
  announce start/finish through an `aria-live="polite"` region, never every tick.
- Search hits: the count (“3 coincidències”) in a live region; each knot is a real `<button>` or `<a>`
  with an accessible name like “Coincidència 2, 00:40:58”.
- Decorative SVGs get `alt=""` / `aria-hidden="true"`.
