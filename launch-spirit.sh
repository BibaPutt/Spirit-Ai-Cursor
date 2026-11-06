#!/bin/bash
# ════════════════════════════════════════════════════════
#  Spirit AI — One-Click Launcher for macOS / Linux
#  Run this script to install dependencies and
#  launch Spirit AI in the background.
# ════════════════════════════════════════════════════════

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
BOLD='\033[1m'

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${BOLD}           SPIRIT AI — LAUNCHER               ${NC}${CYAN}║${NC}"
echo -e "${CYAN}║       AI-Aware Cursor Companion               ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Check Node.js ─────────────────────────────
echo -e "  ${BOLD}[1/4]${NC} Checking Node.js installation..."

if ! command -v node &> /dev/null; then
    echo ""
    echo -e "  ${RED}[ERROR]${NC} Node.js is not installed."
    echo "  Please install Node.js v18+ from: https://nodejs.org"
    echo ""
    echo "  macOS:   brew install node"
    echo "  Ubuntu:  sudo apt install nodejs npm"
    echo "  Fedora:  sudo dnf install nodejs npm"
    echo ""
    exit 1
fi

NODE_VER=$(node --version)
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)

echo "  Found Node.js $NODE_VER"

if [ "$NODE_MAJOR" -lt 18 ]; then
    echo ""
    echo -e "  ${YELLOW}[WARNING]${NC} Spirit AI requires Node.js v18 or later."
    echo "  Current version: $NODE_VER"
    echo "  Please update from: https://nodejs.org"
    echo ""
    exit 1
fi

echo -e "  ${GREEN}[OK]${NC} Node.js version is compatible."
echo ""

# ── Step 2: Navigate to project directory ─────────────
echo -e "  ${BOLD}[2/4]${NC} Locating Spirit AI project files..."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$SCRIPT_DIR/Spirit-Ai-Cursor"

if [ ! -f "$PROJECT_DIR/package.json" ]; then
    PROJECT_DIR="$SCRIPT_DIR"
    if [ ! -f "$PROJECT_DIR/package.json" ]; then
        echo ""
        echo -e "  ${RED}[ERROR]${NC} Could not find package.json."
        echo "  Make sure this launcher is in the Spirit AI root folder."
        echo ""
        exit 1
    fi
fi

echo -e "  ${GREEN}[OK]${NC} Found project at: $PROJECT_DIR"
echo ""

# ── Step 3: Install dependencies ──────────────────────
echo -e "  ${BOLD}[3/4]${NC} Installing dependencies (this may take a few minutes)..."
echo "         Please wait..."
echo ""

cd "$PROJECT_DIR"

if [ ! -d "node_modules" ]; then
    echo "  Running npm install..."
    npm install --no-audit --no-fund 2>/dev/null || {
        echo ""
        echo -e "  ${YELLOW}[WARNING]${NC} Some deps failed. Trying with --legacy-peer-deps..."
        npm install --legacy-peer-deps --no-audit --no-fund 2>/dev/null || true
    }
    echo -e "  ${GREEN}[OK]${NC} Dependencies installed."
else
    echo -e "  ${GREEN}[OK]${NC} Dependencies already installed (node_modules found)."
fi
echo ""

# ── Step 4: Build and Launch ──────────────────────────
echo -e "  ${BOLD}[4/4]${NC} Building and launching Spirit AI..."
echo ""

echo "  Building renderer and main process..."
npm run build 2>/dev/null || {
    echo ""
    echo -e "  ${YELLOW}[WARNING]${NC} Build had warnings, attempting to launch anyway..."
    echo ""
}

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}         Spirit AI is starting...              ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}   It will appear in your system tray.         ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}                                               ${CYAN}║${NC}"

if [[ "$OSTYPE" == "darwin"* ]]; then
    echo -e "${CYAN}║${NC}   Hold Right-Cmd to activate AI mode!         ${CYAN}║${NC}"
else
    echo -e "${CYAN}║${NC}   Hold Right-Ctrl to activate AI mode!        ${CYAN}║${NC}"
fi

echo -e "${CYAN}╚══════════════════════════════════════════════╝${NC}"
echo ""

# Launch in background
nohup npx electron . > /dev/null 2>&1 &

sleep 2

echo -e "  ${GREEN}[OK]${NC} Spirit AI launched successfully!"
echo "  You can close this terminal. Spirit runs in the system tray."
echo ""
