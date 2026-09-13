#!/usr/bin/env bash
#
# Regenerate the Chromium extension tree from the canonical Firefox tree.
#
# The two packages are the same extension: extension/ is the source of truth
# and extension-chrome/ is a generated copy. Chrome cannot load scripts from
# outside its own extension directory, so the shared files must exist twice;
# this script keeps the copy honest instead of relying on reviewers to notice.
#
# Files that intentionally differ (never written by this script):
#   * manifest.json            — browser-specific ids, MV3/MV2 fields (hand-written)
#   * background/background.js — canonical file plus a Chromium `browser` shim
#
# Build output (web-ext-artifacts/) and dot-files (.DS_Store) are skipped: they
# are not part of either package and must not register as drift.
#
# Usage:
#   bash scripts/sync-extension.sh          # regenerate extension-chrome/
#   bash scripts/sync-extension.sh --check  # write nothing; exit 1 if drifted
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

src_dir="extension"
dst_dir="extension-chrome"

usage() {
  echo "usage: $(basename "$0") [--check]" >&2
}

check_only=false
while [ $# -gt 0 ]; do
  case "$1" in
    --check) check_only=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
  shift
done

if [ ! -d "$src_dir" ] || [ ! -d "$dst_dir" ]; then
  echo "sync-extension: both $src_dir/ and $dst_dir/ must exist" >&2
  exit 1
fi

drift=false

is_excluded() {
  case "$1" in
    manifest.json|background/background.js) return 0 ;;
    *) return 1 ;;
  esac
}

# Relative paths of every packaged file, in a stable order.
list_files() {
  ( cd "$1" && find . -type f ! -name '.*' ! -path './web-ext-artifacts/*' | sort )
}

# Render the Chromium background script: the canonical file with the
# `browser` -> `chrome` shim inserted directly after its leading block comment,
# so the shim runs before any other statement in the file.
render_background() {
  awk -v q="'" '
    { print }
    !inserted && seen_header && /^[[:space:]]*\*\/[[:space:]]*$/ {
      print ""
      print "if (typeof browser === " q "undefined" q ") {"
      print "  globalThis.browser = chrome;"
      print "}"
      print ""
      inserted = 1
    }
    /^\/\*\*/ { seen_header = 1 }
  ' "$1"
}

# 1. Every shared file must be byte-identical in both trees.
src_files="$(list_files "$src_dir")"
while IFS= read -r entry; do
  rel="${entry#./}"
  is_excluded "$rel" && continue
  if [ ! -f "$dst_dir/$rel" ]; then
    if [ "$check_only" = true ]; then
      echo "sync-extension: missing $dst_dir/$rel" >&2
      drift=true
    else
      mkdir -p "$(dirname "$dst_dir/$rel")"
      cp -p "$src_dir/$rel" "$dst_dir/$rel"
      echo "sync-extension: added $dst_dir/$rel"
    fi
  elif ! cmp -s "$src_dir/$rel" "$dst_dir/$rel"; then
    if [ "$check_only" = true ]; then
      echo "sync-extension: drifted $dst_dir/$rel" >&2
      drift=true
    else
      cp -p "$src_dir/$rel" "$dst_dir/$rel"
      echo "sync-extension: updated $dst_dir/$rel"
    fi
  fi
done <<< "$src_files"

# 2. The Chromium background script is generated, never hand-edited.
if cmp -s <(render_background "$src_dir/background/background.js") "$dst_dir/background/background.js"; then
  :
elif [ "$check_only" = true ]; then
  echo "sync-extension: drifted $dst_dir/background/background.js (regenerate the shim)" >&2
  drift=true
else
  render_background "$src_dir/background/background.js" > "$dst_dir/background/background.js"
  echo "sync-extension: regenerated $dst_dir/background/background.js"
fi

# 3. Nothing may linger in the generated tree that the canonical tree lacks.
dst_files="$(list_files "$dst_dir")"
while IFS= read -r entry; do
  rel="${entry#./}"
  [ -f "$src_dir/$rel" ] && continue
  if [ "$check_only" = true ]; then
    echo "sync-extension: unexpected $dst_dir/$rel" >&2
    drift=true
  else
    rm -f "$dst_dir/$rel"
    echo "sync-extension: removed $dst_dir/$rel"
  fi
done <<< "$dst_files"

# 4. The manifests are hand-written and must both exist, and must differ:
#    a byte-identical pair means one browser would load the other's manifest.
if [ -f "$src_dir/manifest.json" ] && [ -f "$dst_dir/manifest.json" ] && ! cmp -s "$src_dir/manifest.json" "$dst_dir/manifest.json"; then
  :
else
  echo "sync-extension: $src_dir/manifest.json and $dst_dir/manifest.json must both exist and differ" >&2
  drift=true
fi

if [ "$check_only" = true ]; then
  if [ "$drift" = true ]; then
    echo "sync-extension: $dst_dir/ is out of sync; run scripts/sync-extension.sh" >&2
    exit 1
  fi
  echo "sync-extension: $dst_dir/ matches $src_dir/"
else
  echo "sync-extension: regenerated $dst_dir/ from $src_dir/"
fi
