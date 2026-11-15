<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo/trama-lockup-dark.svg">
    <img src="docs/brand/logo/trama-lockup.svg" alt="Trama" width="240">
  </picture>
</h1>

**English** · [Català](README.ca.md) · [Castellano](README.es.md)

*Trama* is Catalan and Spanish for the weft of a fabric, and for the plot of a story. The weft
is the thread that crosses the warp and, woven tight, makes a mesh that holds what passes
through it. Trama is a browser app that casts that mesh over video: it catches a meeting as it
happens (video and tab audio), then weaves in transcripts, subtitles and translations so that
nothing said slips through and the plot can always be followed.

**Status:** early development. The site runs a test prototype of the first feature, recording a
meeting: it records a tab with its audio, repairs the file so it can be seeked, and saves it as
WebM or MP4. It has been checked by hand in Chrome and Edge on macOS, with recordings of up to
two and a half hours; it is not the final version.

## What it will do

| Phase | Feature |
| --- | --- |
| 1 | Record a Teams meeting open in a Chrome or Edge tab (video and tab audio) and save it on your own computer, as WebM or converted to MP4 in the browser |
| 2 | Import recordings; transcribe them (Catalan first, then Spanish) with timestamps; search and jump to a moment in the video |
| 3 | Edit subtitles (SRT/VTT), translate them into Catalan keeping the timings, show both languages side by side |
| 4 | Burned-in subtitles and more export formats |

Trama is web-only: it records meetings open in a Chrome or Edge tab. The Teams desktop app
cannot be recorded; join the meeting in the browser instead.

The full plan is in [docs/PLAN.md](docs/PLAN.md); the original phase 1 brief (in Spanish) is in
[docs/spec/](docs/spec/especificacion_mvp_grabador_reuniones.md).

## Privacy

Recording happens entirely in your browser. The recording is never uploaded: the page's
Content-Security-Policy (`connect-src 'self'`) stops the browser from sending data anywhere
else, and its Permissions-Policy blocks the microphone and the camera. Only the tab you choose
to share is captured. Converting to MP4 also happens in the browser.

## Development

Requires Node 24. If Node isn't installed, run the same commands in a container:

```sh
docker run --rm -it -u "$(id -u):$(id -g)" -e HOME=/tmp/home \
  -p 127.0.0.1:5173:5173 \
  -v "$PWD:/work" -w /work node:24-slim npm run dev
```

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | Start the dev server on port 5173 |
| `npm run build` | Type-check and build the static site into `dist/` |
| `npm run preview` | Serve `dist/` with the production security headers |
| `bash scripts/test.sh` | Type-check and run the tests (Node unit tests and headless Chromium) in the Playwright container, without network |

Screen capture needs a secure context: open the dev server at `http://localhost:5173` (for
example through an SSH or VS Code port forward), not by the server's IP address.

## Deployment

The site is a static Vite build served by nginx in a Docker container, behind Caddy.

| | Production | Preview |
| --- | --- | --- |
| Branch | `main` | `preview` |
| Checkout | `/srv/apps/trama` | `/srv/apps/trama-preview` (git worktree) |
| Deploy | `bash scripts/deploy_production.sh` | `bash scripts/deploy_preview.sh` |
| Local port | 8099 | 8100 |

The deploy scripts refuse uncommitted changes, build the image, and write
`build-meta/build-info.json` (commit, build time and latest GitHub release), which the site
serves at `/build-info.json`. Always pass `-f <compose file>` to `docker compose`.

## Project layout

```text
src/             app source (TypeScript)
public/          static files copied as-is
deploy/          nginx config and security headers
scripts/         deploy, build-info, test and log-summary scripts
tests/           Playwright tests: unit/ (Node), e2e/ (headless Chromium), fixtures/
docs/            plan, original brief and manual test results
docs/brand/      brand pack: logo masters, colour and usage guide
```
