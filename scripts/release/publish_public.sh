#!/usr/bin/env bash
# Publish the exported source subset to the public repo (main branch).
#
# Usage: publish_public.sh <export-dir> <staging-clone> "<commit message>"
#
# Flow (see docs/vs-r82-upgrade + session records):
#   1. python3 scripts/release/export_source.py --out <export-dir>
#   2. this script rsyncs the export into a fresh clone of the PUBLIC repo
#   3. commit + push to main
#
# --delete makes main an exact mirror of the export, with two deliberate
# exceptions:
#   * README.md      — owned by the public workflow, edited in place on main
#   * docs/images/   — public-only landing-page assets; the exporter refuses
#                      binaries by design, so without this exclude a --delete
#                      sweep removes them from the landing page.
set -euo pipefail

EXPORT_DIR="${1:?usage: publish_public.sh <export-dir> <staging-clone> \"<commit message>\"}"
STAGING="${2:?usage: publish_public.sh <export-dir> <staging-clone> \"<commit message>\"}"
MSG="${3:?usage: publish_public.sh <export-dir> <staging-clone> \"<commit message>\"}"

[ -d "$EXPORT_DIR" ] || { echo "export dir not found: $EXPORT_DIR" >&2; exit 1; }
[ -d "$STAGING/.git" ] || { echo "staging clone not found: $STAGING" >&2; exit 1; }

rsync -a --delete \
  --exclude=.git \
  --exclude=README.md \
  --exclude=docs/images/ \
  "$EXPORT_DIR"/ "$STAGING"/

cd "$STAGING"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "public main already matches the export — nothing to publish"
  exit 0
fi

git add -A
git commit -q -m "$MSG"
git push -q origin main
echo "published:"
git log --oneline -1
