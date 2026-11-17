#!/usr/bin/env bash
# Regenerates every PNG icon from the two SVG sources (needs rsvg-convert, from librsvg).
#   icon.svg           rounded square, used for "any" icons and the favicon
#   icon-maskable.svg  full-bleed square with the artwork inside the central safe zone (Android maskable, iOS home screen)
set -euo pipefail
cd "$(dirname "$0")/../public/icons"
for size in 192 512; do
  rsvg-convert -w "$size" -h "$size" icon.svg -o "icon-$size.png"
  rsvg-convert -w "$size" -h "$size" icon-maskable.svg -o "icon-maskable-$size.png"
done
rsvg-convert -w 180 -h 180 icon-maskable.svg -o apple-touch-icon.png   # iOS needs an opaque square (it rounds the corners itself)
rsvg-convert -w 32 -h 32 icon.svg -o favicon-32.png
echo "icons rebuilt"
