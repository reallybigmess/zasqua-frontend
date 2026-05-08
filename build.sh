#!/usr/bin/env bash
# Zasqua Frontend Local Build Script (Hugo pipeline)
#
# Runs the end-to-end pipeline on a developer machine the way CI would:
# downloads the current data exports from Backblaze B2, pre-computes the
# entity/place link shards, enriches the archival JSON via Node (producing
# the denormalised inputs Hugo consumes), builds the Hugo Extended site,
# and indexes the output three times with Pagefind (one index per
# discovery surface: descriptions, entity explorer, place explorer).
#
# The v1.0.0 rebuild replaced the Eleventy pipeline with Hugo Extended to
# fix the CI out-of-memory failure at ~192K pages. The Tailwind CSS
# compile is now handled inside Hugo via `css.TailwindCSS` (Hugo Pipes)
# rather than the standalone Tailwind binary this script previously
# downloaded.
#
# Required environment variables:
#   B2_APPLICATION_KEY_ID  — read-only key ID for the zasqua-export bucket
#   B2_APPLICATION_KEY     — read-only application key
#
# Optional environment variables:
#   DEV_LIMIT       — integer cap on records processed by generate-content.js
#                     (fast local iteration; leave unset for full-corpus)
#   SKIP_DOWNLOAD   — if set to any value, skips the B2 download step
#                     (useful when exports/ is already populated)
#
# Version: v1.0.0
set -euo pipefail

# ---- Stage 1: Data download (B2) ----
if [ -z "${SKIP_DOWNLOAD:-}" ]; then
  echo "=== Stage 1: downloading data from B2 ==="
  pip install b2[full] --quiet
  b2 account authorize "$B2_APPLICATION_KEY_ID" "$B2_APPLICATION_KEY"

  mkdir -p exports/children exports/entity-links exports/place-links

  b2 file download b2://zasqua-export/descriptions.json exports/descriptions.json
  b2 file download b2://zasqua-export/repositories.json exports/repositories.json
  b2 sync b2://zasqua-export/children/ exports/children/
  b2 file download b2://zasqua-export/entities.json exports/entities.json
  b2 file download b2://zasqua-export/places.json exports/places.json
  b2 file download b2://zasqua-export/entity_links.json exports/entity_links.json
  b2 file download b2://zasqua-export/place_links.json exports/place_links.json

  ls -lh exports/descriptions.json exports/repositories.json exports/entities.json exports/places.json
  echo "Children files: $(ls exports/children/ | wc -l)"
else
  echo "=== Stage 1: skipped (SKIP_DOWNLOAD set) ==="
fi

# ---- Stage 2: precompute entity/place link shards ----
echo "=== Stage 2: precompute-links.js ==="
node scripts/precompute-links.js
echo "Entity shards:      $(ls exports/entity-links/ | wc -l)"
echo "Doc-entities shards: $(ls exports/doc-entities/ | wc -l)"
echo "Place shards:       $(ls exports/place-links/ | wc -l)"
ls -lh exports/entity-index.json exports/place-index.json

# ---- Stage 3: npm dependencies ----
echo "=== Stage 3: npm ci ==="
npm ci

# ---- Stage 4: enrichment (Node) ----
# Writes sharded descriptions + single-file entities + single-file places
# to assets/hugo-data/ where Hugo's content adapters consume them.
echo "=== Stage 4: generate-content.js ==="
node scripts/generate-content.js

# ---- Stage 5: populate runtime data shards under static/data/ ----
# Hugo's static passthrough serves these as-is for client JS (tree.js,
# entity-explorer.js, place-explorer.js, entity.js, place.js) to fetch
# at runtime. Previously these were served from /data/ by Eleventy's
# default passthrough of the top-level data/ directory; Hugo's data/
# is reserved for small UI lookups, so runtime shards live under
# static/data/ instead.
echo "=== Stage 5: populate static/data/ runtime shards ==="
mkdir -p static/data
rm -rf static/data/children static/data/entity-links static/data/place-links static/data/doc-entities
cp -r exports/children static/data/children
cp -r exports/entity-links static/data/entity-links
cp -r exports/place-links static/data/place-links
cp -r exports/doc-entities static/data/doc-entities
cp exports/entity-index.json static/data/entity-index.json
cp exports/place-index.json static/data/place-index.json
if [ -f exports/graph.json ]; then cp exports/graph.json static/data/graph.json; fi

# ---- Stage 6: Hugo build ----
# Requires Hugo Extended (css.TailwindCSS + SCSS support). The build
# writes hugo_stats.json; css.TailwindCSS compiles main.css from the
# class set; Pagefind indices are built in stage 7.
echo "=== Stage 6: hugo --minify ==="
hugo --minify

# ---- Stage 7: Pagefind indices (Node API) ----
# HTML-scan fallbacks retained as a commented-out block through the
# initial stabilisation window after the Hugo cutover. Delete after ~1
# week of clean production deploys.
#
# The Node-API generator reads enriched JSON under assets/hugo-data/ and
# writes three corpus-pure bundles to public/pagefind*/ via Pagefind's
# addCustomRecord. The JSON is now the search contract — empirical parity
# was verified against a side-by-side HTML-scan baseline during v1.0.0
# development.
rm -rf public/pagefind
echo "=== Stage 7: generate-pagefind-indices.js (Node API, 3 bundles) ==="
node scripts/generate-pagefind-indices.js

# HTML-scan fallbacks (kept through the initial stabilisation window):
# npx pagefind --site public --output-subdir pagefind \
#   --exclude-selectors "[data-pagefind-entity-page],[data-pagefind-place-page]"
# npx pagefind --site public --output-subdir pagefind-entities \
#   --glob "ne-*/**/*.html"
# npx pagefind --site public --output-subdir pagefind-places \
#   --glob "nl-*/**/*.html"

# ---- Done ----
echo "=== Build complete ==="
echo "Pages:     $(find public -name 'index.html' | wc -l)"
echo "Site size: $(du -sh public | cut -f1)"

# Version: v1.0.0
