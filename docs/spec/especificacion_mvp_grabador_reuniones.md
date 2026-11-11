# Especificación técnica — MVP de grabación de reuniones

**Estado:** propuesta para implementación y validación técnica  
**Prioridad:** fase 1, captura fiable de reuniones de Microsoft Teams  
**Plataforma inicial:** aplicación web en Chrome/Edge sobre macOS  
**Principio:** ninguna dependencia de transcripción, traducción o servidor para grabar.

## 1. Objetivo

Permitir que una persona grabe localmente **imagen y audio** de una reunión de Teams, preferentemente abierta en una pestaña del navegador, sin BlackHole, sin capturar micrófono ni cámara y sin subir el contenido a un servidor.

La grabación debe poder durar habitualmente 60–90 minutos, con objetivo de prueba de 120 minutos.

## 2. Alcance del MVP

### Incluido
- Aplicación web con controles **Iniciar**, **Detener** y estado visible de captura.
- Selección explícita de la pestaña de Teams mediante el selector del navegador.
- Captura sincronizada de vídeo y audio de la pestaña cuando el navegador lo permita.
- Monitorización de pista de audio y vídeo, aviso ante interrupciones y contador de duración.
- Grabación en formato WebM, con reproducción de comprobación y guardado local.
- Gestión de errores: permiso denegado, pista sin audio, fin de compartición, espacio insuficiente y cierre inesperado.
- Funcionamiento mientras se trabaja en otra ventana, sujeto a pruebas de renderizado y suspensión de pestañas.

### Excluido
- Captura de micrófono/cámara propios.
- Transcripción, traducción, subtítulos, edición de vídeo y biblioteca persistente avanzada.
- Integración con cuentas o API de Microsoft Teams.
- Captura garantizada del audio de la **aplicación nativa** de Teams.
- Subida automática a la nube o backend de procesamiento.

## 3. Flujo de usuario

1. Abrir Teams en Chrome/Edge y entrar en la reunión.
2. Abrir la aplicación web grabadora en otra pestaña.
3. Pulsar **Iniciar grabación**.
4. En el diálogo del navegador, elegir la pestaña de Teams y habilitar compartir audio.
5. La aplicación verifica que llegan pistas de vídeo y audio; si falta audio, advierte claramente y no presenta la grabación como audiovisual completa.
6. Mostrar estado **Grabando**, duración y opción **Detener**.
7. Al detener, finalizar y cerrar correctamente el archivo; permitir reproducirlo y guardarlo en el equipo.

**Importante:** `getDisplayMedia()` exige una acción del usuario y un selector de captura; la web no puede seleccionar Teams silenciosamente.

## 4. Arquitectura inicial

- **Frontend:** TypeScript + interfaz ligera (sin framework obligatorio).
- **Captura:** `navigator.mediaDevices.getDisplayMedia({video: true, audio: true})`, inspección de `MediaStreamTrack` y manejo de evento `ended`.
- **Codificación:** `MediaRecorder` con comprobación previa de `MediaRecorder.isTypeSupported`, preferentemente WebM VP8/Opus o formato compatible.
- **Persistencia:** no mantener una grabación completa en RAM. Investigar escritura progresiva mediante File System Access API en navegadores compatibles, con permiso del usuario; definir alternativa segura si no está disponible. No asumir que `MediaRecorder` garantiza fragmentos recuperables por sí solos.
- **Estado de grabación:** máquina de estados `idle → requesting → recording → stopping → saved/error`.
- **Procesamiento:** totalmente local; no transmitir el flujo a un backend.

**Riesgo crítico:** la página grabadora debe permanecer abierta; cerrar o recargar la página puede interrumpir la grabación. La recuperación tras fallo debe verificarse, no prometerse.

## 5. Experiencia de usuario

Interfaz minimalista:
- Pantalla inicial: **Grabar pestaña**.
- Durante la sesión: indicador rojo de grabación, cronómetro, estado de audio y botón **Detener**.
- Al finalizar: reproductor, nombre editable y botón **Guardar WebM**.
- Mensajes inequívocos si no hay audio o se detiene la compartición.
- No solicitar permisos de micrófono o cámara.

## 6. Validación técnica obligatoria (spike previo)

Realizar una prueba pequeña **antes** de construir el producto:
1. Chrome en macOS: capturar una pestaña de Teams con pantalla compartida y audio.
2. Edge en macOS: repetir.
3. Cambiar a otras pestañas, minimizar la ventana y trabajar en otras aplicaciones; comprobar que el vídeo continúa actualizándose y el audio no se corta.
4. Verificar que el usuario sigue oyendo la reunión durante la captura.
5. Probar una grabación de 60 minutos y después de 120 minutos, midiendo memoria, tamaño de archivo, sincronización y estabilidad.
6. Probar la selección de ventana de Teams nativa **solo como experimento**; no asumir que el audio de la aplicación se captura.
7. Interrumpir permisos, cerrar la pestaña fuente y simular espacio insuficiente; documentar los resultados.

**Criterio de decisión:** si la web captura pestaña y audio con fiabilidad, continuar con web pura. Si no, evaluar extensión de Chrome (`tabCapture`) como capturador y conservar la aplicación web como interfaz. Si se requiere Teams nativo con audio, evaluar componente macOS con ScreenCaptureKit.

## 7. Criterios de aceptación

- [ ] Graba vídeo y audio reales de una reunión de Teams en pestaña, sin micrófono/cámara.
- [ ] El usuario puede oír la reunión mientras se graba.
- [ ] La grabación sigue funcionando al cambiar a otra aplicación en las condiciones probadas.
- [ ] El archivo resultante se reproduce con imagen y sonido sincronizados.
- [ ] Prueba continua de 90 minutos completada; objetivo adicional de 120 minutos.
- [ ] Se detecta y comunica la ausencia de audio.
- [ ] El archivo se guarda localmente sin subida al servidor.
- [ ] No se retiene el vídeo completo en memoria durante la grabación.
- [ ] Se documentan limitaciones y casos de fallo.

## 8. Seguridad, privacidad y cumplimiento

- Captura iniciada expresamente por el usuario; mostrar indicador permanente.
- Sin telemetría que contenga audio, vídeo o contenido de reuniones.
- No enviar archivos a terceros.
- Informar y obtener las autorizaciones que correspondan según normativa, políticas del centro y confidencialidad; el uso privado no elimina estas obligaciones.
- Si más adelante se usa un servidor, diseñar consentimiento y tratamiento de datos por separado.

## 9. Fases posteriores (fuera del MVP)

**Fase 2:** importar grabaciones existentes, transcripción opcional posterior (prioridad catalán), texto limpio y con marcas temporales, búsqueda y salto desde transcripción al instante del vídeo.

**Fase 3:** editor de subtítulos SRT/VTT, traducción al catalán conservando tiempos, vista bilingüe y exportación.

**Fase 4:** incrustación/quemado de subtítulos, más formatos y posible soporte de aplicación nativa mediante componente local.

## 10. Entregables para el equipo de desarrollo

1. Prueba técnica reproducible de captura de pestaña con audio y resultados de compatibilidad.
2. Código fuente de la aplicación web, README y comandos de ejecución local.
3. Pruebas manuales documentadas, incluida sesión larga.
4. Registro de limitaciones y propuesta fundamentada de evolución a extensión si fuera necesaria.

**Orden de trabajo:** primero demostrar captura fiable; después robustecer escritura y recuperación; finalmente pulir interfaz. No comenzar por IA ni subtítulos.
