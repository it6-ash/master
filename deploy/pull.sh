#!/usr/bin/env bash
#
# Take new code from origin without touching live state. Run before every
# collection pass by kw-estate.service, and by install.sh.
#
# The single owner of "which paths git may overwrite on this box".
#
#   src/ schema/ content/ deploy/ test/ and the top-level files are code.
#   config/ carries the *.example.json templates. Safe: hosts.json and
#     checks.json are git-ignored, so they are untracked and `git checkout
#     <ref> -- config` cannot touch them. Leaving it out meant a new example
#     file never reached the box and there was nothing to copy from.
#   data/costs.json, glossary.json and analysis.json are written by hand, so
#     they belong to the repo too.
#   Everything else under data/ — servers, workflows, issues, projects,
#     snapshots — is written by ingest ON THIS BOX and is newer than anything
#     in git. dist/ is built here. Merging over either loses the estate's
#     current state, so this never does a pull or a merge: it checks out
#     named paths and leaves the rest alone.
#
# Unit files are deliberately NOT applied here. A timer that can rewrite its
# own systemd unit and restart itself is a bad thing to debug at 3am; run
# install.sh when deploy/*.service or *.timer changes.

set -euo pipefail

DIR="${DIR:-/opt/kw-estate}"
BRANCH="${BRANCH:-main}"

CODE_PATHS=(src schema content deploy test kw-collect.sh package.json playwright.config.js README.md
            config data/costs.json data/glossary.json data/analysis.json)

[ -d "$DIR/.git" ] || { echo "no checkout at $DIR; nothing to update"; exit 0; }

BEFORE="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

# A box that cannot reach GitHub must still collect. Fail soft, loudly.
if ! git -C "$DIR" fetch --quiet origin "$BRANCH" 2>/dev/null; then
  echo "could not reach origin; running the code already on disk"
  exit 0
fi

AFTER="$(git -C "$DIR" rev-parse --short "origin/$BRANCH")"
if [ "$BEFORE" = "$AFTER" ]; then
  echo "already at origin/$BRANCH ($AFTER)"
  exit 0
fi

for p in "${CODE_PATHS[@]}"; do
  git -C "$DIR" checkout --quiet "origin/$BRANCH" -- "$p" 2>/dev/null || true
done

# Move HEAD too, so `git log` on the box tells the truth about what is running.
# --soft: the checked-out paths stay, and data/ and dist/ are untouched.
git -C "$DIR" reset --soft "origin/$BRANCH" 2>/dev/null || true

echo "code updated $BEFORE -> $AFTER"
git -C "$DIR" log --oneline "$BEFORE..$AFTER" 2>/dev/null | head -10 || true

if ! git -C "$DIR" diff --quiet "$BEFORE" "$AFTER" -- deploy/kw-estate.service deploy/kw-estate.timer 2>/dev/null; then
  echo "NOTE: the systemd units changed upstream. Run deploy/install.sh to apply them."
fi
