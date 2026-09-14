#!/usr/bin/env bash
# AutoApply launcher. Double-click this file to start AutoApply.
set -u

cd "$(dirname "$0")" || exit 1

PY="backend/venv/bin/python"

# Print one plain sentence, then keep the window open so it can be read.
stop_with() {
    echo ""
    echo "$1"
    echo ""
    if [ -t 0 ]; then
        read -r -p "Press Return to close this window." _
        echo ""
    fi
    exit 1
}

python_ok() {
    "$1" -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' >/dev/null 2>&1
}

reachable() {
    "$PY" -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)' "$1" >/dev/null 2>&1
}

open_browser() {
    if command -v open >/dev/null 2>&1; then
        open "$1" >/dev/null 2>&1
    elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$1" >/dev/null 2>&1 &
    fi
}

echo "Starting AutoApply..."
echo ""

# 1. AutoApply needs Python 3.11 or newer on the computer.
if ! command -v python3 >/dev/null 2>&1; then
    stop_with "AutoApply needs Python 3.11 or newer. Install it from https://python.org, then double-click this file again."
fi

# 2. AutoApply runs on its own private copy of Python kept in backend/venv.
#    Rebuild it when it is missing or older than 3.11; nothing there is worth keeping.
if [ -x "$PY" ] && python_ok "$PY"; then
    :
else
    if [ -d "backend/venv" ]; then
        rm -rf backend/venv
    fi
    echo "Preparing AutoApply. This takes a few minutes the first time."
    if ! python3 -m venv backend/venv >/dev/null 2>&1 || [ ! -x "$PY" ]; then
        stop_with "AutoApply could not be prepared. Check your internet connection, then double-click this file again."
    fi
    if ! python_ok "$PY"; then
        BUILT=$("$PY" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "an unusable version")
        stop_with "AutoApply needs Python 3.11 or newer, and it found Python $BUILT. Install a newer Python from https://python.org, then double-click this file again."
    fi
fi

# 3. Install the files AutoApply needs, unless they are already in place.
if ! "$PY" -c 'import fastapi, dotenv, uvicorn' >/dev/null 2>&1; then
    echo "Installing AutoApply's files. This takes a few minutes."
    if ! "$PY" -m pip install -q -r backend/requirements.txt; then
        stop_with "AutoApply could not finish installing its files. Check your internet connection, then double-click this file again."
    fi
fi

# 4. Private settings file, created from the template on first run.
if [ ! -f "backend/.env" ]; then
    cp backend/.env.example backend/.env
    echo "Created the AutoApply settings file."
fi
chmod 600 backend/.env 2>/dev/null || true

PORT=8000
if [ -f "backend/.env" ]; then
    CONFIGURED_PORT=$(sed -n 's/^AUTOAPPLY_PORT=\([0-9][0-9]*\)[[:space:]]*$/\1/p' backend/.env | tail -n 1)
    if [ -n "$CONFIGURED_PORT" ]; then
        PORT="$CONFIGURED_PORT"
    fi
fi
URL="http://127.0.0.1:$PORT"

# 5. If AutoApply is already running, just show it.
if reachable "$URL/api/health"; then
    echo "AutoApply is already running. Opening your browser."
    open_browser "$URL/dashboard"
    exit 0
fi

# 6. Start AutoApply, open the browser once it answers, and keep running.
"$PY" -m backend.main &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

READY=0
for (( i = 0; i < 60; i++ )); do
    if reachable "$URL/api/health"; then
        READY=1
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        break
    fi
    sleep 1
done

if [ "$READY" -ne 1 ]; then
    stop_with "AutoApply could not start. Close this window, then double-click this file again."
fi

open_browser "$URL/dashboard"
echo ""
echo "AutoApply is open in your browser."
echo "Keep this window open while you use AutoApply. Close it to stop AutoApply."
echo ""
wait "$SERVER_PID"
echo ""
echo "AutoApply has stopped."
