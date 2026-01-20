#!/bin/bash
# =============================================================================
# SQLite Explorer - Install Script
# =============================================================================
# This script builds and installs the SQLite Explorer extension to VS Code.
#
# Usage:
#   ./install.sh          # Build and install
#   ./install.sh --clean  # Clean, build, and install
#   ./install.sh --skip-build  # Install existing .vsix without rebuilding
#
# Requirements:
#   - Node.js (v18+)
#   - npm or bun
#   - VS Code CLI (code command)
# =============================================================================

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory (works even if called from another directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Extension info
EXT_NAME="sqlite-explorer"
EXT_VERSION=$(node -p "require('./package.json').version")
VSIX_FILE="${EXT_NAME}-${EXT_VERSION}.vsix"

echo -e "${BLUE}=================================${NC}"
echo -e "${BLUE}  SQLite Explorer Installer${NC}"
echo -e "${BLUE}  Version: ${EXT_VERSION}${NC}"
echo -e "${BLUE}=================================${NC}"
echo ""

# Parse arguments
CLEAN=false
SKIP_BUILD=false
for arg in "$@"; do
    case $arg in
        --clean)
            CLEAN=true
            ;;
        --skip-build)
            SKIP_BUILD=true
            ;;
        --help|-h)
            echo "Usage: ./install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --clean       Clean build artifacts before building"
            echo "  --skip-build  Skip build step, install existing .vsix"
            echo "  --help, -h    Show this help message"
            exit 0
            ;;
    esac
done

# Check requirements
check_command() {
    if ! command -v $1 &> /dev/null; then
        echo -e "${RED}Error: $1 is not installed${NC}"
        exit 1
    fi
}

echo -e "${YELLOW}Checking requirements...${NC}"
check_command node
check_command npm

# Check for VS Code CLI
if command -v code &> /dev/null; then
    VSCODE_CMD="code"
elif command -v code-insiders &> /dev/null; then
    VSCODE_CMD="code-insiders"
elif command -v codium &> /dev/null; then
    VSCODE_CMD="codium"
else
    echo -e "${RED}Error: VS Code CLI not found (code, code-insiders, or codium)${NC}"
    echo "Make sure VS Code is installed and 'code' is in your PATH"
    exit 1
fi
echo -e "${GREEN}✓ Using: $VSCODE_CMD${NC}"

# Clean if requested
if [ "$CLEAN" = true ]; then
    echo ""
    echo -e "${YELLOW}Cleaning build artifacts...${NC}"
    rm -rf out
    rm -rf assets
    rm -f *.vsix
    echo -e "${GREEN}✓ Clean complete${NC}"
fi

# Build unless skipped
if [ "$SKIP_BUILD" = false ]; then
    echo ""
    echo -e "${YELLOW}Building extension...${NC}"

    # Run the build script
    node scripts/build.mjs

    echo -e "${GREEN}✓ Build complete${NC}"

    echo ""
    echo -e "${YELLOW}Packaging extension...${NC}"

    # Package the extension
    npx vsce package --skip-license --out "$VSIX_FILE"

    echo -e "${GREEN}✓ Package complete: ${VSIX_FILE}${NC}"
else
    # Check if .vsix exists
    if [ ! -f "$VSIX_FILE" ]; then
        echo -e "${RED}Error: ${VSIX_FILE} not found. Run without --skip-build first.${NC}"
        exit 1
    fi
    echo -e "${YELLOW}Using existing package: ${VSIX_FILE}${NC}"
fi

# Install the extension
echo ""
echo -e "${YELLOW}Installing extension to VS Code...${NC}"
$VSCODE_CMD --install-extension "$VSIX_FILE" --force

echo ""
echo -e "${GREEN}=================================${NC}"
echo -e "${GREEN}  Installation Complete!${NC}"
echo -e "${GREEN}=================================${NC}"
echo ""
echo -e "Reload VS Code to activate the extension:"
echo -e "  ${BLUE}Ctrl+Shift+P${NC} → ${BLUE}Developer: Reload Window${NC}"
echo ""
