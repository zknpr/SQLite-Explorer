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
RELEASE_DIR="release"
LOCAL_TARGET=$(node scripts/vsix-targets.mjs --current-target)
UNIVERSAL_VSIX_FILE="${RELEASE_DIR}/${EXT_NAME}-${EXT_VERSION}.vsix"
PREFERRED_VSIX_FILE="${RELEASE_DIR}/$(node scripts/vsix-targets.mjs --current-vsix "$EXT_NAME" "$EXT_VERSION")"
VSIX_FILE=""

echo -e "${BLUE}=================================${NC}"
echo -e "${BLUE}  SQLite Explorer Installer${NC}"
echo -e "${BLUE}  Version: ${EXT_VERSION}${NC}"
echo -e "${BLUE}  Package target: ${LOCAL_TARGET}${NC}"
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
    rm -rf "$RELEASE_DIR"
    echo -e "${GREEN}✓ Clean complete${NC}"
fi

# Ensure release directory exists
mkdir -p "$RELEASE_DIR"

# Build unless skipped
if [ "$SKIP_BUILD" = false ]; then
    echo ""
    echo -e "${YELLOW}Syncing dependencies...${NC}"

    # vsce package validates the production dependency tree via
    # `npm list --production`; stale node_modules (e.g. after pulling dependency
    # bumps without reinstalling) makes it fail with ELSPROBLEMS. `npm ci`
    # installs exactly from package-lock.json and does not rewrite the lockfile.
    npm ci
    echo -e "${GREEN}✓ Dependencies synced${NC}"

    echo ""
    echo -e "${YELLOW}Building all platform packages...${NC}"

    # The packager builds once, creates five native-target VSIX files plus the
    # natives-free universal, and verifies every archive before release/.
    node scripts/package-vsix.mjs

    echo -e "${GREEN}✓ Package build complete${NC}"
fi

# Prefer the local native package. Unsupported hosts (including musl) resolve
# directly to universal; a missing supported-target artifact also fails over to
# universal instead of installing an unrelated native binary.
if [ -f "$PREFERRED_VSIX_FILE" ]; then
    VSIX_FILE="$PREFERRED_VSIX_FILE"
elif [ -f "$UNIVERSAL_VSIX_FILE" ]; then
    VSIX_FILE="$UNIVERSAL_VSIX_FILE"
    echo -e "${YELLOW}Target package unavailable; using WASM-only universal package.${NC}"
else
    echo -e "${RED}Error: neither ${PREFERRED_VSIX_FILE} nor ${UNIVERSAL_VSIX_FILE} exists. Run without --skip-build first.${NC}"
    exit 1
fi
echo -e "${YELLOW}Using package: ${VSIX_FILE}${NC}"

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
