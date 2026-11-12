#!/usr/bin/env bash
# Builds tests/fixtures/speech-ca-es.webm: synthetic (espeak-ng) Catalan/Spanish turns,
# including a switch inside one turn, encoded like a recording (WebM, Opus 48 kHz stereo),
# plus its reference transcript with [ca]/[es] tags. Robotic voice, but our own data: real
# meeting audio is never committed. Runs in a throwaway Debian container.
set -euo pipefail
cd "$(dirname "$0")/.."

docker run --rm -v "$PWD/tests/fixtures:/out" -e UIDGID="$(id -u):$(id -g)" debian:trixie-slim bash -c '
set -euo pipefail
apt-get update -qq >/dev/null && apt-get install -y -qq espeak-ng ffmpeg >/dev/null 2>&1
cd /tmp
i=0
say() { # voice text
  i=$((i+1))
  espeak-ng -v "$1" -s 150 -w "p$i.wav" "$2"
  ffmpeg -loglevel error -y -i "p$i.wav" -ar 48000 -ac 2 "q$i.wav"
  ffmpeg -loglevel error -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.5 "s$i.wav"
  printf "file q$i.wav\nfile s$i.wav\n" >> list.txt
}
: > list.txt
say ca "Bon dia a tothom. Avui parlarem del pressupost de l any vinent i de les noves contractacions."
say es "Perfecto, pero antes quiero comentar una cosa sobre el calendario de entregas."
say ca "D acord, endavant."
say es "Creo que deberíamos retrasar la primera fase dos semanas,"
say ca "perquè l equip encara no té tota la informació."
say ca "Em sembla bé. Ho apuntem a l acta."
say es "Muy bien. Entonces nos vemos el jueves a las diez."
ffmpeg -loglevel error -y -f concat -safe 0 -i list.txt -c:a libopus -b:a 64k -f webm /out/speech-ca-es.webm
chown "$UIDGID" /out/speech-ca-es.webm
'

cat > tests/fixtures/speech-ca-es.txt <<'EOF'
[ca] Bon dia a tothom. Avui parlarem del pressupost de l'any vinent i de les noves contractacions.
[es] Perfecto, pero antes quiero comentar una cosa sobre el calendario de entregas.
[ca] D'acord, endavant.
[es] Creo que deberíamos retrasar la primera fase dos semanas, [ca] perquè l'equip encara no té tota la informació.
[ca] Em sembla bé. Ho apuntem a l'acta.
[es] Muy bien. Entonces nos vemos el jueves a las diez.
EOF
ls -la tests/fixtures/speech-ca-es.*
