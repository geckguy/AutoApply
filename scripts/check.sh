#!/usr/bin/env bash
#
# The complete local check suite: Python compile + unit tests, extension tree
# parity, JavaScript syntax and behavioural tests, manifest JSON, and a
# whitespace check on the working diff.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# Fail loudly when a tool is missing instead of silently skipping its checks
# (a skipped step must never look like a passing one).
missing_tool=false
for tool in python3 node find cmp; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "check.sh: required tool '$tool' is not on PATH" >&2
    missing_tool=true
  fi
done
if [ "$missing_tool" = true ]; then
  exit 1
fi

python_bin="python3"
if [[ -x backend/venv/bin/python ]]; then
  python_bin="backend/venv/bin/python"
fi

echo "== Python =="
"$python_bin" -m compileall -q backend tests
"$python_bin" -m unittest discover -s tests -v

echo "== Extension tree parity =="
bash scripts/sync-extension.sh --check

echo "== JavaScript syntax =="
js_files="$(find extension extension-chrome backend/dashboard tests/js -name '*.js' -type f -not -path '*/web-ext-artifacts/*' | sort)"
while IFS= read -r js_file; do
  [ -n "$js_file" ] || continue
  node --check "$js_file"
done <<< "$js_files"

echo "== JavaScript tests =="
js_tests="$(find tests/js extension/tests extension-chrome/tests -name '*.test.js' -type f | sort)"
while IFS= read -r js_test; do
  [ -n "$js_test" ] || continue
  node "$js_test"
done <<< "$js_tests"

echo "== Extension manifests =="
"$python_bin" - <<'PY'
import json
from pathlib import Path

for manifest in (Path("extension/manifest.json"), Path("extension-chrome/manifest.json")):
    json.loads(manifest.read_text())
    print(f"validated {manifest}")
PY

echo "== Working diff whitespace =="
git diff --check

echo "check.sh: all checks passed"
