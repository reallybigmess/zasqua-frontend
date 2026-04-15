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
#      (descriptions, repositories, entities, places, and the link tables)
#      and sync the per-description children shards under `data/children/`
#   3. Run `scripts/precompute-links.js` to shard the entity and place
#      links per authority record and build the explorer index files
#   4. Run `scripts/places-to-geojson.js` and tippecanoe to generate the
#      PMTiles used by the place explorer's clustered marker map
#   5. Install Node dependencies with `npm ci`
#   6. Fetch the correct standalone Tailwind CSS binary for the host
#      platform and compile `src/css/input.css` into `src/css/main.css`
#   7. Run Eleventy (the static site generator) to render every page in
#      the archive out to `_site/`
#   8. Run Pagefind three times to build the main description search
#      index, the entity explorer index, and the place explorer index
#
# Required environment variables:
#   B2_APPLICATION_KEY_ID  — read-only key ID for the `zasqua-export` bucket
#   B2_APPLICATION_KEY     — matching read-only application key
#
# Inputs:  archival JSON exports in the `zasqua-export` B2 bucket.
# Outputs: a fully built `_site/` directory, ready to be uploaded to R2.
#
# Version: v0.5.0

set -e

# Increase Node heap for large Eleventy builds (free tier has 8 GB)
export NODE_OPTIONS="--max-old-space-size=7168"

echo "=== Installing B2 CLI ==="
pip install b2[full] --quiet

echo "=== Authenticating with B2 ==="
b2 account authorize "$B2_APPLICATION_KEY_ID" "$B2_APPLICATION_KEY"

echo "=== Downloading export data ==="
mkdir -p data/children data/entity-links data/place-links

b2 file download b2://zasqua-export/descriptions.json data/descriptions.json
b2 file download b2://zasqua-export/repositories.json data/repositories.json
b2 sync b2://zasqua-export/children/ data/children/

echo "=== Data downloaded ==="
ls -lh data/descriptions.json data/repositories.json
echo "Children files: $(ls data/children/ | wc -l)"

echo "=== Downloading entity and place data ==="
b2 file download b2://zasqua-export/entities.json data/entities.json
b2 file download b2://zasqua-export/places.json data/places.json
b2 file download b2://zasqua-export/entity_links.json data/entity_links.json
b2 file download b2://zasqua-export/place_links.json data/place_links.json
ls -lh data/entities.json data/places.json data/entity_links.json data/place_links.json

echo "=== Pre-computing entity/place link shards and index files ==="
node scripts/precompute-links.js
echo "Entity shards: $(ls data/entity-links/ | wc -l)"
echo "Place shards: $(ls data/place-links/ | wc -l)"
ls -lh data/entity-index.json data/place-index.json

echo "=== Generating PMTiles ==="
node scripts/places-to-geojson.js
if command -v tippecanoe &> /dev/null; then
  tippecanoe -Z0 -z14 --drop-densest-as-needed -l places \
    -o data/zasqua-places.pmtiles data/places.geojson
  ls -lh data/zasqua-places.pmtiles
else
  echo "Tippecanoe not installed — skipping PMTiles generation"
  echo "Install with: brew install tippecanoe (macOS) or pip install tippecanoe (Linux)"
fi

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

echo "=== Indexing with Pagefind (three indices) ==="
# Run 1: Description search index — excludes entity and place pages
npx pagefind --site _site --output-subdir pagefind \
  --exclude-selectors "[data-pagefind-entity-page],[data-pagefind-place-page]"

# Run 2: Entity explorer index — entity pages live at /ne-{code}/
npx pagefind --site _site --output-subdir pagefind-entities \
  --glob "ne-*/**/*.html"

# Run 3: Place explorer index — place pages live at /nl-{id}/
npx pagefind --site _site --output-subdir pagefind-places \
  --glob "nl-*/**/*.html"

echo "=== Build complete ==="
echo "Pages: $(find _site -name 'index.html' | wc -l)"
echo "Site size: $(du -sh _site | cut -f1)"
