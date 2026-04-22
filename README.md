# Zasqua Frontend

Static site frontend for [Zasqua](https://zasqua.org), an open-source archival platform for hosting and discovering large collections of digitized historical documents.

## Overview

Zasqua Frontend generates the public site at [zasqua.org](https://zasqua.org), providing access to over 106,000 archival descriptions, 78,000 entity authority records, and 6,900 place authority records drawn from five repositories in Colombia and Peru. The entire site is static — every description, entity, and place is a pre-rendered HTML page. No server is required at runtime. Search runs client-side in the browser, hierarchical navigation loads pre-built JSON on demand, and all images are served as IIIF Level 0 static tiles.

This architecture is a deliberate application of minimal computing principles. Serving a corpus of this size with faceted search, force-directed entity graphs, clustered-marker maps, and high-resolution image viewing — all without a single server-side process — makes the site fast, cacheable, cheap to host, and resilient. Because the public site is just files, it can be archived, mirrored, or rebuilt from exports with no dependencies on running services.

## Key features

- Static HTML pages for every archival description, entity authority record, and place authority record
- Client-side search with faceting, accent-tolerant matching, and hierarchical date filtering (century / decade / year)
- Entity explorer with a force-directed graph and infinite entity-document-entity navigation
- Place explorer with a MapLibre vector basemap and clustered markers, plus hover tooltips
- Miller-column tree navigation for browsing archival hierarchies
- IIIF deep-zoom viewer for digitized images
- Full-text search across OCR content from digitized materials
- Bilingual presentation — English UI labels, Spanish archival content
- Semantic HTML, keyboard navigation, and ARIA labels where HTML structure does not convey function; no formal accessibility audit has been conducted yet — please write to us if you find a barrier

## Architecture

The site is built with [Hugo Extended](https://gohugo.io/) 0.160.1, which generates every page at build time. Search is implemented with [Pagefind](https://pagefind.app/) 1.5 and runs entirely in the browser via WebAssembly — there is no search server. At runtime a small Cloudflare Worker fronts two R2 buckets (production and staging) and serves the prebuilt site along with IIIF images and map tiles. The build toolchain is Node 22 for enrichment, Hugo Extended for templating and CSS (Tailwind v4 through Hugo Pipes), and Python 3 for the R2 uploader.

## Project structure

```
assets/            Hugo asset pipeline inputs — Tailwind CSS entry, JS bundles,
                   and enriched JSON (assets/hugo-data/) consumed by content adapters
content/           Hugo content — descripcion/, entidad/, lugar/ adapters that
                   stream sharded archival JSON; plus flat pages (buscar, colofon, etc.)
data/              Small UI lookup tables (e.g. ui.yaml) loaded into .Site.Data;
                   not used for the large archival corpus
layouts/           Go templates — base layout, partials, per-section templates
scripts/           Build pipeline — precompute-links.js, generate-content.js,
                   generate-pagefind-indices.js, upload-to-r2.py
static/            Passthrough assets served as-is; populated at build time with
                   runtime JSON shards under static/data/
tests/             Vitest suites (enrichment, Pagefind facets, build artefacts) and
                   pytest suite for the R2 uploader
worker/            Cloudflare Worker fronting the R2 buckets (prod + staging)
hugo.toml          Hugo site configuration
build.sh           Seven-stage end-to-end build pipeline
package.json       Node dependencies and npm scripts
```

## Requirements

- Node.js 22 (matches `.nvmrc`)
- Hugo Extended 0.160.1 — Extended is required for Tailwind and SCSS support
- Python 3 — used by `scripts/upload-to-r2.py` and the B2 download step

## Development

The frontend reads pre-exported JSON archival data at build time. Place the exports (descriptions, entities, places, repositories, link tables, and child trees) in `exports/` — CI downloads them from Backblaze B2; local developers typically copy them from wherever the backend export lives.

```bash
# Install Node dependencies
npm install

# Full build — runs build.sh end to end
npm run build

# Fast subset build — 100 records, skips the B2 download
DEV_LIMIT=100 npm run build:dev

# Hugo dev server with live reload
npm run dev

# Vitest suites (enrichment, Pagefind facets, build artefacts)
npm test

# Python tests for the R2 uploader
cd tests/upload-to-r2 && pytest
```

The built site is written to `public/`.

## Build pipeline

`build.sh` — and the matching `deploy-staging.yml` workflow — run the same seven stages:

1. **Download archival exports from Backblaze B2** into `exports/`. Skip with `SKIP_DOWNLOAD=1` when `exports/` is already populated.
2. **Pre-compute link shards** — `scripts/precompute-links.js` produces per-entity and per-place link shards, date-tree pivots, and per-entity `doc-entities/{code}.json` sidecars.
3. **Install Node dependencies** via `npm ci`.
4. **Enrichment** — `scripts/generate-content.js` denormalises the archival JSON into the inputs Hugo consumes, writing sharded descriptions plus single-file entities and places under `assets/hugo-data/`.
5. **Populate runtime shards** under `static/data/` so client-side JS (tree navigation, entity explorer, place explorer) can fetch shards on demand.
6. **Hugo build** — `hugo --minify` renders every page. Tailwind v4 is compiled through Hugo's resource pipeline with fingerprinted, SRI-tagged CSS.
7. **Pagefind indices** — `scripts/generate-pagefind-indices.js` writes three corpus-pure bundles plus six pivot sidecars using Pagefind's Node API.

## Search

Search is split into three separate Pagefind bundles — one for descriptions, one for entities, one for places — each generated from the enriched JSON rather than by scanning HTML. Alongside each bundle the build ships a pair of sidecars: a pair-wise pivot file and a triple-wise pivot file. These let the UI resolve first-click facet counts from a small gzipped lookup without waiting for Pagefind's WebAssembly engine to initialise, which makes deep-linked filtered views render quickly on a cold load. Queries are accent-tolerant and run entirely client-side — there is no search backend.

## Deploy pipeline

Two GitHub Actions workflows manage deploys:

- **`deploy-staging.yml`** runs on manual dispatch and builds from `main` into the `zasqua-staging` R2 bucket. The pipeline runs vitest after enrichment as a fail-fast gate, then Hugo, then Pagefind, then a diff-aware upload that only transfers changed objects and a Cloudflare cache purge if anything moved.
- **`promote-to-prod.yml`** runs manually and requires the operator to type `PROMOTE` in the confirm field. It does not rebuild — it copies `zasqua-staging` to `zasqua-site` bit-for-bit via S3 `copy_object`, so what has been verified on staging is exactly what lands on production. The Cloudflare cache for production is purged only after a fully successful copy; partial failures leave the cache untouched so the next run's diff can catch up.

The staging environment is gated from search engines at both `/robots.txt` and the `X-Robots-Tag` HTTP header, injected by the Worker when `STAGING=true`.

## Hosting

A single Cloudflare Worker fronts two R2 buckets: `zasqua-site` (production) and `zasqua-staging` (pre-production). The Worker also proxies IIIF images from the same object store and serves vector map tiles (PMTiles) from a third bucket, `zasqua-map-tiles`, with HTTP Range request support.

## Environment variables

Runtime (build and local dev):

| Variable | Purpose |
|---|---|
| `B2_APPLICATION_KEY_ID` | Backblaze B2 key ID for downloading archival exports |
| `B2_APPLICATION_KEY` | Backblaze B2 application key |
| `SITE_URL` | Base URL override for the site (defaults to the value in `hugo.toml`) |
| `SKIP_DOWNLOAD` | Any value skips the B2 download in stage 1 |
| `DEV_LIMIT` | Integer cap on records processed during enrichment — for fast local iteration only |

R2 upload (used by `scripts/upload-to-r2.py` and the workflows):

| Variable | Purpose |
|---|---|
| `R2_ACCESS_KEY_ID` | R2 access key for the target bucket |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_ENDPOINT` | R2 S3-compatible endpoint (derived from `CLOUDFLARE_ACCOUNT_ID`) |

Cloudflare cache purge:

| Variable | Purpose |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account that owns the R2 buckets and Worker |
| `CF_API_TOKEN` | API token with cache-purge permission |
| `CF_ZONE_ID` | Zone ID for zasqua.org |

No secrets are stored in the repository. In CI they are provided as GitHub Actions secrets; locally they are expected in the developer's shell environment.

## Contributing

Contributions are welcome. Please open an issue or pull request at [github.com/neogranadina/zasqua-frontend](https://github.com/neogranadina/zasqua-frontend). Note that this repository handles presentation only — edits to the archival content itself happen upstream in the cataloguing system, and the exports produced there are what this site builds from.

## License

GPL-3.0. See [LICENSE](LICENSE) for the full text.

## Credits

Zasqua is developed by [Neogranadina](https://neogranadina.org) and the [Archives, Memory, and Preservation Lab](https://ampl.clair.ucsb.edu) of the University of California, Santa Barbara.
