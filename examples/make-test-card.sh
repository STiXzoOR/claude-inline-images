#!/bin/sh
# A test card that shows the difference between real pixels and block
# symbols: a Siemens star (fine radial lines), text in shrinking sizes, a hue
# spectrum and a smooth texture. Needs ImageMagick 7 (magick).
# Usage: make-test-card.sh [out.png]
set -eu
out=${1:-test-card.png}
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT

# Siemens star: 36 black wedges on white, 300 px across.
star="$t/star.png"
draw=""
i=0
while [ "$i" -lt 36 ]; do
  a0=$(awk -v i="$i" 'BEGIN { printf "%.5f", (i * 10) * 3.14159265 / 180 }')
  a1=$(awk -v i="$i" 'BEGIN { printf "%.5f", (i * 10 + 5) * 3.14159265 / 180 }')
  pts=$(awk -v a="$a0" -v b="$a1" 'BEGIN { printf "150,150 %.1f,%.1f %.1f,%.1f", 150 + 148 * cos(a), 150 + 148 * sin(a), 150 + 148 * cos(b), 150 + 148 * sin(b) }')
  draw="$draw polygon $pts"
  i=$((i + 1))
done
magick -size 300x300 xc:white -fill black -draw "$draw" \
  -fill none -stroke '#d33' -strokewidth 3 -draw 'circle 150,150 150,4' "$star"

# The first font file found: macOS, then common Linux paths.
pick() { for f in "$@"; do [ -f "$f" ] && { printf '%s' "$f"; return; }; done; }
bold=$(pick '/System/Library/Fonts/Supplemental/Arial Bold.ttf' /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf /usr/share/fonts/TTF/DejaVuSans-Bold.ttf)
regular=$(pick /System/Library/Fonts/Supplemental/Arial.ttf /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /usr/share/fonts/TTF/DejaVuSans.ttf)
[ -n "$bold" ] && [ -n "$regular" ] || { echo "no font file found" >&2; exit 1; }

# Text in shrinking sizes, beside the star.
text="$t/text.png"
magick -size 300x300 xc:white -fill '#222' -font "$bold" \
  -pointsize 46 -annotate +14+62 'inline' \
  -pointsize 46 -annotate +14+112 'images' \
  -font "$regular" -fill '#2a5bd7' -pointsize 22 -annotate +16+160 'real pixels in kitty,' \
  -pointsize 22 -annotate +16+188 'Ghostty and Rex' \
  -fill '#555' -pointsize 15 -annotate +16+226 'block symbols everywhere else' \
  -pointsize 11 -annotate +16+252 'tiny text shows the difference at once' \
  -pointsize 8 -annotate +16+272 'and this line is smaller still' "$text"

# A smooth texture, a hue spectrum and a ramp of greys.
magick \
  \( "$star" "$text" +append \) \
  \( -size 600x110 -seed 11 plasma:fractal -blur 0x2 -modulate 100,140 \) \
  \( -size 600x44 xc: -colorspace HSL -channel R -fx 'i/w' -channel G -evaluate set 100% -channel B -evaluate set 50% +channel -colorspace sRGB \) \
  \( -size 44x600 gradient:white-black -rotate 90 \) \
  -append -bordercolor '#e8e8e8' -border 2 "$out"
magick identify -format '%f %wx%h %b\n' "$out"
