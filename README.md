# Zasqua Frontend

Static site frontend for [Zasqua](https://zasqua.org), an open-source archival platform for hosting and discovering large collections of digitized historical documents. Built with [Eleventy](https://www.11ty.dev/) (11ty) and [Pagefind](https://pagefind.app/).

## Overview

Zasqua Frontend generates the public site at [zasqua.org](https://zasqua.org), providing access to over 106,000 archival descriptions, 78,000 entity authority records (persons, corporate bodies, families), and 6,900 place authority records across five repositories in Colombia and Peru. The entire site is static — no server required at runtime. Search runs client-side via Pagefind's WASM engine, hierarchical navigation loads pre-built JSON trees on demand, entity and place detail pages lazy-load per-authority link shards, the place explorer map renders clustered markers from PMTiles, and all images are served as IIIF Level 0 static tiles.

This architecture is a deliberate application of minimal computing principles: the platform serves over 100,000 descriptions with faceted search, Miller column hierarchy browsing, entity and place discovery, and high-resolution image viewing — all without a single server-side process. The result is a site that is fast, cacheable, cheap to host, and resilient. Because the public site is just files — HTML, JSON, static image tiles, PMTiles — it can be archived, mirrored, or rebuilt from exports with no dependencies on running services.

**Key features:**

- Static HTML pages for every archival description, entity, and place
- Client-side search with faceting, accent tolerance, and hierarchical date filtering
- Entity explorer with curated force-directed graph and infinite entity → document → entity navigation
- Place explorer with MapLibre GL clustered marker map
- Description pages link out to linked entity and place authority records
- Miller column tree navigation for browsing archival hierarchies
- IIIF deep-zoom viewer for 121,000+ digitized images
- Full-text search across OCR content from digitized materials
- Bilingual metadata (English and Spanish)
- Responsive design with mobile-optimized viewer

## Requirements

- Node.js 18+
- npm

## Data

The frontend reads pre-exported JSON data at build time. Most of it is produced by the Django backend's `export_frontend_data` management command and downloaded from Backblaze B2 into a `data/` directory (gitignored):

```
data/
  descriptions.json          # All descriptions with metadata + OCR text (~200 MB)
  repositories.json          # Repository records (~14 KB)
  entities.json              # Entity authority records (~30 MB)
  places.json                # Place authority records (~2.5 MB)
  entity_links.json          # Description ↔ entity link table (~77 MB)
  place_links.json           # Description ↔ place link table (~55 MB)
  children/                  # Tree children per parent (1,620 files, ~42 MB)
```

The build additionally produces several derivative files under `data/`:

```
data/
  entity-links/{entity_code}.json   # Per-entity link shards
  place-links/{place_id}.json       # Per-place link shards
  entity-index.json                 # Trimmed entity list for the explorer
  place-index.json                  # Trimmed place list for the explorer
  desc-entity-lookup.json           # Reverse map used by description pages
  desc-place-lookup.json            # Reverse map used by description pages
  places.geojson                    # Input to tippecanoe
  zasqua-places.pmtiles             # PMTiles uploaded to zasqua-map-tiles bucket
```

The `DATA_DIR` environment variable overrides the default `./data/` path.

## Build

```bash
# Install dependencies
npm install

# Full build (Eleventy + three Pagefind indexes)
npm run build

# Development build (limited to 100 descriptions for speed)
npm run build:dev

# Development server with live reload
npm run dev
```

The built site is output to `_site/`.

### Build stages

`npm run build` runs two stages locally (CI and `build.sh` add a data-download and precompute step before these):

1. **Eleventy** generates static HTML from the JSON data and Nunjucks templates
2. **Pagefind** indexes the built pages — three times, producing three separate indexes:
   - `/pagefind/` — main description index (excluding entity and place pages)
   - `/pagefind-entities/` — entity explorer index
   - `/pagefind-places/` — place explorer index

Tree children, entity link shards, and place link shards are copied to `_site/data/` via Eleventy's passthrough copy — no separate build step required.

The full pipeline (data download → precompute → PMTiles → Eleventy → Pagefind → R2 upload) is documented in `build.sh` and `.github/workflows/deploy.yml`.

### Build performance

| Stage | Full build |
|-------|-----------|
| Precompute link shards + indexes | ~10 sec |
| PMTiles generation | ~5 sec |
| Eleventy (191K+ pages) | ~9 min |
| Pagefind (three indexes) | ~7 min |
| **Total** | **~16 min** |

## Project Structure

```
src/
  _data/                  Data layer (reads local JSON files)
    descriptions.js         106K+ descriptions enriched with ancestors, repos, and entity/place links
    repositories.js         5 repositories (with root descriptions)
    entities.js             78K entities enriched with linked-description counts and aggregated roles
    places.js               6.9K places enriched with linked-description counts
    site.js                 Site metadata (title, URL, language, version)
    ui.js                   UI strings (Spanish) — ISAD(G), ISAAR-CPF, place vocabulary
  _includes/              Nunjucks partials
    header.njk              Site header with responsive hamburger menu
    footer.njk              Site footer
    breadcrumb.njk          Breadcrumb navigation
  _layouts/               Page layouts
    base.njk                Base HTML layout
  css/
    input.css               Tailwind source
    main.css                Compiled stylesheet (regenerated every build)
  explorar/               Explorer pages
    entidades.njk           Entity explorer (/entidades/)
    lugares.njk             Place explorer (/lugares/)
  img/                    Static images
  js/                     Client-side JavaScript
    search.js               Pagefind search with facets, filters, pagination
    tree.js                 Miller columns tree navigation
    description.js          Description page interactions
    entity.js               Entity detail page — timeline + network graph views
    place.js                Place detail page — map + sorted description list
    entity-explorer.js      Entity explorer sidebar with facets, results, selected card
    place-explorer.js       Place explorer with clustered map + viewport-filtered list
    infinite-bipartite-explorer.js  Infinite entity→document→entity graph
    header.js               Responsive header toggle
  vendor/tify/            Self-hosted TIFY IIIF viewer
  404.njk                 Error page
  index.njk               Home page (repository grid)
  repository.njk          Repository landing pages
  entidad.njk             Entity detail pages
  lugar.njk               Place detail pages
  description.njk         Description detail pages (106K+)
  buscar.njk              Search page (/buscar/)
scripts/
  precompute-links.js     Builds link shards and explorer indexes from exports
  places-to-geojson.js    Converts places.json to GeoJSON for tippecanoe
  upload-to-r2.py         Parallel uploader used by CI
  check-css-tokens.sh     CSS token verification
eleventy.config.js        Eleventy configuration, filters, and filters for
                          template engines
build.sh                  Local build pipeline
worker/                   Cloudflare Worker that serves the site at the edge
```

## Pages

| Page | URL | Template |
|------|-----|----------|
| Home | `/` | `index.njk` |
| Repository | `/{repo-code}/` | `repository.njk` |
| Description | `/{reference-code}/` | `description.njk` |
| Entity detail | `/{entity-code}/` | `entidad.njk` |
| Place detail | `/nl-{id}/` | `lugar.njk` |
| Search | `/buscar/` | `buscar.njk` |
| Entity explorer | `/entidades/` | `explorar/entidades.njk` |
| Place explorer | `/lugares/` | `explorar/lugares.njk` |

## Search

Search uses [Pagefind](https://pagefind.app/) — a static search library that runs entirely in the browser via WebAssembly. No search server is required.

The build produces three separate Pagefind indexes so each discovery surface has its own scoped index:

- **`/pagefind/`** — main description index used by `/buscar/`. Excludes entity and place detail pages (they have their own indexes) but includes their hidden body text so linked authorities still surface in description results.
- **`/pagefind-entities/`** — entity explorer index used by `/entidades/`. Indexes only entity pages.
- **`/pagefind-places/`** — place explorer index used by `/lugares/`. Indexes only place pages.

**Search features:**

- Multi-word AND queries
- Quoted phrase search
- Accent-insensitive matching (García finds Garcia)
- Spanish stemming
- Faceted filtering: repository, description level, digital status, date (century/decade/year), linked entity, linked place
- Sorting by date, title, reference code, or relevance

## Data Pipeline

The full publish workflow:

1. **Catalog** in Django admin (backend running locally)
2. **Export** data with `manage.py export_frontend_data`
3. **Upload** JSON to the `zasqua-export` Backblaze B2 private bucket
4. **Build** triggered manually via GitHub Actions — downloads data from B2, runs precompute, tippecanoe, Eleventy, and Pagefind
5. **Deploy** to Cloudflare R2 (`zasqua-site` bucket) via `scripts/upload-to-r2.py`; PMTiles upload to `zasqua-map-tiles`
6. **Cache purge** on Cloudflare to serve the new build immediately

The Django backend is only needed during cataloging and export — not at runtime. The Cloudflare Worker at `worker/worker.js` serves every request from R2 with edge caching and translates `/tiles/*` requests into R2 Range reads for the PMTiles.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data/` | Path to exported JSON data |
| `DEV_MODE` | `false` | Limit descriptions, entities, and places to 100 each for faster builds |
| `DEV_LIMIT` | `500` | Shard cap for `precompute-links.js` in `DEV_MODE` |
| `SITE_URL` | `http://localhost:8080` | Base URL for the site |

## Related

- [Zasqua Backend](https://github.com/neogranadina/zasqua-backend) — Django application for cataloguing and data export

## License

GPL-3.0. See [LICENSE](LICENSE) for details.

---

Zasqua is developed by [Neogranadina](https://neogranadina.org) and the [Archives, Memory, and Preservation Lab](https://ampl.clair.ucsb.edu) of the University of California, Santa Barbara.
