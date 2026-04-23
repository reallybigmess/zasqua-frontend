# Changelog

All notable changes to the Zasqua frontend will be documented in this file. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.1] — 2026-04-22

Post-v1.0 hotfix pass. Fixes a class of 404s on non-ASCII URLs, brings search-engine indexability into proper shape, and cleans up a couple of build-pipeline loose ends.

### Fixed

- **Non-ASCII URL 404s.** The Cloudflare Worker was passing the percent-encoded `url.pathname` to R2 as a literal key, while R2 stores keys as raw UTF-8. Every URL containing a diacritic — e.g. `co-cihjml-acc-09474-eclesiástico-i-cap` — returned 404 on both zasqua.org and staging.zasqua.org. The Worker now decodes the pathname up front; all diacritic-containing slugs resolve correctly.

### Added

- **Sitemap index with shards.** A new post-build step (`scripts/shard-sitemap.py`) splits the sitemap into shards of at most 45,000 URLs and rewrites `sitemap.xml` as a sitemap index. The single 191,501-URL sitemap previously overshot Google's 50,000-URLs-per-file limit by roughly four-fold; crawlers were silently truncating the file and ingesting only the first 50K entries, leaving about three-quarters of the archive unindexed.
- **`<link rel="canonical">` on every page.** Injected in the base layout head. Resolves duplicate-content ambiguity for search engines on any URL-variant entry points.
- **Hugo-rendered `robots.txt` with `Sitemap:` directive.** Cloudflare's Managed Robots.txt feature prepends its AI-bot rules at the edge, so the served file ends up with both Cloudflare's bot controls and our `Sitemap:` pointer.

### Removed

- Stale `scan-links` smoke step from the staging deploy workflow. The `scripts/scan-links.js` it called had been removed during the v1.0 cleanup but the workflow step was left behind, causing every deploy to fail at that step regardless of whether the upload itself succeeded.
- Five build-output files previously tracked by mistake under `public/` (`public/js/entity-explorer.js`, `public/js/place-explorer.js`, and three Pagefind sidecar JSON files). The `static/` tree is the real source for the JS; Pagefind regenerates the sidecars every build.

## [1.0.0] — 2026-04-21

The v1.0 rebuild. Over the last six weeks Zasqua was re-engineered from the ground up: static generator swapped, search architecture rewritten, three explorer surfaces audited and tuned for corpus-scale browsing, and a proper staging → prod deploy pipeline introduced. Existing permalinks, external links, and search engines continue to resolve.

### Changed

- **Static site generator — Eleventy → Hugo Extended 0.160.** Every Nunjucks template ported to Go templates, all 18 Eleventy filters and shortcodes replaced or moved into the enrichment pre-compute layer, Tailwind v4 compiled through Hugo's resource pipeline with SRI integrity attributes and per-build cache-busting hashes.
- **Search — Pagefind upgraded to 1.5, split into three corpus-isolated indices.** Descriptions, entities, and places now each have their own Pagefind bundle, generated directly from the enriched JSON by a Node-API generator rather than by walking rendered HTML. Cross-facet counts now narrow correctly on all three surfaces; the pre-1.0 regression where filter counts froze on the unfiltered baseline is gone.
- **Cold-click performance — pivot and triple sidecars on every explorer.** Six gzipped sidecars (one pair and one triple per surface) ship alongside each Pagefind bundle and resolve first-click facet counts without waiting for Pagefind's WebAssembly to initialise. First-click deep-linked views now render in tens of milliseconds instead of ten-plus seconds.
- **`/buscar/` (document search).** Eleven pre-audit bugs resolved in one pass: country and "Imágenes disponibles" filters now work, a `reference_code` sort key was added, backend field-name mismatches were corrected, and raw English facet values were translated to Spanish labels.
- **`/entidades/` (entity explorer).** Year-range arrays per entity drive century/decade date facets. Sort toggle now matches the search page (most recent / alphabetical / reference code). Entity graph expandability rebuilt on per-entity `doc-entities/{code}.json` sidecars — a 900-document focal that used to take 20–45 seconds of serial Pagefind round-trips now renders in under a second.
- **`/lugares/` (place explorer).** Singleton places no longer leak into the explorer index, restoring the Eleventy-era invariant. MapTiler vector basemap replaces the previous tiles with hover tooltips showing place names and document counts. Viewport-scoped facet counts reflect only places currently visible on the map. Century and decade date-tree facets added.
- **Timelines and dates.** A three-bucket chronological sort on entity and place detail-page timelines puts ISO-dated entries in true chronological order, freeform-date entries in fallback string order, and undated entries at the tail. Upstream backend fixes normalised 7,271 hyphen-range dates (`1540-1549`) and 656 DD/MM/YYYY strings, which now render via `formatDateNarrative` instead of as raw literals.
- **Record provenance.** An ISAD(G) Control section was added to every description, entity, and place detail page, carrying the per-record last-maintenance date, responsible institution, and canonical identifiers. The site-wide build-date footer was removed in favour of per-record provenance dates — the previous footer changed on every build and defeated the CDN diff-upload.
- **Deploy pipeline.** A staging environment was introduced that hosts every build from `main` via `deploy-staging.yml`. Promote-to-prod is an explicit manual operation that copies the staging bucket to the production bucket bit-for-bit, requires a literal `PROMOTE` confirmation, and purges the production Cloudflare cache only on a fully successful copy. `scripts/upload-to-r2.py` gained an ETag-based diff pass (skips unchanged files), a 5% delete safety cap with explicit override, and bucket-to-bucket copy mode.

### Added

- Pre-production staging environment as a verifiable surface before any promote.
- ISAD(G) Control section on description, entity, and place detail pages.
- Sort toggle parity across `/buscar/`, `/entidades/`, and `/lugares/`.
- Century and decade date-tree facets on all three explorer surfaces.
- Hover tooltips on map markers in the place explorer and place detail pages.
- Per-entity `doc-entities/{code}.json` sidecars driving graph expandability.
- Pair-wise and triple-wise pivot sidecars driving cold first-click facet counts.
- Vitest and pytest test suites covering enrichment, Pagefind facets, and the R2 uploader.

### Fixed

- Graph expandability on large entities (800+ documents) that previously failed or took tens of seconds now renders in under a second.
- Chronological timeline sort on entity and place detail pages that was string-sorting freeform Spanish dates now uses three-bucket ISO-date sorting.
- 7,927 description pages that rendered malformed date strings (DD/MM/YYYY and hyphen-range) now render formatted dates.
- `/buscar/` cross-facet counts that stuck on the unfiltered baseline after the first filter click.
- Post-"Ver todos" sidebar collapse on `/buscar/` when repository was the single active facet.
- Active-single-value "(0)" badge regression on `/buscar/` and `/entidades/`.
- Singleton places leaking into the `/lugares/` explorer.
- Stale entity codes in `/entidades/` example buttons refreshed against the current authority export.
- Map world copies disabled on place explorer and detail maps — South American markers no longer duplicate over the Pacific.

### Removed

- Eleventy and all Nunjucks templates. The `src/` tree is gone.
- Pagefind HTML-scan indexing — replaced by the Node-API generator.
- Merged single-index Pagefind bundle — replaced by three corpus-isolated indices.
- Site-wide build-date footer — replaced by per-record provenance dates.
- Eleventy-era `deploy.yml` and `test-upload.yml` workflows — replaced by `deploy-staging.yml` and `promote-to-prod.yml`.

### Security

- Staging is excluded from search-engine indexing at both `/robots.txt` and `X-Robots-Tag` HTTP header layers, so pre-release builds cannot be indexed or crawled.

## [0.5.1] — 2026-04-16

Post-release fixes for entity and place discovery, updated data pipeline for new authority codes.

### Changed

- Place authority codes are now random 5-character alphanumeric strings (e.g. `nl-qfsbu`) generated by the backend, replacing the old sequential `nl-{id}` pattern. Entity codes changed similarly (e.g. `ne-da5jn`)
- Place explorer index reduced from ~6,900 to ~3,500 places by hiding coordinate-less singletons (places with no map coordinates and at most one linked document). Their detail pages remain accessible via direct links from descriptions
- Place data pipeline simplified: `place-index.json` and link shards key on `place_code` directly, with no numeric ID fallback layer
- Removed unused PMTiles generation and curated entity graph steps from the CI pipeline
- Eleventy heap raised from 6 GB to 7 GB for the larger dataset

### Added

- Hover tooltips on place explorer map markers: unclustered points show the place name and document count, clusters show the place count
- Viewport-scoped facet counts on the place explorer: facets reflect only places visible in the current map bounds when the viewport filter is active

### Fixed

- Place explorer field consistency: `place-index.json` outputs `latitude`/`longitude` directly instead of `lat`/`lon`, removing a fragile aliasing step on load
- Entity explorer: date facet now renders above primary function in the sidebar
- Entity explorer: overload guard runs the Pagefind search to get scoped facet counts, so facets still narrow when filters are applied
- Map world copies disabled (`renderWorldCopies: false`) on both the place explorer and place detail maps, preventing South American markers from appearing duplicated over Australia/Pacific
- Description pages link to places using `place_code` instead of hardcoded `nl-{id}`

## [0.5.0] — 2026-04-15

Entity and place discovery: every authority record now has a detail page, two new explorers surface them, and description pages link out to their linked entities and places.

### Added

- **Entity detail pages** at `/{entity_code}/` — ISAAR-CPF authority records for ~78,000 persons, corporate bodies, and families. Each page carries a segmented Timeline/Network-graph view of the entity's document appearances, role-filter pills, and lazy-loaded per-entity link shards
- **Place detail pages** at `/nl-{id}/` — authority records for ~6,900 geographic entities, with an always-visible MapLibre map (or an "Ubicación no disponible" notice when coordinates are missing), a sortable description list (chronological / alphabetical), and external authority links (Wikidata, Getty TGN, World Historical Gazetteer, HGIS de las Indias)
- **Entity explorer** at `/entidades/` — two-panel interface with a force-directed graph on one side and a Pagefind-backed facet search on the other. Selecting an entity loads an infinite bipartite graph (entity → document → entity) so visitors can keep pulling threads across the archive. Facets include entity type, primary function, date range, and role
- **Place explorer** at `/lugares/` — map-centric interface with clustered burgundy markers rendered from PMTiles. The sidebar lists places from Pagefind with facets for type, coordinate availability, and external authority presence, plus a viewport-scoped filter that restricts the list to places currently visible on the map
- **Description ↔ authority linking** — description pages now surface their linked entities and places as inline sections with roles, and emit Pagefind filter spans so the search page can narrow results to descriptions that mention a specific entity or place
- Function-principal facet modal on the entity explorer — searchable, alphabetically grouped with letter headers, to keep the 1,573-value facet navigable
- `/tiles/*` route on the Cloudflare Worker with HTTP Range support so the PMTiles JS library can fetch only the bytes it needs
- Three Pagefind indexes at build time: descriptions (`/pagefind/`), entities (`/pagefind-entities/`), and places (`/pagefind-places/`)
- Narrative headers and version footers across every source file in the codebase
- `escapeTemplate` filter that escapes `{{` and `{%` sequences in OCR text before the layout pass — fixes a build crash on descriptions with literal template syntax in scanned pages

### Changed

- Templates renamed to Spanish filenames to match URLs and the rest of the codebase: `entity.njk` → `entidad.njk`, `place.njk` → `lugar.njk`
- Site version bumped from 0.4.0 to 0.5.0
- Header navigation picks up a Browse dropdown grouping the three discovery surfaces (documents, entities, places)
- Breadcrumb partial adopts the burgundy and stone Tailwind colour tokens
- Build pipeline downloads the new entity and place exports from B2, pre-computes per-authority link shards and explorer index files, generates PMTiles from places, and uploads the tiles to the `zasqua-map-tiles` R2 bucket

### Fixed

- Entity explorer "Ver en explorador" button now renders burgundy instead of white-on-white
- Place explorer: facet checkboxes no longer revert after rapid clicks (generation counter guards against stale in-flight searches)
- Place explorer: map markers now sync with search and filter state; index clicks select on the map instead of navigating to the detail page
- Place detail page: removed the broken segmented map/timeline toggle (where `mapEl` was out of scope)
- Merged duplicate role pills on place detail pages — `subject` and `mentioned` both display as "Lugar mencionado" and now share a single pill
- Pagefind glob patterns in the build script corrected to match the actual URL structure (`ne-*/` and `nl-*/` rather than the non-existent `entidad/` and `lugar/`)

## [0.4.0] — 2026-03-25

New visual identity and 542 AHRB notarial volumes published on zasqua.org.

### Added

- New visual identity: DM Sans (UI), Crimson Text (body), burgundy/periwinkle/stone colour palette
- Branding assets: pomegranate logo lockup (`zasqua-3-burgundy-sm.svg`), new hero image
- Tailwind CSS v4 compilation step in CI build pipeline — `input.css` compiled at build time via GitHub Actions
- CSS token verification script (`scripts/check-css-tokens.sh`)
- 542 AHRB notarial volumes live at zasqua.org/co-ahrb/ with IIIF viewer links on digitised items

### Changed

- Header and footer redesigned with new visual identity
- Homepage hero section and masonry repository grid updated with new typography and colour tokens
- Repository page (Miller columns) updated with periwinkle selection highlight and burgundy links
- Description page updated with periwinkle level badges and burgundy links
- Search page updated with burgundy filter pills and periwinkle pagination
- Site version bumped from 0.3.2 to 0.4.0
- Total page count increased from ~104K to ~106K with AHRB data

## [0.3.2] — 2026-03-10

Migrated site hosting from Netlify to Cloudflare R2 + Worker, and replaced rclone with a parallel upload script for faster deploys.

### Added

- Custom 404 page
- Parallel R2 upload script (`scripts/upload-to-r2.py`) — 345 files/s at concurrency 100, full deploy in ~10 minutes (down from 2+ hours with rclone)

### Changed

- Site hosting migrated from Netlify to Cloudflare R2 + Worker — incremental deploys via rclone sync, edge caching via Cloudflare Cache API
- Deploy workflow rewritten to use parallel upload script instead of rclone

### Removed

- Netlify configuration (`netlify.toml`) and Netlify CLI deploy step

## [0.3.0] — 2026-02-21

Standards-based metadata publishing, description page improvements, and title improvement for 86K Colombian descriptions.

### Added

- Reutilisation section on all description pages — METS URL with copy button, IIIF manifest URL for digitised items, FAIR/IIIF/METS blurb with links
- Repository name as first linked field in description metadata (all levels)
- Reproduction conditions rewrite — three-part structure: catalogues (libre acceso), originals (where data exists), images (per-repository licence and contact)
- Location of copies field (ISAD 3.5.2) with per-repository digitisation credits
- Ancestor chain search filter — Pagefind `ancestor` filter indexes full hierarchy, enabling scoped search at any level
- "Buscar en esta coleccion" link on repository pages now uses ancestor filter
- Miller columns on container description pages — replaces two-level accordion with lazy-loaded Miller columns
- "Buscar en esta unidad" link on container pages using ancestor filter
- Footer version number display

### Changed

- IIIF manifest paths now use reference_code slug instead of object_idno
- Description page section order: Personas y entidades moved above Condiciones de acceso
- Description page layout: metadata column constrained to consistent width; children tree breaks out full-width below
- 86,049 Colombian description titles improved (ACC, AHR, AHRB, AHJCI) — truncated scope_content fragments replaced with proper archival titles

### Removed

- Children tree accordion (`children-tree.njk`) — replaced by Miller columns
- Build-time `_children` computation — children now fetched lazily from static JSON

### Fixed

- AHRB document title prefixes: documents within a legajo now display their own document number instead of the parent legajo number

## [0.2.0] — 2026-02-17

IIIF viewer integration, metadata display expansion, and full-text search in OCR content.

### Added

- TIFY v0.31.0 IIIF viewer on description pages with deep zoom, expand/fullscreen states, and thumbnails panel
- Self-hosted TIFY assets (no external CDN dependency)
- Bibliographic information section (ISAD(G)): imprint, edition, series, uniform title, section title, pages
- Access conditions section: reproduction conditions, language
- Related materials section: location of originals, related materials
- Notes section: finding aids, notes
- Country facet in search filters
- Thumbnails in search results loaded from IIIF tile sets
- OCR full-text search — 14,331 CDIP items indexed by Pagefind at 0.5 weight, capped at 15K characters with deduplication

### Fixed

- Mobile viewer: skip expanded state, show fullscreen button directly (expanded adds no value at mobile widths)
- Pipe-delimited metadata fields (extent, language) split into separate lines for display

## [0.1.0] — 2026-02-14

First release. Static archival discovery site at zasqua.org with 104K+ descriptions across 5 repositories.

### Added

- 11ty (Eleventy) static site with Nunjucks templates, built from pre-exported JSON data
- Pagefind client-side search with faceted filtering: repository, description level, hierarchical date (century/decade/year), digital status
- Search page with sort options (date, title, reference code, relevance), text filter chips with boolean operators (AND/NOT), scoped facet counts
- Browse prompt for large filter-only queries (>10K results) with estimated count
- Description page template with breadcrumb navigation, metadata display, and collapsible children tree
- Repository landing pages with fonds-level overview
- Pre-built static JSON for tree navigation (1,602 parent files)
- OCR text indexed with reduced weight for PE-BN collection (14,272 descriptions)
- Responsive design: hamburger menu at mobile breakpoint, collapsible filter panel with touch-friendly targets
- Parent filter in search — "see all" links in children trees filter search by parent reference code
- Repository abbreviations in search filter pills (via short_name)
- GitHub Actions CI/CD: build with Eleventy + Pagefind, deploy to Netlify via netlify-cli
- Data pipeline: downloads JSON from Backblaze B2 at build time, no runtime server dependency
