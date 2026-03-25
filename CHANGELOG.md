# Changelog

All notable changes to the Zasqua frontend will be documented in this file. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
