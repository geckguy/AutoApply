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

# Create virtual environment
if [ ! -d "backend/venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv backend/venv
else
    echo "Virtual environment exists"
fi

# Activate and install dependencies
echo "📦 Installing dependencies..."
source backend/venv/bin/activate
pip install -q -r backend/requirements.txt

# Setup .env
if [ ! -f "backend/.env" ]; then
    cp backend/.env.example backend/.env
    echo ""
    echo " Created backend/.env from template."
    echo "    Edit it and add your Gemini API key:"
    echo "    → Get one free at https://aistudio.google.com/apikey"
    echo ""
else
    echo "backend/.env exists"
fi

# Create data directory
mkdir -p backend/data

echo ""
echo "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Add your Gemini API key to backend/.env"
echo "  2. Start the server:"
echo "     source backend/venv/bin/activate"
echo "     python -m backend.main"
echo "  3. Load the extension in Firefox:"
echo "     → about:debugging#/runtime/this-firefox"
echo "     → Load Temporary Add-on → select extension/manifest.json"
echo "  4. Upload your resume in the extension popup"
echo "  5. Navigate to a job application and press Ctrl+Shift+A"
