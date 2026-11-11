# Trama — brand pack v1

Integration guide for the Trama web app (static, no framework).

## Where the pack lives in this repository

| Pack path | Repository path | Why |
| --- | --- | --- |
| `css/tokens.css` | `src/tokens.css` | imported by `src/main.ts`, bundled by Vite |
| `icons/favicon.ico` | `public/favicon.ico` | root path, where browsers look by default |
| `icons/manifest.webmanifest` | `public/manifest.webmanifest` | icon paths made absolute (`/icons/…`) |
| `icons/*` (the rest) | `public/icons/` | served at `/icons/` |
| `logo/trama-mark-auto.svg` | `public/logo/` | app header; add other logo files there when the app uses them |
| `logo/`, `avatar/`, `social/` | `docs/brand/` | masters for the READMEs and GitHub settings; not shipped |

Section 1 below lists the pack as it was delivered.

## 1. Files

```
trama-brand/
├── css/tokens.css                 colour, type, spacing tokens (light + dark via prefers-color-scheme)
├── icons/
│   ├── favicon.svg                main favicon (indigo tile)
│   ├── favicon.ico                16/32/48 fallback
│   ├── favicon-32.png
│   ├── favicon-recording.svg      red dot, shown only while recording
│   ├── favicon-recording.ico
│   ├── apple-touch-icon.png       180×180, square (iOS rounds it)
│   ├── icon-192.png, icon-512.png
│   ├── icon-maskable-512.png      mark inside the 80 % safe zone
│   └── manifest.webmanifest
├── logo/
│   ├── trama-mark.svg             mark, light-theme colours
│   ├── trama-mark-dark.svg        mark, dark-theme colours
│   ├── trama-mark-auto.svg        switches with prefers-color-scheme (use as <img>)
│   ├── trama-mark-mono.svg        currentColor (inline it to inherit text colour)
│   ├── trama-lockup*.svg          mark + wordmark (same four variants)
│   └── trama-wordmark.svg         “Trama” outlined, currentColor
├── avatar/github-avatar-500.png   GitHub org/repo avatar (+ .svg)
└── social/github-social-preview.png  1280×640 for GitHub → Settings → Social preview
```

All SVGs are self-contained (no fonts, no external references, no scripts). The wordmark is
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

**CSP:** everything is same-origin, so the existing restrictive policy only needs
`img-src 'self'` and `manifest-src 'self'` (both covered by `default-src 'self'`). Do not use
`data:` URLs for the favicon swap — swap the `href` to the shipped file instead (below). The
manifest sits at the site root and its icon paths are absolute (`/icons/…`).

## 3. Recording state in the browser tab

While recording, the brand steps aside for the signal:

```js
const favicon = document.getElementById('favicon');
function setRecordingTab(isRecording, elapsed /* "00:42" */) {
  favicon.href = isRecording ? '/icons/favicon-recording.svg' : '/icons/favicon.svg';
  document.title = isRecording ? `● ${elapsed} · Trama` : 'Trama';
}
```

Update the title at most once a second.

## 4. Using the logo in the app header

```html
<a class="marca" href="/" aria-label="Trama">
  <img src="/logo/trama-mark-auto.svg" width="22" height="22" alt="">
  <span>Trama</span>
</a>
```

```css
.marca { display: inline-flex; align-items: center; gap: 10px;
         font-weight: 600; font-size: 1.125rem; letter-spacing: -0.02em;
         color: var(--tinta); text-decoration: none; }
```

In the UI, the name is set in the system font (matching the interface). Use the outlined
`trama-lockup*.svg` where the exact wordmark matters: README, about page, social card.

**Logo rules:** clear space = 4 grid units (the width of the warp bar plus its gap) on every
side, already included in the 32×32 mark files. Minimum size: 16 px (mark), 80 px wide (lockup).
Never colour any bar red, add gradients/glows/sparkles, rotate, stretch or outline it.

## 5. Colour roles

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--lli` | `#F6F5F2` | `#16171A` | page ground |
| `--superficie` | `#FFFFFF` | `#1F2125` | cards, inputs, panels |
| `--tinta` | `#23262B` | `#ECEAE4` | text, Stop button |
| `--fum` | `#5B5F66` | `#A3A6AD` | secondary text |
| `--indi` | `#33407A` | `#9AA8E0` | the one primary action per screen, links, sound meter, focus |
| `--safra` / `--safra-text` | `#B07A1E` / `#8A5A12` | `#E0B25C` | mark weft; warnings (no sound, low disk); 2nd-language track later |
| `--gravant` | `#C4352B` | `#F0645A` | **only** the live-recording indicator |

Rules:
- Red means “recording is live” and nothing else. Errors and warnings use saffron + text.
- Stop is neutral (ink outline + square icon), never red: stopping is safe.
- Saffron `--safra` is too light for text on the light ground; use `--safra-text` for words.

## 6. Type

- Interface: `var(--font-ui)` (system stack, full Catalan coverage incl. `l·l`).
- Time (stopwatch, timestamps): `.temps` → `var(--font-temps)` with tabular numbers, so digits
  don't jitter.
- Scale: 13 / 16 / 20 / 25 / 31 px, stopwatch 64 px. Weights 400 and 600 only.

## 7. Phase 1 screens (one centred column, max `--amplada-app` = 560 px)

| State | Header pill | Main content | Primary action |
| --- | --- | --- | --- |
| Ready | “Preparat” | title “Preparat per gravar”, how-to line, privacy line with lock icon | **Grava** (indigo, small red dot icon) |
| Recording | red dot + “Gravant” | red dot + stopwatch `00:42:17`; sound panel with live meter (“Arriba so de la pestanya”); tab name; file size | **Atura** (ink outline, square icon) |
| Recording, no sound | same | sound panel replaced by saffron “Sense so · Només imatge” + how to fix | Atura |
| Stopped | “Aturat · 01:12:40” | video player; “Nom del fitxer” input with extension suffix | **Desa el vídeo** (indigo, download icon) + “Descarta” link |
| Recovery | “Recuperació” | “Hi ha una gravació sense desar”: duration, name, last time saved | **Recupera la gravació** + “Descarta” |

Warning banners (saffron panel, icon, bold title, one sentence with the consequence, then the fix):
- **Sense so** — La pestanya compartida no té so. La gravació només tindrà imatge.
- **S’ha deixat de compartir** — neutral panel: La gravació s’ha aturat a 00:42:17. El que s’ha gravat fins ara està a punt per desar.
- **Queda poc espai** — Al disc hi cap uns 20 minuts més de gravació.

Privacy line (Ready screen): *Només es grava la pestanya que triïs. El micròfon i la càmera no
s’activen mai, i res no surt del teu ordinador.*

> Check: the how-to line quotes Chrome's “share tab audio” checkbox as “Comparteix també
> l’àudio”. Match it to the exact label in Chrome/Edge's Catalan UI before shipping.

## 8. Voice

Plain, calm, exact. Informal *tu*, short sentences, no exclamation marks, no emoji, no hype.
Say what is happening and what it means for the recording, then what to do.
Core words: **Grava**, **Atura**, **Desa el vídeo**, **Recupera**, **Gravant**, **Sense so**.

## 9. Accessibility

- Text contrast ≥ 4.5:1 in both themes (ratios in `tokens.css`).
- Buttons ≥ 44 px tall (primary 52 px); icon-only buttons need `aria-label`.
- Announce state changes (recording started/stopped, no sound) through an `aria-live="polite"`
  region; don't announce every stopwatch tick.
- Decorative SVGs get `aria-hidden="true"` / `alt=""`.
