#!/bin/bash
# Generate small synthetic fixtures for template verification and smoke tests.
# ProRes interlaced (real-chain-shaped) + a simple progressive clip.
set -eu
OUT="${1:-$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures}"
mkdir -p "$OUT"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=640x480:rate=25:duration=4" \
  -f lavfi -i "sine=frequency=440:duration=4" \
  -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le -vf "tinterlace=interleave_top,setfield=tff" \
  -c:a pcm_s16le -ar 48000 "$OUT/mini.mov"
echo "$OUT/mini.mov"