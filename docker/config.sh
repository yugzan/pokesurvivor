#!/bin/sh
# Escribe config.js con las variables del .env al arrancar el contenedor
# (nginx ejecuta todo lo que hay en /docker-entrypoint.d/ antes de empezar).
# Sin variables, config.js se queda como viene (null): proyecto y TURN oficiales.
set -ef   # -f: un * en ALLOWED_HOSTS no se convierte en nombres de archivo
OUT=/usr/share/nginx/html/config.js
q() { printf '"%s"' "$(printf %s "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

parts=""
add() { parts="${parts:+$parts, }$1"; }

if [ "$FIREBASE_LOCAL_ONLY" = "1" ]; then
  add "firebase: null"
elif [ -n "$FIREBASE_PROJECT_ID" ]; then
  fb="apiKey: $(q "$FIREBASE_API_KEY"), authDomain: $(q "${FIREBASE_AUTH_DOMAIN:-$FIREBASE_PROJECT_ID.firebaseapp.com}"), projectId: $(q "$FIREBASE_PROJECT_ID")"
  fb="$fb, storageBucket: $(q "${FIREBASE_STORAGE_BUCKET:-$FIREBASE_PROJECT_ID.firebasestorage.app}")"
  fb="$fb, messagingSenderId: $(q "$FIREBASE_MESSAGING_SENDER_ID"), appId: $(q "$FIREBASE_APP_ID")"
  [ -n "$FIREBASE_DATABASE_URL" ] && fb="$fb, databaseURL: $(q "$FIREBASE_DATABASE_URL")"
  [ "$FIREBASE_EMULATOR" = "1" ] && fb="$fb, emulator: true"
  add "firebase: { $fb }"
fi

if [ -n "$ALLOWED_HOSTS" ]; then
  hosts=""
  for h in $(printf %s "$ALLOWED_HOSTS" | tr ',' ' '); do hosts="${hosts:+$hosts, }$(q "$h")"; done
  add "hosts: [$hosts]"
fi

# TURN_URL vacío (pero puesto) = sin TURN; sin poner = el oficial.
[ "${TURN_URL+x}" = "x" ] && add "turnUrl: $(q "$TURN_URL")"

if [ -n "$parts" ]; then
  printf '/* Generado por docker/config.sh al arrancar. */\nwindow.PS_CONFIG = { %s };\n' "$parts" > "$OUT"
  echo "config.js: $parts" | sed 's/apiKey: "[^"]*"/apiKey: "***"/'
else
  echo "config.js: sin variables, proyecto oficial"
fi
