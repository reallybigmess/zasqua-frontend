#!/bin/bash
set -e

# Zasqua frontend local build script.
# CI builds run in GitHub Actions — see .github/workflows/deploy.yml.
# This script is a convenience for running the full pipeline locally.
#
# Downloads exported data from B2, builds the site with Eleventy,
# then indexes with Pagefind.
#
# Required environment variables:
#   B2_APPLICATION_KEY_ID  — read-only key ID for zasqua-export bucket
#   B2_APPLICATION_KEY     — read-only application key

# Increase Node heap for large Eleventy builds (free tier has 8 GB)
export NODE_OPTIONS="--max-old-space-size=7168"

echo "=== Installing B2 CLI ==="
pip install b2[full] --quiet

echo "=== Authenticating with B2 ==="
b2 account authorize "$B2_APPLICATION_KEY_ID" "$B2_APPLICATION_KEY"

echo "=== Downloading export data ==="
mkdir -p data/children

b2 file download b2://zasqua-export/descriptions.json data/descriptions.json
b2 file download b2://zasqua-export/repositories.json data/repositories.json
b2 sync b2://zasqua-export/children/ data/children/

echo "=== Data downloaded ==="
ls -lh data/descriptions.json data/repositories.json
echo "Children files: $(ls data/children/ | wc -l)"

echo "=== Installing npm dependencies ==="
npm ci

echo "=== Building CSS with Tailwind ==="
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  TW_BINARY="tailwindcss-macos-arm64"
elif [ "$ARCH" = "x86_64" ] && [ "$(uname -s)" = "Darwin" ]; then
  TW_BINARY="tailwindcss-macos-x64"
else
  TW_BINARY="tailwindcss-linux-x64"
fi
if [ ! -f ./tailwindcss ]; then
  curl -sLO "https://github.com/tailwindlabs/tailwindcss/releases/latest/download/$TW_BINARY"
  chmod +x "$TW_BINARY"
  mv "$TW_BINARY" tailwindcss
fi
./tailwindcss -i src/css/input.css -o src/css/main.css --minify

echo "=== Building site ==="
npx eleventy

echo "=== Indexing with Pagefind ==="
npx pagefind --site _site

echo "=== Build complete ==="
echo "Pages: $(find _site -name 'index.html' | wc -l)"
echo "Site size: $(du -sh _site | cut -f1)"
