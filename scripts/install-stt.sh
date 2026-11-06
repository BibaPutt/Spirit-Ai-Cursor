#!/usr/bin/env bash
# Installs the Python dependencies the local STT sidecar needs
# (electron/voice/local-whisper.py): Flask + faster-whisper.
# Runs automatically from `npm i` via scripts/install-stt.js.
set -e

py=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then
    py="$c"
    break
  fi
done

if [ -z "$py" ]; then
  printf '\n  Local STT needs Python 3.9+.\n'
  printf '  Install it, then re-run: npm i\n'
  printf '  Voice input will fall back to Cloud STT until then.\n\n' >&2
  exit 1
fi

printf 'Installing local STT dependencies (flask, faster-whisper) via %s ...\n' "$py"
"$py" -m pip install --user --upgrade flask faster-whisper

printf '\n  Local STT ready. The Whisper model (~460 MB) downloads once,\n'
printf '  automatically, on your first voice use.\n\n'
exit 0
