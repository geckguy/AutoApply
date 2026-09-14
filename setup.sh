#!/usr/bin/env bash
set -e

echo "Setting up AutoApply..."
echo ""

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is required. Install it from https://python.org"
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "Python $PYTHON_VERSION found"
if ! python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 11))'; then
    echo "❌ AutoApply requires Python 3.11 or newer. Found $PYTHON_VERSION."
    exit 1
fi

# Create virtual environment
if [ ! -d "backend/venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv backend/venv
else
    echo "Virtual environment exists"
fi

# The server runs on the venv interpreter, so that is the one that must be 3.11+.
if [ ! -x "backend/venv/bin/python" ]; then
    echo "❌ backend/venv has no usable interpreter (backend/venv/bin/python is missing)."
    echo "   Delete it and run setup again: rm -rf backend/venv && ./setup.sh"
    exit 1
fi
if ! backend/venv/bin/python -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' 2>/dev/null; then
    VENV_VERSION=$(backend/venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "an unusable interpreter")
    echo "❌ backend/venv runs Python $VENV_VERSION; AutoApply requires 3.11 or newer."
    echo "   Delete it and run setup again: rm -rf backend/venv && ./setup.sh"
    exit 1
fi
VENV_VERSION=$(backend/venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "backend/venv uses Python $VENV_VERSION"

# Activate and install dependencies
echo "📦 Installing dependencies..."
source backend/venv/bin/activate
pip install -q -r backend/requirements.txt

# Setup .env
if [ ! -f "backend/.env" ]; then
    cp backend/.env.example backend/.env
    echo ""
    echo " Created backend/.env from template."
    echo "    The default provider is Gemini. Add GEMINI_API_KEY:"
    echo "    → https://aistudio.google.com/apikey"
    echo "    Or set AI_PROVIDER=openrouter and add OPENROUTER_API_KEY:"
    echo "    → https://openrouter.ai/keys"
    echo "    OpenRouter also requires an explicit OPENROUTER_MODEL."
    echo ""
else
    echo "backend/.env exists"
fi
chmod 600 backend/.env

# Create data directory
mkdir -p backend/data
chmod 700 backend/data

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Start AutoApply:"
echo "     macOS/Linux → double-click start-autoapply.command"
echo "     Windows     → double-click start-autoapply.bat"
echo "     This starts AutoApply and opens it in your browser."
echo "  2. Or start it from a terminal:"
echo "     source backend/venv/bin/activate"
echo "     python -m backend.main"
echo "     → http://127.0.0.1:8000/dashboard"
echo "  3. Choose an AI service and add its key in backend/.env"
echo "     Default: AI_PROVIDER=gemini + GEMINI_API_KEY"
echo "     Alternative: AI_PROVIDER=openrouter + OPENROUTER_API_KEY"
echo "                  + OPENROUTER_MODEL (see backend/.env.example)"
echo "  4. Load the extension in Firefox:"
echo "     → about:debugging#/runtime/this-firefox"
echo "     → Load Temporary Add-on → select extension/manifest.json"
echo "  5. Upload your resume in the dashboard:"
echo "     → http://127.0.0.1:8000/dashboard#profile"
echo "  6. Navigate to a job application and press Ctrl+Shift+A"
