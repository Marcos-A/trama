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

**Estado:** v0.1, la primera versión de la fase 1: la grabación de reuniones. Trama graba una
pestaña de Chrome o Edge con su audio, repara el archivo para que se pueda avanzar y
retroceder, y lo guarda en WebM o MP4. Se ha probado en macOS con la captura real de pestañas
de Chrome y una pestaña que hace de reunión (pruebas automáticas, de hasta dos horas con la
ventana minimizada) y a mano con pestañas normales (hasta dos horas y media), pero todavía no
con una reunión real de Teams. Lo que aún no se ha probado y las limitaciones conocidas están
en [docs/limitations.md](docs/limitations.md) (en inglés).

## Qué hará

| Fase | Función |
| --- | --- |
| 1 | Grabar una reunión de Teams abierta en una pestaña de Chrome o Edge (vídeo y audio de la pestaña) y guardarla en tu ordenador, en WebM o convertida a MP4 en el propio navegador |
| 2 | Importar grabaciones; transcribirlas (primero en catalán y después en castellano) con marcas de tiempo; buscar y saltar a un momento del vídeo |
| 3 | Editar subtítulos (SRT/VTT), traducirlos al catalán manteniendo los tiempos, mostrar los dos idiomas uno al lado del otro |
| 4 | Subtítulos incrustados y más formatos de exportación |

Trama funciona solo en el navegador: graba reuniones abiertas en una pestaña de Chrome o Edge.
No puede grabar la aplicación de escritorio de Teams; en ese caso, entra en la reunión desde el navegador.
Solo se ha probado con Chrome y Edge de escritorio, que son los navegadores que recomienda la aplicación;
Firefox y Safari no pueden grabar el audio de una pestaña, y por eso en ellos la grabación está desactivada.

## Cómo grabar una reunión

1. Entra en la reunión en una pestaña de Chrome o Edge.
2. Abre <https://trama.marcos-a.com> en otra pestaña y pulsa **Grava una pestanya** (la
   interfaz está en catalán).
3. En el diálogo del navegador, elige la pestaña de la reunión y deja activada la opción de
   compartir el audio de la pestaña. Si la pestaña no envía sonido, Trama muestra **Sense so**.
4. Deja abierta la pestaña de Trama; puede quedar en segundo plano. Pulsa **Atura** para
   terminar, comprueba la grabación en el reproductor y guárdala con **Desa el vídeo** (WebM) o
   **Desa en MP4**.
5. Cuando ya tengas el archivo guardado, **Esborra la còpia del navegador** libera el espacio.
   Si la pestaña se cierra a mitad de grabación, la próxima vez la encontrarás en **Còpies al
   navegador**.

Trama nunca graba el micrófono, así que tu voz no sale en la grabación.

El plan completo está en [docs/PLAN.md](docs/PLAN.md) (en inglés); el encargo original de la
fase 1 está en [docs/spec/](docs/spec/especificacion_mvp_grabador_reuniones.md).

## Privacidad

La grabación se hace por completo en el navegador y nunca se sube a ningún sitio: la
Content-Security-Policy de la página (`connect-src 'self'`) impide que el navegador envíe datos
a ningún otro lugar, y la Permissions-Policy bloquea el micrófono y la cámara. Solo se captura
la pestaña que eliges compartir. La conversión a MP4 también se hace en el navegador.

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
docs/            plan, encargo original, resultados de las pruebas manuales y registro de limitaciones
docs/brand/      paquete de marca: originales del logotipo, colores y guía de uso
```

## Licencia

Copyright © 2026 Marcos Alcocer-Gil.

Trama es software libre: puedes redistribuirlo y modificarlo según los términos de la
[Licencia Pública General Affero de GNU](LICENSE), versión 3 o (si lo prefieres) cualquier
versión posterior. Se distribuye sin ninguna garantía.

El nombre y el logotipo de Trama (`docs/brand/`, `public/logo/`, `public/icons/`,
`public/favicon.ico`) no están cubiertos por esta licencia; las bifurcaciones deben usar un
nombre y un logotipo propios.

## Nota sobre el desarrollo

Este proyecto se ha desarrollado bajo dirección y revisión humanas, con el apoyo de
herramientas de inteligencia artificial para partes del código, la depuración y la
documentación. Las decisiones sobre el funcionamiento del sistema, y la responsabilidad del
resultado final, corresponden al mantenedor del proyecto.
