#!/usr/bin/env node
/**
 * Generate Pagefind Indices (Node API)
 *
 * Builds Zasqua's three client-side search bundles — descriptions,
 * entities, and places — using Pagefind's Node API rather than the
 * default HTML-scan mode. Pagefind is a client-side search engine
 * that ships a small WebAssembly runtime plus a JSON index produced
 * at build time; HTML-scan indexing would require Hugo to render all
 * 192,000 pages to disk first, then Pagefind to walk them with a
 * second pass. The Node-API approach reads the same enriched JSON
 * Hugo reads, so the JSON becomes the single source of truth and
 * template markup stops implicitly coupling to search correctness (a
 * forgotten `data-pagefind-filter` attribute used to be a silent
 * search regression).
 *
 * Alongside each corpus's Pagefind bundle, the script also emits
 * three classes of JSON sidecars consumed by the browser-side
 * explorers on their cold first-click: a landing-facets sidecar
 * (global counts by facet value), a pair-wise pivot sidecar
 * (intersection counts when one facet filter is active), and a
 * triple-wise pivot sidecar (intersection counts when two are
 * active). Each sidecar carries a 50 KB gzipped size budget; if any
 * drifts over, the build logs a warning and the CI workflow surfaces
 * it as a yellow annotation without blocking the deploy.
 *
 * Pipeline context:
 *   Runs in `build.sh` after `hugo --minify`, reading
 *   `assets/hugo-data/*.json` (sharded descriptions, single-file
 *   entities and places). Writes three Pagefind bundles and their
 *   associated sidecars into `public/`. Each bundle is written to a
 *   PID-scoped temp directory and `fs.renameSync`d into place on
 *   success — a mid-build parse failure leaves no half-written
 *   bundle for the next run to pick up.
 *
 * Pagefind v1.5.2 is ESM-only; this script stays CommonJS and
 * consumes Pagefind via dynamic `import()` inside `main()`.
 *
 * Env flags:
 *   DEV_LIMIT — propagates through the enriched JSON (Stage 4 caps
 *               the shards upstream); DEV_LIMIT bundles are smoke-
 *               test only and not valid inputs to parity tests.
 *
 * Exits 0 on success; 1 on any IO or parse error, with the failing
 * corpus, record ID, and field prefixed to stderr.
 *
 * @version v1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'assets', 'hugo-data');
const OUT_DIR = path.join(PROJECT_ROOT, 'public');
const DEV_LIMIT = process.env.DEV_LIMIT ? Number(process.env.DEV_LIMIT) : null;

// ---------------------------------------------------------------------------
// Pure helpers — year/century/decade derivation. Side-effect-free, unit-
// testable in isolation if a future test ever wants to import them.
// ---------------------------------------------------------------------------

function yearsInRange(startYear, endYear) {
  const s = Number(startYear);
  const e = Number(endYear);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s > e) return [];
  // Defensive cap — a malformed record with e=9999 would otherwise pin
  // ~8,000 filter values per entity. Mirrors the layouts/entidad/single.html
  // `if gt $e (add $s 500)` clamp.
  const cappedEnd = e > s + 500 ? s + 500 : e;
  const out = [];
  for (let y = s; y <= cappedEnd; y++) out.push(y);
  return out;
}

const ROMAN = [
  '', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'
];

function romanCentury(year) {
  // Year 1..100 → century I, 101..200 → II, etc. Matches the
  // entity template's `add (int (math.Floor (div (sub $s 1) 100))) 1`.
  const c = Math.floor((year - 1) / 100) + 1;
  return ROMAN[c] || String(c);
}

function centuriesInRange(startYear, endYear) {
  const set = new Set(yearsInRange(startYear, endYear).map(romanCentury));
  return Array.from(set);
}

function decadesInRange(startYear, endYear) {
  const set = new Set(
    yearsInRange(startYear, endYear).map(y => String(Math.floor(y / 10) * 10))
  );
  return Array.from(set);
}

// Description year derivation. Enriched JSON does NOT carry
// `date_start_year`/`date_end_year` — derive from `date_start`
// (ISO YYYY-MM-DD) when present, otherwise scrape years from
// `date_expression` (e.g. "1780.. 1822", "1620 - 1623", "fl. 1911").
function descriptionYearRange(record) {
  let s = null;
  let e = null;
  if (record.date_start && typeof record.date_start === 'string') {
    const m = record.date_start.match(/^(\d{4})/);
    if (m) s = Number(m[1]);
  }
  if (record.date_expression && typeof record.date_expression === 'string') {
    const matches = record.date_expression.match(/\d{4}/g);
    if (matches && matches.length) {
      if (s == null) s = Number(matches[0]);
      e = Number(matches[matches.length - 1]);
    }
  }
  if (s != null && e == null) e = s;
  if (s == null && e != null) s = e;
  return { startYear: s, endYear: e };
}

// ---------------------------------------------------------------------------
// FIELD_MAP — the contract between assets/hugo-data/*.json and the
// Pagefind bundles. Inline `//` comments document the `why` for each
// non-obvious slot. This table is the canonical source of truth for
// what Pagefind sees.
// ---------------------------------------------------------------------------

// Mirror of data/ui.yaml §levels (lines 70-79). Kept inline because
// js-yaml is not a dependency of this script. If data/ui.yaml §levels
// is edited, edit this map in the same commit.
const LEVEL_LABELS = {
  fonds: 'Fonds',
  subfonds: 'Subfonds',
  series: 'Series',
  subseries: 'Subseries',
  file: 'File',
  item: 'Item',
  collection: 'Collection',
  section: 'Section',
  volume: 'Volume'
};

// Display-name overrides for repositories whose upstream `name`/`short_name`
// in exports/repositories.json is unsuitable for user-facing facet display.
// Preferred over `short_name` (too abbreviated, e.g. "CIHJML") and the raw
// `name` (sometimes ends with institutional affiliation instead of city).
// The upstream source of truth should be corrected when possible; this map
// is the bridge until that happens.
const REPO_NAME_OVERRIDES = {
};

function repoDisplayName(r) {
  return (
    REPO_NAME_OVERRIDES[r.repository_code] ||
    (r.repository && (r.repository.short_name || r.repository.name)) ||
    r.repository_code ||
    ''
  );
}

// Sidebar-facet tally written alongside the descriptions
// Pagefind bundle as public/buscar-facets.json. Consumed by search.js
// so the /buscar/ landing page renders its sidebar in <100ms
// without calling pagefind.filters() (the ~13s WASM tax on cold load).
// Keys MUST match search.js's 5 sidebar facet dimensions and use the
// exact label strings the Pagefind filter index emits, so sidebar
// clicks stay routable through the existing URL-param + filter
// machinery without a code↔label translation layer.
const SIDEBAR_FACET_KEYS = ['country', 'digital_status', 'level', 'repository', 'year'];

// Pair-wise and triple-wise cross-facet pivot keys for the
// public/buscar-pivots.json and public/buscar-triples.json sidecars.
// Alphabetical order matters — tallyCorpusTriples and the search.js
// consumer both rely on canonical alphabetical key ordering when
// walking the triple tree, so the same three active+inactive keys
// always resolve to the same nested path regardless of which two
// dimensions the user activated. Year is deliberately excluded: its
// 430 distinct bucket values would inflate the sidecars far past the
// 50 KB gzipped budget, and the date-tree widget consumes year via a
// different rendering path. Century and decade are included so the
// date-tree chips also get scoped cold counts on N=1 and N=2 deep
// links.
const PIVOT_FACET_KEYS = ['century', 'country', 'decade', 'digital_status', 'level', 'repository'];

// 4-key pivot set for entities. Year is excluded (turned into a
// record-scalar — pivoting on 78K distinct values is size-prohibitive
// and adds no UX lift because century + decade cover the date-tree
// sidebar). Role is excluded (FIELD_MAP gap). Alphabetical order
// matters for the canonical triples walk — see tallyCorpusTriples
// and the search.js / entity-explorer.js consumers.
const ENTITY_PIVOT_FACET_KEYS = ['century', 'decade', 'entity_type', 'primary_function'];

// 3-key pivot set for places. The places adapter emits exactly these
// three filter dimensions and the place-explorer sidebar exposes
// exactly these three groups. Alphabetical order matters for the
// canonical triples walk (see tallyCorpusTriples); C(3,2)=3 pairs,
// C(3,3)=1 triple. Cardinalities (2026-04-19 build): has_authority=2,
// has_coordinates=2, place_type=~10-20.
const PLACE_PIVOT_FACET_KEYS = ['has_authority', 'has_coordinates', 'place_type'];

// Landing-sidecar facet keys for public/lugares-facets.json,
// mirroring SIDEBAR_FACET_KEYS for /buscar/. Same key set as
// PLACE_PIVOT_FACET_KEYS — places sidebar has no key (like
// /buscar/'s `year`) excluded from the pivot set, so the two
// constants happen to be byte-identical. They stay separate decls
// because the contracts are independent — landing sidecar covers the
// cold-landing render; pivot sidecar covers the cold-first-click
// render.
const PLACE_SIDEBAR_FACET_KEYS = ['has_authority', 'has_coordinates', 'place_type'];

// Per-sidecar gzipped size budget for the pagefind-sidecar CI log
// line emitted by checkSidecarSize(). 51200 bytes = 50 KB. Overflow
// triggers a GitHub Actions::warning:: annotation only; the build
// never fails on a sidecar size regression (warn-but-don't-block).
// The constant is emitted verbatim in the log line so CI consumers
// and future audits can reason about which budget version was in
// effect at build time.
const SIDECAR_GZIPPED_BUDGET = 51200;

// Warn-but-don't-block sidecar size check. Reads the just-renamed
// sidecar, gzips it in memory via Node stdlib (no new dep), and
// emits a single grep-able `pagefind-sidecar <name> bytes=<raw>
// gzipped=<gz> budget=51200 status=<ok|over>` line per call. When
// running under GitHub Actions AND the gzipped size exceeds
// SIDECAR_GZIPPED_BUDGET, emits a second `::warning file=<relPath>::...`
// workflow command on stdout — this surfaces as a yellow annotation
// on the run page but does NOT fail the step (the blocking gate is
// deliberately relaxed at CI level). Never throws, never exits,
// never returns non-zero. Idempotent — called once per sidecar write
// site.
function checkSidecarSize(absPath, name) {
  const raw = fs.statSync(absPath).size;
  const gzipped = zlib.gzipSync(fs.readFileSync(absPath)).length;
  const status = gzipped > SIDECAR_GZIPPED_BUDGET ? 'over' : 'ok';
  const relPath = path.relative(PROJECT_ROOT, absPath);
  console.log(
    `pagefind-sidecar ${name} bytes=${raw} gzipped=${gzipped} budget=${SIDECAR_GZIPPED_BUDGET} status=${status}`
  );
  if (process.env.GITHUB_ACTIONS === 'true' && gzipped > SIDECAR_GZIPPED_BUDGET) {
    console.log(
      `::warning file=${relPath}::Sidecar ${name} exceeds 50 KB gzipped budget (gzipped=${gzipped}, budget=${SIDECAR_GZIPPED_BUDGET})`
    );
  }
}

// Generalised tally: the `keys` parameter replaces the former
// close-over on SIDEBAR_FACET_KEYS so the same helper serves both
// SIDEBAR_FACET_KEYS (descriptions) and PLACE_SIDEBAR_FACET_KEYS
// (places). Tally shape is unchanged.
function tallyCorpusFacets(filters, tally, keys) {
  for (const key of keys) {
    const values = filters[key];
    if (!Array.isArray(values)) continue;
    if (!tally[key]) tally[key] = Object.create(null);
    for (const v of values) {
      if (v == null) continue;
      const k = String(v);
      tally[key][k] = (tally[key][k] || 0) + 1;
    }
  }
}

// Accumulate pair-wise cross-facet intersection counts for a pivot
// sidecar. For each record, walks every ordered pair (keyA, keyB) in
// `keys` with keyA != keyB and increments
// pivots[keyA][valueA][keyB][valueB] by 1. Symmetric by construction:
// A×B sum matches B×A. Consumed by the synchronous browse-prompt path
// (search.js on /buscar/, entity-explorer.js on /entidades/) when
// exactly one filter dimension is active on cold first-click.
//
// The `keys` parameter lets the same helper serve both
// PIVOT_FACET_KEYS (descriptions, 6 keys) and
// ENTITY_PIVOT_FACET_KEYS (entities, 4 keys).
function tallyCorpusPivots(filters, pivots, keys) {
  for (const keyA of keys) {
    const valuesA = filters[keyA];
    if (!Array.isArray(valuesA) || valuesA.length === 0) continue;
    if (!pivots[keyA]) pivots[keyA] = Object.create(null);
    for (const a of valuesA) {
      if (a == null) continue;
      const sa = String(a);
      if (!pivots[keyA][sa]) pivots[keyA][sa] = Object.create(null);
      for (const keyB of keys) {
        if (keyB === keyA) continue;
        const valuesB = filters[keyB];
        if (!Array.isArray(valuesB) || valuesB.length === 0) continue;
        if (!pivots[keyA][sa][keyB]) pivots[keyA][sa][keyB] = Object.create(null);
        for (const b of valuesB) {
          if (b == null) continue;
          const sb = String(b);
          pivots[keyA][sa][keyB][sb] = (pivots[keyA][sa][keyB][sb] || 0) + 1;
        }
      }
    }
  }
}

// accumulate triple-wise
// cross-facet intersection counts for a triples sidecar. For every
// unordered triple (keyA, keyB, keyC) of DISTINCT keys from `keys`,
// increments triples[keyA][valA][keyB][valB][keyC][valC] by 1 for
// each (valA x valB x valC) combination carried by the record. Keys
// in the nested path are sorted alphabetically — the outer walk
// iterates ordered combinations (i < j < k on `keys`, which must be
// supplied in alphabetical order), so the consumer's canonical-
// order lookup always resolves to the same path regardless of which
// two dimensions the user activated. Consumed by search.js /
// entity-explorer.js's generalised buildPivotScopedFilters when
// exactly two filter dimensions are active on cold first-click.
// Three or more active dims fall back to global counts (quad-pivot
// deferred).
//
// generalisation: the `keys` parameter replaces the
// former close-over on PIVOT_FACET_KEYS so the same helper serves
// both PIVOT_FACET_KEYS (descriptions, 6 keys → C(6,3)=20 triples)
// and ENTITY_PIVOT_FACET_KEYS (entities, 4 keys → C(4,3)=4 triples).
function tallyCorpusTriples(filters, triples, keys) {
  const n = keys.length;
  for (let i = 0; i < n; i++) {
    const keyA = keys[i];
    const valuesA = filters[keyA];
    if (!Array.isArray(valuesA) || valuesA.length === 0) continue;
    for (let j = i + 1; j < n; j++) {
      const keyB = keys[j];
      const valuesB = filters[keyB];
      if (!Array.isArray(valuesB) || valuesB.length === 0) continue;
      for (let k = j + 1; k < n; k++) {
        const keyC = keys[k];
        const valuesC = filters[keyC];
        if (!Array.isArray(valuesC) || valuesC.length === 0) continue;
        if (!triples[keyA]) triples[keyA] = Object.create(null);
        for (const a of valuesA) {
          if (a == null) continue;
          const sa = String(a);
          if (!triples[keyA][sa]) triples[keyA][sa] = Object.create(null);
          if (!triples[keyA][sa][keyB]) triples[keyA][sa][keyB] = Object.create(null);
          for (const b of valuesB) {
            if (b == null) continue;
            const sb = String(b);
            if (!triples[keyA][sa][keyB][sb]) triples[keyA][sa][keyB][sb] = Object.create(null);
            if (!triples[keyA][sa][keyB][sb][keyC]) triples[keyA][sa][keyB][sb][keyC] = Object.create(null);
            for (const c of valuesC) {
              if (c == null) continue;
              const sc = String(c);
              triples[keyA][sa][keyB][sb][keyC][sc] =
                (triples[keyA][sa][keyB][sb][keyC][sc] || 0) + 1;
            }
          }
        }
      }
    }
  }
}

const FIELD_MAP = {
  // ENTITIES — strict parity with layouts/entidad/single.html.
  entities: {
    url: r => `/${r.entity_code}/`,
    // Search-ranking text: display name plus any name variants so a
    // search for an alternate spelling still surfaces the entity.
    content: r => [r.display_name, ...(r.name_variants || [])].filter(Boolean).join(' '),
    language: () => 'es',
    filters: r => {
      const f = {};
      // Single-value filters wrapped in arrays per Pagefind contract
      // (filters are always Record<string, string[]>).
      if (r.entity_type) f.entity_type = [r.entity_type];
      if (r.primary_function) f.primary_function = [r.primary_function];
      // emit a
      // single startYear — not yearsInRange(...). Root cause of the
      // user-reported "date facet shows hundreds of thousands of
      // items against a 78,245-entity corpus" regression. Century +
      // decade stay as bucket-granularity emissions (they drive the
      // date-tree widget on /entidades/ and do not explode the
      // filter-chunk index the way per-year bindings do).
      if (r.date_earliest != null) {
        f.year = [String(r.date_earliest)];
        const e = r.date_latest != null ? r.date_latest : r.date_earliest;
        const centuries = centuriesInRange(r.date_earliest, e);
        if (centuries.length) f.century = centuries;
        const decades = decadesInRange(r.date_earliest, e);
        if (decades.length) f.decade = decades;
      }
      // role filter omitted — see header note "FIELD_MAP gaps".
      // See §deferred from 15.2 scope.
      return f;
    },
    sort: r => ({
      name: r.sort_name || r.display_name || '',
      date: String(r.date_earliest || ''),
      count: String(r._linked_count || 0),
    }),
    meta: r => {
      const m = {
        // `title` is highly recommended by Pagefind for result rendering.
        title: r.display_name || r.entity_code || '',
        entity_type: r.entity_type || '',
        date_earliest: r.date_earliest != null ? String(r.date_earliest) : '',
        date_latest: r.date_latest != null ? String(r.date_latest) : '',
        primary_function: r.primary_function || '',
        linked_count: String(r._linked_count || 0),
      };
      if (Array.isArray(r.name_variants) && r.name_variants.length) {
        m.name_variants = r.name_variants.join(' | ');
      }
      return m;
    },
  },

  // PLACES — strict parity with layouts/lugar/single.html.
  // Note the JSON uses `latitude`/`longitude`, not `lat`/`lon`; the
  // template uses `tgn_id` as part of `has_authority`, included here.
  places: {
    url: r => `/${r.place_code}/`,
    content: r => [r.display_name, ...(r.name_variants || [])].filter(Boolean).join(' '),
    language: () => 'es',
    filters: r => {
      const hasCoords = r.latitude != null && r.longitude != null;
      const hasAuthority = !!(r.wikidata_id || r.whg_id || r.tgn_id || r.hgis_id);
      const f = {
        has_coordinates: [hasCoords ? 'true' : 'false'],
        has_authority: [hasAuthority ? 'true' : 'false'],
      };
      if (r.place_type) f.place_type = [r.place_type];
      return f;
    },
    // Adds `count` so pagefind.search({ sort: { count: 'desc' } })
    // is honoured. Without this, only `name` was registered and
    // Pagefind silently fell back to alphabetical. Mirrors the
    // entities adapter. The client passes { count: 'desc' } when
    // state.sort === 'linked'.
    sort: r => ({
      name: r.display_name || '',
      count: String(r._linked_count || 0),
    }),
    meta: r => {
      const hasCoords = r.latitude != null && r.longitude != null;
      const m = {
        title: r.display_name || r.place_code || '',
        place_type: r.place_type || '',
        has_coordinates: hasCoords ? 'true' : 'false',
        linked_count: String(r._linked_count || 0),
      };
      if (Array.isArray(r.name_variants) && r.name_variants.length) {
        m.name_variants = r.name_variants.join(' | ');
      }
      return m;
    },
  },

  // DESCRIPTIONS — expand: pre-computed filter/meta fields the
  // HTML-scan could not cheaply surface. See header §"FIELD_MAP gaps"
  // for fields the planner expected but the current enriched JSON does
  // not yet carry; those are flagged for ENRICH and substituted with
  // the closest available analog rather than synthesised.
  descriptions: {
    url: r => `/${r.reference_code}/`,
    // Full OCR retained per. Title and reference_code are prepended
    // so users searching for a series name (e.g. "Encomiendas") or a
    // reference code rank those hits first — HTML-scan picked these up
    // from the rendered <h1>; Node-API needs them in `content` because
    // Pagefind only full-text-indexes `content` (meta is for display).
    content: r => [r.title, r.reference_code, r.scope_content, r.ocr_text].filter(Boolean).join('\n'),
    language: () => 'es',
    filters: r => {
      const f = {};

      // : repository filter value is the display name, not the code.
      // short_name falls back to name (NOT code — that's what caused).
      // post-verification: REPO_NAME_OVERRIDES takes precedence
      // for repositories whose upstream short_name/name is unsuitable.
      const repoName = repoDisplayName(r);
      if (repoName) f.repository = [repoName];

      // : level filter value is the Spanish label. LEVEL_LABELS is an
      // inline mirror of data/ui.yaml §levels (js-yaml is not a dep here).
      const levelLabel = LEVEL_LABELS[r.description_level] || r.description_level;
      if (levelLabel) f.level = [levelLabel];

      // : country filter (Spanish display name already on the record).
      if (r.country) f.country = [r.country];

      // : digital_status filter (raw token, not localised).
      f.digital_status = [r.has_digital ? 'zasqua' : 'none'];

      // : SINGLE startYear, not yearsInRange. Root cause of the
      // >15s faceted-query latency — this is the ~30× blow-up.
      const { startYear, endYear } = descriptionYearRange(r);
      if (startYear != null) f.year = [String(startYear)];

      // century + decade emission, derived from the same
      // (startYear, endYear) range descriptionYearRange() returns.
      // Mirrors the entities FIELD_MAP pattern at lines 338-344. These
      // are consumed by the buscar-pivots.json and buscar-triples.json
      // sidecar tallies so the date-tree sidebar chips (Siglo XVII,
      // 1780s, etc.) get scoped cross-facet counts on cold first-click.
      // Kept separate from the `year` emission so pair-wise / triple-
      // wise joins at century and decade granularity stay affordable
      // even though the underlying year filter stays collapsed to a
      // single startYear per.
      if (startYear != null && endYear != null) {
        const centuries = centuriesInRange(startYear, endYear);
        if (centuries.length) f.century = centuries;
        const decades = decadesInRange(startYear, endYear);
        if (decades.length) f.decade = decades;
      }

      // `parent_reference_code` dropped. No template or JS
      // produces /buscar/?parent=<ref_code> links (grep-verified 2026-04-18);
      // the filter chunk was a dead 538 KB load.

      // Rename ancestor_codes → ancestor (Eleventy parity, description.njk:64-68).
      const ancestors = [];
      if (r.repository_code) ancestors.push(r.repository_code);
      if (Array.isArray(r.ancestor_chain)) {
        for (const a of r.ancestor_chain) {
          if (a && a.reference_code) ancestors.push(a.reference_code);
        }
      }
      if (r.reference_code) ancestors.push(r.reference_code);
      if (ancestors.length) f.ancestor = ancestors;

      // Rename entity_codes → entidad (Eleventy parity, description.njk:69-71).
      if (Array.isArray(r.entity_links) && r.entity_links.length) {
        const codes = r.entity_links.map(l => l && l.entity_code).filter(Boolean);
        if (codes.length) f.entidad = codes;
      }

      // `lugar` dropped. /lugar/:code/ pages render their
      // own linked-description lists from static/data/place-links/*.json;
      // no /buscar/?lugar=<code> link exists (grep-verified 2026-04-18).

      return f;
    },
    sort: r => {
      const { startYear } = descriptionYearRange(r);
      return {
        title: r.title || '',
        date: startYear != null ? String(startYear) : '',
        reference_code: r.reference_code || '',  // D-05: restores "Código" sort
      };
    },
    meta: r => {
      const repoName = repoDisplayName(r);
      const m = {
        title: r.title || '',
        reference_code: r.reference_code || '',
        // Kept as future-deep-link hook (15.1-).
        repository_code: r.repository_code || '',
        // RENAMED from `repository` → `repository_name` (search.js:771 reads this).
        repository_name: repoName,
        // RENAMED from `level` → `description_level` (search.js:638 reads this).
        description_level: r.description_level || '',
        // Pre-computed Spanish narrative.
        date_formatted: r.date_formatted || '',
        // Retained for future sidebar localisation (not read by search.js today).
        digital_status: r.has_digital ? 'zasqua' : 'none',
      };
      if (Array.isArray(r.ancestor_chain) && r.ancestor_chain.length) {
        m.ancestor_chain = r.ancestor_chain
          .map(a => a && a.title)
          .filter(Boolean)
          .join(' \u2192 ');
      }
      return m;
    },
  },
};

// ---------------------------------------------------------------------------
// Loaders. The descriptions corpus is sharded (per generate-content.js
// SHARD_SIZE=20,000); entities and places are single-file. DEV_LIMIT
// propagates through the JSON itself — no slicing here.
// ---------------------------------------------------------------------------

function loadDescriptionShards() {
  const dir = path.join(DATA_DIR, 'descriptions');
  if (!fs.existsSync(dir)) {
    throw new Error(`descriptions shard directory missing: ${dir}`);
  }
  const records = [];
  const shards = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  for (const file of shards) {
    const batch = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!Array.isArray(batch)) {
      throw new Error(`description shard is not an array: ${file}`);
    }
    records.push(...batch);
  }
  return records;
}

function loadJSON(relPath) {
  const full = path.join(DATA_DIR, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`required input missing: ${full}`);
  }
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function pagefindCheck(label, response) {
  if (response && Array.isArray(response.errors) && response.errors.length) {
    throw new Error(`pagefind ${label} returned errors: ${response.errors.join(' | ')}`);
  }
  return response;
}

// ---------------------------------------------------------------------------
// Indexer. Writes to `public/.pagefind-tmp.{pid}.{corpus}/` first and
// `fs.renameSync`s into place on success — no half-written bundles
// for the next parity run to pick up if a record fails mid-loop.
// ---------------------------------------------------------------------------

async function buildIndex(pagefind, corpus, records, outputSubdir) {
  const started = Date.now();
  const finalOut = path.join(OUT_DIR, outputSubdir);
  const tmpOut = path.join(OUT_DIR, `.pagefind-tmp.${process.pid}.${corpus}`);

  // Clean any stale tmp dir from a previous interrupted run.
  if (fs.existsSync(tmpOut)) {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  }

  const createResp = pagefindCheck('createIndex', await pagefind.createIndex());
  const index = createResp.index;
  if (!index) {
    throw new Error(`pagefind createIndex did not return an index for corpus=${corpus}`);
  }
  const map = FIELD_MAP[corpus];

  // tally for the buscar-facets.json sidecar. Only
  // populated when corpus === 'descriptions'; cheap no-op otherwise.
  const tally = Object.create(null);

  // pair-wise cross-facet tally for the
  // buscar-pivots.json sidecar. Same descriptions-only restriction.
  const pivots = Object.create(null);

  // triple-wise cross-facet tally for the
  // buscar-triples.json sidecar. Same descriptions-only restriction.
  // Consumed by static/js/search.js when exactly two filter
  // dimensions are active on cold first-click.
  const triples = Object.create(null);

  let currentField = null;
  let currentId = null;
  try {
    for (const r of records) {
      currentId = r.reference_code || r.entity_code || r.place_code || '(unknown)';
      currentField = 'url';      const url = map.url(r);
      currentField = 'content';  const content = map.content(r);
      currentField = 'language'; const language = map.language(r);
      currentField = 'filters';  const filters = map.filters(r);
      if (corpus === 'descriptions') tallyCorpusFacets(filters, tally, SIDEBAR_FACET_KEYS);
      if (corpus === 'descriptions') tallyCorpusPivots(filters, pivots, PIVOT_FACET_KEYS);
      if (corpus === 'descriptions') tallyCorpusTriples(filters, triples, PIVOT_FACET_KEYS);
      if (corpus === 'entities') tallyCorpusPivots(filters, pivots, ENTITY_PIVOT_FACET_KEYS);
      if (corpus === 'entities') tallyCorpusTriples(filters, triples, ENTITY_PIVOT_FACET_KEYS);
      if (corpus === 'places') tallyCorpusFacets(filters, tally, PLACE_SIDEBAR_FACET_KEYS);
      if (corpus === 'places') tallyCorpusPivots(filters, pivots, PLACE_PIVOT_FACET_KEYS);
      if (corpus === 'places') tallyCorpusTriples(filters, triples, PLACE_PIVOT_FACET_KEYS);
      currentField = 'sort';     const sort = map.sort(r);
      currentField = 'meta';     const meta = map.meta(r);

      pagefindCheck(
        `addCustomRecord(${currentId})`,
        await index.addCustomRecord({ url, content, language, filters, meta, sort })
      );
    }
  } catch (err) {
    console.error(
      `[generate-pagefind-indices] FATAL corpus=${corpus} record=${currentId} field=${currentField}:`,
      (err && err.stack) || err
    );
    process.exit(1);
  }

  pagefindCheck(`writeFiles(${corpus})`, await index.writeFiles({ outputPath: tmpOut }));

  // Atomic swap. rename overwrites would fail on a non-empty directory,
  // so wipe the destination first — same trade-off as `cp -rT --remove-destination`.
  if (fs.existsSync(finalOut)) {
    fs.rmSync(finalOut, { recursive: true, force: true });
  }
  fs.renameSync(tmpOut, finalOut);

  // write sidebar-facet sidecar alongside the descriptions
  // bundle. Atomic via temp-file + rename — same pattern as the bundle
  // write above. Only runs for the descriptions corpus.
  if (corpus === 'descriptions') {
    const orderedTally = Object.create(null);
    for (const key of SIDEBAR_FACET_KEYS) {
      orderedTally[key] = tally[key] || {};
    }
    const facetsJsonPath = path.join(OUT_DIR, 'buscar-facets.json');
    const tmpFacetsPath = path.join(OUT_DIR, `.buscar-facets.tmp.${process.pid}.json`);
    fs.writeFileSync(tmpFacetsPath, JSON.stringify(orderedTally));
    fs.renameSync(tmpFacetsPath, facetsJsonPath);
    console.log(
      `pagefind-index descriptions-facets bundle=${path.relative(PROJECT_ROOT, facetsJsonPath)} keys=${SIDEBAR_FACET_KEYS.join(',')}`
    );
    checkSidecarSize(facetsJsonPath, 'buscar-facets');

    // pair-wise cross-facet pivot sidecar. Same atomic
    // temp + rename pattern as the facets sidecar above. Consumed by
    // static/js/search.js's H2 synchronous browse-prompt path when
    // exactly one filter dimension is active on cold first-click.
    const orderedPivots = Object.create(null);
    for (const key of PIVOT_FACET_KEYS) {
      orderedPivots[key] = pivots[key] || {};
    }
    const pivotsJsonPath = path.join(OUT_DIR, 'buscar-pivots.json');
    const tmpPivotsPath = path.join(OUT_DIR, `.buscar-pivots.tmp.${process.pid}.json`);
    fs.writeFileSync(tmpPivotsPath, JSON.stringify(orderedPivots));
    fs.renameSync(tmpPivotsPath, pivotsJsonPath);
    const pivotsSize = fs.statSync(pivotsJsonPath).size;
    console.log(
      `pagefind-index descriptions-pivots bundle=${path.relative(PROJECT_ROOT, pivotsJsonPath)} size_bytes=${pivotsSize} keys=${PIVOT_FACET_KEYS.join(',')}`
    );
    checkSidecarSize(pivotsJsonPath, 'buscar-pivots');

    // triple-wise cross-facet sidecar. Same atomic
    // temp + rename pattern as the pivots sidecar. Outer keys are
    // canonical-alphabetical across PIVOT_FACET_KEYS; the consumer
    // sorts the (active_a, active_b, inactive_c) triple alphabetically
    // before walking, so every (A,B,C) maps to exactly one path here
    // regardless of which two dims the user activated.
    const orderedTriples = Object.create(null);
    for (const key of PIVOT_FACET_KEYS) {
      orderedTriples[key] = triples[key] || {};
    }
    const triplesJsonPath = path.join(OUT_DIR, 'buscar-triples.json');
    const tmpTriplesPath = path.join(OUT_DIR, `.buscar-triples.tmp.${process.pid}.json`);
    fs.writeFileSync(tmpTriplesPath, JSON.stringify(orderedTriples));
    fs.renameSync(tmpTriplesPath, triplesJsonPath);
    const triplesSize = fs.statSync(triplesJsonPath).size;
    console.log(
      `pagefind-index descriptions-triples bundle=${path.relative(PROJECT_ROOT, triplesJsonPath)} size_bytes=${triplesSize} keys=${PIVOT_FACET_KEYS.join(',')}`
    );
    checkSidecarSize(triplesJsonPath, 'buscar-triples');
  }

  // pair-wise + triple-wise
  // cross-facet pivot sidecars for /entidades/. Atomic tmp+rename
  // mirroring the descriptions write blocks above. 4 pivot keys →
  // 6 pairs, C(4,3)=4 triples. Consumed by plan 15.2-04's
  // entity-explorer consumer: N=1 cold first-click resolves against
  // the pivots sidecar; N=2 cold first-click resolves against the
  // triples sidecar. Size budget is 50 KB gzipped per sidecar on
  // the full 78,245-entity corpus; overflow policy is STOP
  // and re-run, with a
  //.BLOCKED-D05 sentinel written by the plan's verify block to
  // block downstream plans 15.2-04 and 15.2-05.
  if (corpus === 'entities') {
    const orderedEntityPivots = Object.create(null);
    for (const key of ENTITY_PIVOT_FACET_KEYS) {
      orderedEntityPivots[key] = pivots[key] || {};
    }
    const entityPivotsJsonPath = path.join(OUT_DIR, 'entidades-pivots.json');
    const tmpEntityPivotsPath = path.join(OUT_DIR, `.entidades-pivots.tmp.${process.pid}.json`);
    fs.writeFileSync(tmpEntityPivotsPath, JSON.stringify(orderedEntityPivots));
    fs.renameSync(tmpEntityPivotsPath, entityPivotsJsonPath);
    const entityPivotsSize = fs.statSync(entityPivotsJsonPath).size;
    console.log(
      `pagefind-index entities-pivots bundle=${path.relative(PROJECT_ROOT, entityPivotsJsonPath)} size_bytes=${entityPivotsSize} keys=${ENTITY_PIVOT_FACET_KEYS.join(',')}`
    );
    checkSidecarSize(entityPivotsJsonPath, 'entidades-pivots');

    const orderedEntityTriples = Object.create(null);
    for (const key of ENTITY_PIVOT_FACET_KEYS) {
      orderedEntityTriples[key] = triples[key] || {};
    }
    const entityTriplesJsonPath = path.join(OUT_DIR, 'entidades-triples.json');
    const tmpEntityTriplesPath = path.join(OUT_DIR, `.entidades-triples.tmp.${process.pid}.json`);
    fs.writeFileSync(tmpEntityTriplesPath, JSON.stringify(orderedEntityTriples));
    fs.renameSync(tmpEntityTriplesPath, entityTriplesJsonPath);
    const entityTriplesSize = fs.statSync(entityTriplesJsonPath).size;
    console.log(
      `pagefind-index entities-triples bundle=${path.relative(PROJECT_ROOT, entityTriplesJsonPath)} size_bytes=${entityTriplesSize} keys=${ENTITY_PIVOT_FACET_KEYS.join(',')}`
    );
    checkSidecarSize(entityTriplesJsonPath, 'entidades-triples');
  }

  // landing facets + pair-wise +
  // triple-wise cross-facet pivot sidecars for /lugares/. Atomic tmp+rename
  // mirroring the descriptions and entities write blocks above. 3 pivot
  // keys → 3 pairs (C(3,2)=3), 1 triple (C(3,3)=1). Consumed by
  // static/js/place-explorer.js (plans 15.3-03 + 15.3-04): landing render
  // reads lugares-facets.json before the user clicks; N=1 cold first-click
  // resolves against lugares-pivots.json; N=2 cold first-click resolves
  // against lugares-triples.json. Size budget is 50 KB gzipped per sidecar
  //; overflow policy is STOP and re-run 
  // (inherits 15.2 ).
  if (corpus === 'places') {
    // Landing-sidecar facets — mirror buscar-facets.json shape.
    const orderedLugarTally = Object.create(null);
    for (const key of PLACE_SIDEBAR_FACET_KEYS) {
      orderedLugarTally[key] = tally[key] || {};
    }
    const lugarFacetsJsonPath = path.join(OUT_DIR, 'lugares-facets.json');
    const tmpLugarFacetsPath = path.join(OUT_DIR, `.lugares-facets.tmp.${process.pid}.json`);
    fs.writeFileSync(tmpLugarFacetsPath, JSON.stringify(orderedLugarTally));
    fs.renameSync(tmpLugarFacetsPath, lugarFacetsJsonPath);
    console.log(
      `pagefind-index places-facets bundle=${path.relative(PROJECT_ROOT, lugarFacetsJsonPath)} keys=${PLACE_SIDEBAR_FACET_KEYS.join(',')}`
    );
    checkSidecarSize(lugarFacetsJsonPath, 'lugares-facets');

    // Pair-wise pivots — mirror entidades-pivots.json shape.
    const orderedLugarPivots = Object.create(null);
    for (const key of PLACE_PIVOT_FACET_KEYS) {
      orderedLugarPivots[key] = pivots[key] || {};
    }
    const lugarPivotsJsonPath = path.join(OUT_DIR, 'lugares-pivots.json');
    const tmpLugarPivotsPath = path.join(OUT_DIR, `.lugares-pivots.tmp.${process.pid}.json`);
    fs.writeFileSync(tmpLugarPivotsPath, JSON.stringify(orderedLugarPivots));
    fs.renameSync(tmpLugarPivotsPath, lugarPivotsJsonPath);
    const lugarPivotsSize = fs.statSync(lugarPivotsJsonPath).size;
    console.log(
      `pagefind-index places-pivots bundle=${path.relative(PROJECT_ROOT, lugarPivotsJsonPath)} size_bytes=${lugarPivotsSize} keys=${PLACE_PIVOT_FACET_KEYS.join(',')}`
    );
    checkSidecarSize(lugarPivotsJsonPath, 'lugares-pivots');

    // Triple-wise pivots — mirror entidades-triples.json shape.
    const orderedLugarTriples = Object.create(null);
    for (const key of PLACE_PIVOT_FACET_KEYS) {
      orderedLugarTriples[key] = triples[key] || {};
    }
    const lugarTriplesJsonPath = path.join(OUT_DIR, 'lugares-triples.json');
    const tmpLugarTriplesPath = path.join(OUT_DIR, `.lugares-triples.tmp.${process.pid}.json`);
    fs.writeFileSync(tmpLugarTriplesPath, JSON.stringify(orderedLugarTriples));
    fs.renameSync(tmpLugarTriplesPath, lugarTriplesJsonPath);
    const lugarTriplesSize = fs.statSync(lugarTriplesJsonPath).size;
    console.log(
      `pagefind-index places-triples bundle=${path.relative(PROJECT_ROOT, lugarTriplesJsonPath)} size_bytes=${lugarTriplesSize} keys=${PLACE_PIVOT_FACET_KEYS.join(',')}`
    );
    checkSidecarSize(lugarTriplesJsonPath, 'lugares-triples');
  }

  const elapsed = Date.now() - started;
  // structured log line — CI log scraping depends on
  // this exact shape. Do NOT reformat without coordinating with CI.
  console.log(
    `pagefind-index ${corpus} records=${records.length} bundle=${path.relative(PROJECT_ROOT, finalOut)} elapsed_ms=${elapsed}`
  );
}

// ---------------------------------------------------------------------------
// Orchestrator — sequential per. Promote to parallel only if a
// future Stage 7 wall-clock measurement regresses materially.
// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  console.log(
    `[generate-pagefind-indices] DATA_DIR=${path.relative(PROJECT_ROOT, DATA_DIR)}`
  );
  if (DEV_LIMIT) {
    console.log(
      `[generate-pagefind-indices] DEV_LIMIT=${DEV_LIMIT} (propagated via hugo-data JSON; bundles are smoke-test-only)`
    );
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Pagefind v1.5.2 is ESM-only; load via dynamic import from this CJS
  // script so it can stay shaped like generate-content.js.
  const pagefind = await import('pagefind');

  const entities = loadJSON('entities.json');
  // Places filter:
  // Only index a place in the explorer if it has coordinates OR is
  // linked to more than one description. This excludes coord-less
  // "singleton" authority records that leaked into the Hugo-era
  // bundle because the original `$inExplorer:= hasCoords OR linked>1`
  // gate (see layouts/lugar/single.html) was never ported when
  // Pagefind moved to the Node-API generator in.
  // Detail pages for excluded places still render (direct links keep
  // working with a "no coordinates" placeholder); they are just
  // absent from the explorer's search surface.
  const places = loadJSON('places.json').filter((p) => {
    const hasCoords = p.latitude != null && p.longitude != null;
    const hasLinks = (p._linked_count || 0) > 1;
    return hasCoords || hasLinks;
  });
  const descriptions = loadDescriptionShards();

  await buildIndex(pagefind, 'descriptions', descriptions, 'pagefind');
  await buildIndex(pagefind, 'entities', entities, 'pagefind-entities');
  await buildIndex(pagefind, 'places', places, 'pagefind-places');

  // Tear down the persistent Pagefind service so the Node process can
  // exit cleanly. Without this, `pagefind` keeps a child process alive
  // and `node script.js` hangs after the last bundle is written.
  if (typeof pagefind.close === 'function') {
    await pagefind.close();
  }

  console.log(
    `[generate-pagefind-indices] total: ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
}

if (require.main === module) {
  main().catch(err => {
    console.error(
      '[generate-pagefind-indices] Fatal error:',
      (err && err.stack) || err
    );
    process.exit(1);
  });
}

module.exports = {
  FIELD_MAP,
  yearsInRange,
  centuriesInRange,
  decadesInRange,
  romanCentury,
  descriptionYearRange,
};

// Version: v1.0.0
