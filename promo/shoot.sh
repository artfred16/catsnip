#!/usr/bin/env bash
#
# Render the promo scenes to 1280×800 Chrome Web Store screenshots via headless Chrome.
# Output: dist/promo/screenshot-0N.png
#
# Headless Chrome (--screenshot) doesn't always self-exit, and there's no `timeout` binary on
# stock macOS, so each render runs in the background and is killed once the PNG is written.
#
set -euo pipefail
cd "$(dirname "$0")"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT="../dist/promo"
mkdir -p "$OUT"

shoot() {
  local f="$1" n="$2" out="$OUT/screenshot-$2.png"
  local profile; profile="$(mktemp -d)"
  rm -f "$out"
  "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$profile" --hide-scrollbars --force-device-scale-factor=1 \
    --window-size=1280,800 --screenshot="$out" "file://$PWD/$f.html" >/dev/null 2>&1 &
  local pid=$!
  local ok=""
  for _ in $(seq 1 50); do                 # wait up to ~10s for the PNG
    if [ -s "$out" ]; then ok=1; sleep 0.3; break; fi
    sleep 0.2
  done
  kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true
  rm -rf "$profile"
  [ -n "$ok" ] && echo "wrote $out" || { echo "FAILED $out" >&2; return 1; }
}

i=1
for f in 01-region 02-annotate 03-frame 04-grabtext 05-desktop; do
  shoot "$f" "$(printf '%02d' "$i")"
  i=$((i + 1))
done
echo "Done — $(ls "$OUT"/*.png 2>/dev/null | wc -l | tr -d ' ') screenshots in $OUT"
