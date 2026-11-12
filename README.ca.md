<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo/trama-lockup-dark.svg">
    <img src="docs/brand/logo/trama-lockup.svg" alt="Trama" width="240">
  </picture>
</h1>

[English](README.md) · **Català** · [Castellano](README.es.md)

La *trama* d'un teixit són els fils que s'entrecreuen amb l'ordit i formen una malla que reté
el que hi passa; la d'una història és l'argument. Trama és una aplicació web que estén aquesta
malla sobre el vídeo: atrapa una reunió mentre té lloc (vídeo i àudio de la pestanya) i hi
entreteixeix transcripcions, subtítols i traduccions perquè no s'escapi res del que s'hi diu i
no se'n perdi mai el fil.

**Estat:** en desenvolupament inicial. El lloc mostra una pàgina provisional; s'està
construint la primera funció, la gravació de reunions.

## Què farà

| Fase | Funció |
| --- | --- |
| 1 | Gravar una reunió de Teams oberta en una pestanya de Chrome o Edge (vídeo i àudio de la pestanya) i desar-la al teu ordinador, en WebM o convertida a MP4 al mateix navegador |
| 2 | Importar gravacions; transcriure-les (primer en català i després en castellà) amb marques de temps; cercar i saltar a un moment del vídeo |
| 3 | Editar subtítols (SRT/VTT), traduir-los al català mantenint els temps, mostrar les dues llengües una al costat de l'altra |
| 4 | Subtítols incrustats i més formats d'exportació |

El pla complet és a [docs/PLAN.md](docs/PLAN.md) (en anglès); l'encàrrec original de la fase 1
(en castellà) és a [docs/spec/](docs/spec/especificacion_mvp_grabador_reuniones.md).

## Privadesa

La gravació es fa completament al navegador i no es puja mai enlloc: la
Content-Security-Policy de la pàgina (`connect-src 'self'`) impedeix que el navegador enviï
dades a cap altre lloc, i la Permissions-Policy bloqueja el micròfon i la càmera. Només es
captura la pestanya que tries compartir. La conversió a MP4 també es fa al navegador.

## Desenvolupament

Cal Node 24. Si no tens Node instal·lat, executa les mateixes ordres en un contenidor:

```sh
docker run --rm -it -u "$(id -u):$(id -g)" -e HOME=/tmp/home \
  -p 127.0.0.1:5173:5173 \
  -v "$PWD:/work" -w /work node:24-slim npm run dev
```

| Ordre | Què fa |
| --- | --- |
| `npm install` | Instal·la les dependències |
| `npm run dev` | Inicia el servidor de desenvolupament al port 5173 |
| `npm run build` | Comprova els tipus i genera el lloc estàtic a `dist/` |
| `npm run preview` | Serveix `dist/` amb les capçaleres de seguretat de producció |
| `bash scripts/test.sh` | Comprova els tipus i executa les proves (proves unitàries amb Node i Chromium sense interfície) al contenidor de Playwright, sense xarxa |

La captura de pantalla necessita un context segur: obre el servidor de desenvolupament a
`http://localhost:5173` (per exemple, amb una redirecció de port d'SSH o de VS Code), no per
l'adreça IP del servidor.

## Desplegament

El lloc és una compilació estàtica de Vite servida per nginx en un contenidor Docker, darrere
de Caddy.

| | Producció | Previsualització |
| --- | --- | --- |
| Branca | `main` | `preview` |
| Còpia de treball | `/srv/apps/trama` | `/srv/apps/trama-preview` (git worktree) |
| Desplegament | `bash scripts/deploy_production.sh` | `bash scripts/deploy_preview.sh` |
| Port local | 8099 | 8100 |

Els scripts de desplegament rebutgen canvis sense confirmar, construeixen la imatge i escriuen
`build-meta/build-info.json` (commit, hora de compilació i darrera versió publicada a GitHub),
que el lloc serveix a `/build-info.json`. Passa sempre `-f <fitxer compose>` a
`docker compose`.

## Estructura del projecte

```text
src/             codi de l'aplicació (TypeScript)
public/          fitxers estàtics que es copien tal qual
deploy/          configuració de nginx i capçaleres de seguretat
scripts/         scripts de desplegament, d'informació de compilació, de proves i de resum de registres
tests/           proves de Playwright: unit/ (Node), e2e/ (Chromium sense interfície), fixtures/
docs/            pla i encàrrec original
docs/brand/      paquet de marca: originals del logotip, colors i guia d'ús
```
