#!/bin/bash
# release.sh - Create a GitHub release with the .vsix file
# Usage: ./release.sh [version]
# If no version is provided, reads from package.json

set -e

# Get version from argument or package.json
if [ -n "$1" ]; then
    VERSION="$1"
else
    VERSION=$(node -p "require('./package.json').version")
fi

VSIX_FILE="sqlite-explorer-${VERSION}.vsix"

# Verify .vsix file exists
if [ ! -f "$VSIX_FILE" ]; then
    echo "Error: $VSIX_FILE not found. Run 'npm run package' first."
    exit 1
fi

echo "Creating release v${VERSION}..."

# Create git tag if it doesn't exist
if ! git rev-parse "v${VERSION}" >/dev/null 2>&1; then
    echo "Creating tag v${VERSION}..."
    git tag "v${VERSION}"
    git push origin "v${VERSION}"
else
    echo "Tag v${VERSION} already exists"
fi

# Create GitHub release with the .vsix file
echo "Creating GitHub release with $VSIX_FILE..."
gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes "See [CHANGELOG.md](https://github.com/zknpr/SQLite-Explorer/blob/main/CHANGELOG.md) for details." \
    "$VSIX_FILE"

echo "Release v${VERSION} created successfully!"
echo "https://github.com/zknpr/SQLite-Explorer/releases/tag/v${VERSION}"
