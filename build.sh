#!/bin/bash
# Local Build Pipeline
#
# This script runs the full Zasqua frontend build on the developer's own
# machine — an alternative to the GitHub Actions workflow that normally
# builds and deploys the site (see `.github/workflows/deploy.yml`). It
# exists so that contributors can reproduce a production-equivalent build
# locally, test changes end-to-end, and troubleshoot issues without
# waiting for CI.
#
# The pipeline walks through these steps in order:
#
#   1. Install the Backblaze B2 CLI and authenticate with the read-only
#      credentials that grant access to the `zasqua-export` bucket
#   2. Download the archival data exported from the backend Django app
#      (`descriptions.json`, `repositories.json`, and the per-description
#      children shards under `data/children/`)
#   3. Install Node dependencies with `npm ci`
#   4. Fetch the correct standalone Tailwind CSS binary for the host
#      platform and compile `src/css/input.css` into `src/css/main.css`
#   5. Run Eleventy (the static site generator) to render every page in
#      the archive out to `_site/`
#   6. Run Pagefind over `_site/` to build the client-side search index
#
# Required environment variables:
#   B2_APPLICATION_KEY_ID  — read-only key ID for the `zasqua-export` bucket
#   B2_APPLICATION_KEY     — matching read-only application key
#
# Inputs:  archival JSON exports in the `zasqua-export` B2 bucket.
# Outputs: a fully built `_site/` directory, ready to be uploaded to R2.
#
# Version: v0.4.0

set -e

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
