#!/usr/bin/env zsh
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/drive-batch-organizer-extension.zip"
EXT_DIR="$ROOT/extension"

if [[ ! -f "$EXT_DIR/manifest.json" ]]; then
  echo "Missing manifest.json in $EXT_DIR" >&2
  exit 1
fi

rm -f "$OUT"
cd "$EXT_DIR"
zip -qr "$OUT" . -x "*.DS_Store" "*.git*"

echo "Created package: $OUT"

echo "Manifest at root of zip:"
unzip -Z -1 "$OUT" | head
