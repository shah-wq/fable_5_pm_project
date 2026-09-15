#!/usr/bin/env bash
# A picture of one page, because layout is the one thing curl cannot check.
#
#   shoot.sh <base-url> <cookie-jar> <path> <output.png> [width] [height]
#
# The page is fetched as the signed-in user and saved with its scripts stripped
# and its asset URLs made absolute, so headless Chromium renders the server's
# own HTML and CSS without hydrating — which is what we want here: the question
# is whether the form lays out, not whether React boots.
set -euo pipefail

BASE=$1
JAR=$2
PATH_=$3
OUT=$4
WIDTH=${5:-1440}
HEIGHT=${6:-1600}
CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
[ -x "$CHROME" ] || { echo "no chromium; skipping the screenshot" >&2; exit 0; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl -s -b "$JAR" "$BASE$PATH_" > "$WORK/page.raw.html"
python3 - "$WORK/page.raw.html" "$WORK/page.html" "$BASE" <<'PY'
import re, sys
raw, out, base = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(raw, encoding='utf-8').read()
html = re.sub(r'<script[^>]*\bsrc=[^>]*>\s*</script>', '', html)
html = html.replace('"/_next/', f'"{base}/_next/').replace("'/_next/", f"'{base}/_next/")
open(out, 'w', encoding='utf-8').write(html)
PY
"$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size="$WIDTH,$HEIGHT" --screenshot="$OUT" "file://$WORK/page.html" \
  >/dev/null 2>&1 || true
[ -s "$OUT" ] && echo "shot: $OUT"
