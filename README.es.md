<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo/trama-lockup-dark.svg">
    <img src="docs/brand/logo/trama-lockup.svg" alt="Trama" width="240">
  </picture>
</h1>

[English](README.md) · [Català](README.ca.md) · **Castellano**

La *trama* de un tejido son los hilos que se cruzan con la urdimbre y forman una malla que
retiene lo que pasa por ella; la de una historia es su argumento. Trama es una aplicación web
que tiende esa malla sobre el vídeo: atrapa una reunión mientras sucede (vídeo y audio de la
pestaña) y le entreteje transcripciones, subtítulos y traducciones para que no se escape nada de
lo que se dice y nunca se pierda el hilo.

**Estado:** en desarrollo inicial. El sitio muestra una página provisional; se está
construyendo la primera función, la grabación de reuniones.

## Qué hará

| Fase | Función |
| --- | --- |
| 1 | Grabar una reunión de Teams abierta en una pestaña de Chrome o Edge (vídeo y audio de la pestaña) y guardarla en tu ordenador |
| 2 | Importar grabaciones; transcribirlas (primero en catalán y después en castellano) con marcas de tiempo; buscar y saltar a un momento del vídeo |
| 3 | Editar subtítulos (SRT/VTT), traducirlos al catalán manteniendo los tiempos, mostrar los dos idiomas uno al lado del otro |
| 4 | Subtítulos incrustados y más formatos de exportación (MP4 convertido a partir de un WebM guardado) |

El plan completo está en [docs/PLAN.md](docs/PLAN.md) (en inglés); el encargo original de la
fase 1 está en [docs/spec/](docs/spec/especificacion_mvp_grabador_reuniones.md).

## Privacidad

La grabación se hace por completo en el navegador y nunca se sube a ningún sitio: la
Content-Security-Policy de la página (`connect-src 'self'`) impide que el navegador envíe datos
a ningún otro lugar, y la Permissions-Policy bloquea el micrófono y la cámara. Solo se captura
la pestaña que eliges compartir.

## Desarrollo

Requiere Node 24. Si no tienes Node instalado, ejecuta los mismos comandos en un contenedor:

```sh
docker run --rm -it -u "$(id -u):$(id -g)" -e HOME=/tmp/home \
  -p 127.0.0.1:5173:5173 \
  -v "$PWD:/work" -w /work node:24-slim npm run dev
```

| Comando | Qué hace |
| --- | --- |
| `npm install` | Instala las dependencias |
| `npm run dev` | Inicia el servidor de desarrollo en el puerto 5173 |
| `npm run build` | Comprueba los tipos y genera el sitio estático en `dist/` |
| `npm run preview` | Sirve `dist/` con las cabeceras de seguridad de producción |
| `bash scripts/test.sh` | Comprueba los tipos y ejecuta las pruebas (pruebas unitarias con Node y Chromium sin interfaz) en el contenedor de Playwright, sin red |

La captura de pantalla necesita un contexto seguro: abre el servidor de desarrollo en
`http://localhost:5173` (por ejemplo, con una redirección de puerto de SSH o de VS Code), no
por la dirección IP del servidor.

## Despliegue

El sitio es una compilación estática de Vite servida por nginx en un contenedor Docker, detrás
de Caddy.

| | Producción | Previsualización |
| --- | --- | --- |
| Rama | `main` | `preview` |
| Copia de trabajo | `/srv/apps/trama` | `/srv/apps/trama-preview` (git worktree) |
| Despliegue | `bash scripts/deploy_production.sh` | `bash scripts/deploy_preview.sh` |
| Puerto local | 8099 | 8100 |

Los scripts de despliegue rechazan cambios sin confirmar, construyen la imagen y escriben
`build-meta/build-info.json` (commit, hora de compilación y última versión publicada en
GitHub), que el sitio sirve en `/build-info.json`. Pasa siempre `-f <fichero compose>` a
`docker compose`.

## Estructura del proyecto

```text
src/             código de la aplicación (TypeScript)
public/          ficheros estáticos que se copian tal cual
deploy/          configuración de nginx y cabeceras de seguridad
scripts/         scripts de despliegue, de información de compilación, de pruebas y de resumen de registros
tests/           pruebas de Playwright: unit/ (Node), e2e/ (Chromium sin interfaz), fixtures/
docs/            plan y encargo original
docs/brand/      paquete de marca: originales del logotipo, colores y guía de uso
```
