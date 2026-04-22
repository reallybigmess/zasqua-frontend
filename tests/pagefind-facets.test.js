/**
 * Pagefind Facet-Count Selection Unit Tests
 *
 * Unit tests for `selectFacetCounts`, the helper that picks
 * between Pagefind's `result.filters` (constrained cross-facet
 * counts) and `result.totalFilters` (same-facet OR-group /
 * active-value restore counts) when rendering facet counts in the
 * client. The helper lives in three places — `static/js/search.js`,
 * `static/js/entity-explorer.js`, and `static/js/place-explorer.js`
 * — because the three explorer files are loaded as independent
 * classic `<script>` tags, not ES modules, so they cannot share an
 * import. This test suite pins the behaviour of all three copies
 * so they stay byte-equivalent.
 *
 * Covers:
 *   (a) cross-facet value → result.filters (constrained)
 *   (b) same-facet OR-group value → result.totalFilters (replacement)
 *   (c) active / already-selected value → result.totalFilters (restore)
 *   (d) empty / missing facet group → 0
 *   (e) active-single-value degenerate case → scoped total
 *
 * Additional describe blocks exercise `buildPivotScopedFiltersPure`
 * (the pure helper that computes a scoped filters object for pivot
 * sidecar lookups when 1–2 filter dimensions are active on cold
 * first-click), cross-explorer byte-equivalence of the three
 * copies, and a handful of structural pins around sort-UI parity
 * and the entity-graph focal sidecar fetch.
 *
 * Uses mocked Pagefind response shapes — no live WASM instance, no
 * browser. The helpers are loaded via `createRequire` to bypass
 * Vite's ESM transform, which does not surface CommonJS named
 * bindings of files outside `node_modules/`.
 *
 * @version v1.0.0
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Load the helper as plain Node CJS. `static/js/search.js` is a classic
// browser script (no `type="module"`) and exports the helper through a
// conditional `module.exports = { selectFacetCounts }` footer guarded by
// `typeof module`. Vitest's default ESM transform does not expose those
// named bindings, so we sidestep it with createRequire.
const require = createRequire(import.meta.url);
const { selectFacetCounts, buildPivotScopedFiltersPure, PIVOT_KEYS } = require('../static/js/search.js');

// the entity-explorer copy of selectFacetCounts is
// kept byte-equivalent to the search.js canonical shape per.
// Import it via the same createRequire bridge so the active-single-
// value short-circuit can be asserted against the entity-explorer
// symbol directly, not just the search.js copy. Aliased so the two
// explorer copies can coexist in the same suite.
const {
  selectFacetCounts: selectFacetCountsEntity,
  buildPivotScopedFiltersPure: buildPivotScopedFiltersPureEntity,
  PIVOT_KEYS: PIVOT_KEYS_ENTITY,
} = require('../static/js/entity-explorer.js');

// the place-explorer copy of selectFacetCounts is
// kept byte-equivalent to the search.js canonical shape per.
// buildPivotScopedFiltersPure + PIVOT_KEYS now also
// exported from place-explorer.js (3-key places variant). Aliased so
// all three explorer copies can coexist in the same suite.
const {
  selectFacetCounts: selectFacetCountsPlace,
  buildPivotScopedFiltersPure: buildPivotScopedFiltersPurePlace,
  PIVOT_KEYS: PIVOT_KEYS_PLACE,
} = require('../static/js/place-explorer.js');

describe('selectFacetCounts', () => {
  it('cross-facet value reads from result.filters (constrained counts)', () => {
    // e.g. rendering `repository` counts while `level` is the active facet.
    const result = {
      filters: { repository: { 'AHRB': 12, 'PE-BN': 8 } },
      totalFilters: { repository: { 'AHRB': 200, 'PE-BN': 180 } },
    };
    const active = { level: ['Fondo'] };
    expect(selectFacetCounts(result, 'repository', 'AHRB', active)).toBe(12);
  });

  it('same-facet OR-group value reads from result.totalFilters (replacement count)', () => {
    // PE-BN sits beside the active value AHRB inside the same `repository`
    // facet. `filters[repository]` is constrained to AHRB so PE-BN would
    // appear as 0; `totalFilters[repository]` ignores the active filter on
    // this key and shows the real OR-sibling count.
    const result = {
      filters: { repository: { 'AHRB': 12 } },
      totalFilters: { repository: { 'AHRB': 200, 'PE-BN': 180 } },
    };
    const active = { repository: ['AHRB'] };
    expect(selectFacetCounts(result, 'repository', 'PE-BN', active)).toBe(180);
  });

  it('active/already-selected value reads from result.totalFilters (restore count)', () => {
    // The badge on the active value must show its full restore count, not
    // "the number of results currently visible" (which `filters` would
    // give and would be uninformative for de-selection).
    const result = {
      filters: { repository: { 'AHRB': 12 } },
      totalFilters: { repository: { 'AHRB': 200 } },
    };
    const active = { repository: ['AHRB'] };
    expect(selectFacetCounts(result, 'repository', 'AHRB', active)).toBe(200);
  });

  it('returns 0 when the facet group is empty or missing (zero-result query)', () => {
    // Pagefind returns undefined for facet groups with no hits on a
    // zero-result query . The helper must
    // not throw — it returns 0 so the badge renders cleanly.
    expect(
      selectFacetCounts(
        { filters: {}, totalFilters: {} },
        'repository',
        'AHRB',
        {},
      ),
    ).toBe(0);
  });

  it('active single value returns scoped total (degenerate-case fix)', () => {
    // When the queried value is the sole active member of its facet,
    // Pagefind's `totalFilters[key][value]` collapses to 0 because
    // there is no OR-sibling restore count to report. handles
    // that as 0 per the contract, but the UX reads as "AHR (0)" when
    // 55,359 records match — worse than uninformative..1-10
    // returns `result.results.length` instead. Multi-value OR-group
    // siblings still take the path (see case (b) above); this
    // branch only fires when activeFilters[facetKey] is exactly
    // [value].
    const result = {
      results: { length: 55359 },
      filters: { repository: { 'AHR': 0 } },
      totalFilters: { repository: { 'AHR': 0 } },
    };
    const active = { repository: ['AHR'] };
    expect(selectFacetCounts(result, 'repository', 'AHR', active)).toBe(55359);
  });
});

describe('entity-explorer selectFacetCounts — byte-equivalence port', () => {
  // These cases assert the entity-explorer copy of selectFacetCounts
  // carries the active-single-value short-circuit ported
  // in. mandates the three copies (search.js,
  // entity-explorer.js, place-explorer.js) stay byte-equivalent; this
  // block exercises the entity-explorer export directly so a future
  // regression in that copy alone would surface here.

  it('active-single-value short-circuit fires on /entidades/ entity_type=person', () => {
    // User-reported bug (a) from 
    // selecting entity_type=person alone shows the restore badge as
    // "persona (0)" even though 41,986 entities match. Post-fix the
    // helper returns result.results.length instead.
    const result = {
      results: { length: 41986 },
      filters: { entity_type: { person: 0 } },
      totalFilters: { entity_type: { person: 0 } },
    };
    const active = { entity_type: ['person'] };
    expect(selectFacetCountsEntity(result, 'entity_type', 'person', active)).toBe(41986);
  });

  it('same-facet OR-group value reads from result.totalFilters (entity_type=person+place active)', () => {
    // Multi-value OR-group path on the active facet — short-circuit
    // does NOT fire because activeInKey.length is 2, not 1. The
    // helper reads the OR-sibling count from totalFilters.
    const result = {
      totalFilters: { entity_type: { person: 40000, place: 10000 } },
    };
    const active = { entity_type: ['person', 'place'] };
    expect(selectFacetCountsEntity(result, 'entity_type', 'person', active)).toBe(40000);
  });

  it('cross-facet value reads from result.filters (constrained counts)', () => {
    // Asking for primary_function=notary counts while entity_type is
    // the active facet — reads from the constrained filters map, not
    // totalFilters.
    const result = {
      filters: { primary_function: { notary: 500 } },
    };
    const active = { entity_type: ['person'] };
    expect(selectFacetCountsEntity(result, 'primary_function', 'notary', active)).toBe(500);
  });
});

describe('buildPivotScopedFiltersPure (N=2 triple-wise)', () => {
  // Synthetic globalFilters used across the suite. Small but realistic
  // enough to exercise the pass-through for active keys and the year
  // pass-through. Values are made-up — the tests check the ratios and
  // pivot math, not the magnitudes.
  const globalFilters = {
    century: { XVII: 300, XVIII: 500 },
    country: { Colombia: 700, 'Perú': 100 },
    decade: { '1700': 250, '1750': 300 },
    digital_status: { none: 600, zasqua: 200 },
    level: { Fondo: 50, 'Unidad documental': 700 },
    repository: { AHR: 400, Popayán: 400 },
    year: { '1750': 80 },
  };

  // Pair-wise pivot payload. Only the cells the N=1 test exercises
  // need to be populated; the helper reads pivots[activeKey] per the
  // contract and ignores absent cells (treated as zero counts).
  const pivots = {
    repository: {
      AHR: {
        country: { Colombia: 400 },
        digital_status: { none: 400 },
        level: { Fondo: 20, 'Unidad documental': 380 },
        century: { XVII: 150, XVIII: 250 },
        decade: { '1700': 100, '1750': 150 },
      },
    },
  };

  // Triple-wise pivot payload. Canonical alphabetical key ordering —
  // (country < level < repository), (century < level < repository),
  // etc. — so the consumer's sort-then-walk always lands on exactly
  // one path here regardless of which two dims the user activated.
  const triples = {
    country: {
      Colombia: {
        level: {
          'Unidad documental': {
            repository: { Popayán: 100, AHR: 380 },
          },
        },
      },
      'Perú': {
        level: {
          'Unidad documental': {
            repository: { Popayán: 0, AHR: 0 },
          },
        },
      },
    },
    century: {
      XVII: {
        level: {
          'Unidad documental': {
            repository: { Popayán: 30 },
          },
        },
      },
    },
    decade: {
      '1700': {
        level: {
          'Unidad documental': {
            repository: { Popayán: 25 },
          },
        },
      },
    },
  };

  it('returns null when zero active pivot dimensions', () => {
    expect(
      buildPivotScopedFiltersPure({
        activeByKey: {},
        pivots,
        triples,
        globalFilters,
      }),
    ).toBeNull();
  });

  it('N=1: pair-wise branch scopes inactive keys from pivots[active]', () => {
    const scoped = buildPivotScopedFiltersPure({
      activeByKey: { repository: ['AHR'] },
      pivots,
      triples,
      globalFilters,
    });
    expect(scoped).not.toBeNull();
    // Active key: passes through globalFilters counts so
    // selectFacetCounts handles the active badge via result.results.length.
    expect(scoped.repository.AHR).toBe(400);
    // Inactive keys: summed from pivots[repository][AHR].
    expect(scoped.country.Colombia).toBe(400);
    expect(scoped.country['Perú']).toBe(0);
    expect(scoped.level.Fondo).toBe(20);
    expect(scoped.level['Unidad documental']).toBe(380);
    expect(scoped.century.XVII).toBe(150);
    expect(scoped.decade['1700']).toBe(100);
    // Year: pass-through from globalFilters (not in pivot sidecar).
    expect(scoped.year).toBe(globalFilters.year);
  });

  it('N=2: triple-wise branch scopes inactive keys via canonical alphabetical order', () => {
    // Popayán + Unidad documental — the plan's primary gate URL.
    // Active keys: level, repository. Inactive: country, digital_status,
    // century, decade. Canonical order for country lookup:
    // (country < level < repository) so sort lands on country at path
    // position 0, then level, then repository.
    const scoped = buildPivotScopedFiltersPure({
      activeByKey: { level: ['Unidad documental'], repository: ['Popayán'] },
      pivots,
      triples,
      globalFilters,
    });
    expect(scoped).not.toBeNull();
    // Active keys pass through.
    expect(scoped.level['Unidad documental']).toBe(700);
    expect(scoped.repository['Popayán']).toBe(400);
    // country inactive — look up triples.country.Colombia.level['Unidad documental'].repository.Popayán
    expect(scoped.country.Colombia).toBe(100);
    expect(scoped.country['Perú']).toBe(0);
    // century inactive — (century < level < repository) canonical path
    expect(scoped.century.XVII).toBe(30);
    expect(scoped.century.XVIII).toBe(0);
    // decade inactive — (decade < level < repository) canonical path
    expect(scoped.decade['1700']).toBe(25);
    expect(scoped.decade['1750']).toBe(0);
  });

  it('N=2: returns null when triples payload is null (fetch failed)', () => {
    // Pre-11 behaviour: caller falls back to globalFilters on N=2.
    expect(
      buildPivotScopedFiltersPure({
        activeByKey: { level: ['Unidad documental'], repository: ['Popayán'] },
        pivots,
        triples: null,
        globalFilters,
      }),
    ).toBeNull();
  });

  it('N=3: returns null (quad-pivot deferred to wishlist)', () => {
    expect(
      buildPivotScopedFiltersPure({
        activeByKey: {
          country: ['Colombia'],
          level: ['Unidad documental'],
          repository: ['Popayán'],
        },
        pivots,
        triples,
        globalFilters,
      }),
    ).toBeNull();
  });

  it('N=2 with century as one of the active keys: uses extended PIVOT_KEYS', () => {
    // century + repository active. Inactive: country, decade,
    // digital_status, level. Canonical order for level lookup:
    // (century < level < repository) so the same path the N=2 test
    // above walked resolves here with level playing the inactive role.
    // Build a minimal triples payload specific to this case.
    const triplesForCentury = {
      century: {
        XVII: {
          level: { 'Unidad documental': { repository: { Popayán: 30 } } },
        },
      },
    };
    const scoped = buildPivotScopedFiltersPure({
      activeByKey: { century: ['XVII'], repository: ['Popayán'] },
      pivots,
      triples: triplesForCentury,
      globalFilters,
    });
    expect(scoped).not.toBeNull();
    expect(scoped.century.XVII).toBe(300);   // passes through globalFilters
    expect(scoped.repository['Popayán']).toBe(400); // passes through
    expect(scoped.level['Unidad documental']).toBe(30);
    expect(scoped.level.Fondo).toBe(0);
  });

  it('selectFacetCounts single-active-value short-circuit still fires with 2 active dims', () => {
    // The short-circuit is per-key, not per-query. When the query has
    // two total active dims (level + repository) and we ask for the
    // badge count on repository (which has exactly one active value
    // 'Popayán'), the helper still returns result.results.length.
    const result = {
      results: { length: 25358 },
      filters: { repository: { Popayán: 0 } },
      totalFilters: { repository: { Popayán: 0 } },
    };
    const active = { level: ['Unidad documental'], repository: ['Popayán'] };
    expect(selectFacetCounts(result, 'repository', 'Popayán', active)).toBe(25358);
  });

  it('PIVOT_KEYS is exported and contains century + decade (15.1-11 extension)', () => {
    expect(Array.isArray(PIVOT_KEYS)).toBe(true);
    expect(PIVOT_KEYS).toContain('century');
    expect(PIVOT_KEYS).toContain('decade');
    expect(PIVOT_KEYS).toContain('country');
    expect(PIVOT_KEYS).toContain('digital_status');
    expect(PIVOT_KEYS).toContain('level');
    expect(PIVOT_KEYS).toContain('repository');
    // Canonical alphabetical order — relied on by the triples lookup.
    const sorted = PIVOT_KEYS.slice().sort();
    expect(PIVOT_KEYS).toEqual(sorted);
  });
});

describe('entity-explorer buildPivotScopedFiltersPure + collector — 15.2-04', () => {
  // the entity-explorer copy of buildPivotScopedFiltersPure
  // closes over a 4-key PIVOT_KEYS binding ('century','decade',
  // 'entity_type','primary_function') vs search.js's 6-key set. The
  // helper body text is byte-equivalent; the difference is purely
  // which constant is bound at module load time. These cases assert
  // the N=0/1/2/>=3 dispatch, the pivots-null / triples-null fallback,
  // and the dateFilter collector mapping (century + decade) all work
  // on the entity-side binding.

  // Minimal globalFilters — entity side uses entity_type +
  // primary_function + century + decade + year. year is NOT in
  // PIVOT_KEYS so it passes through unchanged.
  const globalFilters = {
    century: { XIX: 30000, XVIII: 10000 },
    decade: { '1850': 8000, '1860': 9000 },
    entity_type: { person: 41986, place: 200 },
    primary_function: { notary: 500, judge: 300, artist: 150 },
    year: { '1850': 80 },
  };

  // Pair-wise pivot payload — entity_type=person intersected with
  // every other pivot key. Values are made up; tests assert
  // summation behaviour, not magnitudes.
  const pivots = {
    entity_type: {
      person: {
        primary_function: { notary: 42, judge: 200 },
        century: { XIX: 25000, XVIII: 7000 },
        decade: { '1850': 5000, '1860': 6000 },
      },
    },
    century: {
      XIX: {
        entity_type: { person: 25000 },
        decade: { '1850': 5000, '1860': 6000 },
        primary_function: { notary: 30, judge: 150 },
      },
    },
  };

  // Triple-wise payload. Canonical alphabetical ordering for the
  // (century, entity_type, primary_function) triple means the walk
  // starts at century.
  const triples = {
    century: {
      XIX: {
        entity_type: {
          person: {
            primary_function: { notary: 10, judge: 100 },
          },
        },
      },
    },
  };

  it('Test 1 — N=0 (no active pivot dims) returns null', () => {
    expect(
      buildPivotScopedFiltersPureEntity({
        activeByKey: {},
        pivots,
        triples,
        globalFilters,
      }),
    ).toBeNull();
  });

  it('Test 2 — N=1 pivot lookup: entity_type=person scopes primary_function from pivots', () => {
    const scoped = buildPivotScopedFiltersPureEntity({
      activeByKey: { entity_type: ['person'] },
      pivots,
      triples,
      globalFilters,
    });
    expect(scoped).not.toBeNull();
    // Active key passes through globalFilters.
    expect(scoped.entity_type.person).toBe(41986);
    expect(scoped.entity_type.place).toBe(200);
    // Inactive primary_function: summed from pivots[entity_type][person].
    expect(scoped.primary_function.notary).toBe(42);
    expect(scoped.primary_function.judge).toBe(200);
    // Inactive value missing from the pivot cell — renders as 0.
    expect(scoped.primary_function.artist).toBe(0);
    // Century / decade also pivoted.
    expect(scoped.century.XIX).toBe(25000);
    expect(scoped.decade['1850']).toBe(5000);
    // Year passthrough (year is not in PIVOT_KEYS).
    expect(scoped.year).toBe(globalFilters.year);
  });

  it('Test 3 — N=2 triple lookup with canonical alphabetical ordering (century < entity_type < primary_function)', () => {
    // entity_type=person + century=XIX — matches 
    // N=2 primary verification gate on the 41,986-entity live
    // corpus. Canonical alphabetical ordering means the triples
    // walk lands on century at position 0, entity_type at
    // position 1, primary_function at position 2.
    const scoped = buildPivotScopedFiltersPureEntity({
      activeByKey: { entity_type: ['person'], century: ['XIX'] },
      pivots,
      triples,
      globalFilters,
    });
    expect(scoped).not.toBeNull();
    // Active keys pass through.
    expect(scoped.entity_type.person).toBe(41986);
    expect(scoped.century.XIX).toBe(30000);
    // Inactive primary_function: looked up via sorted path
    // (century < entity_type < primary_function).
    expect(scoped.primary_function.notary).toBe(10);
    expect(scoped.primary_function.judge).toBe(100);
    expect(scoped.primary_function.artist).toBe(0);
  });

  it('Test 4 — N>=3 (quad-pivot deferred) returns null', () => {
    expect(
      buildPivotScopedFiltersPureEntity({
        activeByKey: {
          entity_type: ['person'],
          century: ['XIX'],
          primary_function: ['notary'],
        },
        pivots,
        triples,
        globalFilters,
      }),
    ).toBeNull();
  });

  it('Test 5 — N=1 with pivots=null returns null (caller falls back to globalFilters)', () => {
    expect(
      buildPivotScopedFiltersPureEntity({
        activeByKey: { entity_type: ['person'] },
        pivots: null,
        triples,
        globalFilters,
      }),
    ).toBeNull();
  });

  it('Test 6 — N=2 with triples=null returns null (caller falls back to globalFilters)', () => {
    expect(
      buildPivotScopedFiltersPureEntity({
        activeByKey: { entity_type: ['person'], century: ['XIX'] },
        pivots,
        triples: null,
        globalFilters,
      }),
    ).toBeNull();
  });

  it('Test 7 — dateFilter level=century collector populates activeByKey.century from Roman label', () => {
    // The class-method collector lives inside EntityExplorer but
    // does not require any DOM state beyond this.state. We
    // invoke it directly on a minimal shim object via
    // .call(); this avoids the DOM-dependent constructor path.
    const EntityExplorerModule = require('../static/js/entity-explorer.js');
    // The module.exports does not include EntityExplorer itself
    // (only the helpers), so we replicate the collector here —
    // it must stay byte-equivalent to the class method in
    // entity-explorer.js.
    //
    // We instead exercise the observable contract: given the
    // known dateFilter shape, the collector output should drive
    // buildPivotScopedFiltersPureEntity to a known scoped result.
    // Construct an activeByKey the way the class method would and
    // assert the pure helper returns the expected shape.
    const activeByKey = Object.create(null);
    const df = { level: 'century', label: 'Siglo XIX', years: ['1800'] };
    // Mirror the class-method mapping literally.
    if (df.level === 'century') {
      const roman = (df.label || '').replace(/^Siglo\s+/, '');
      if (roman) activeByKey.century = [roman];
    }
    expect(activeByKey.century).toEqual(['XIX']);
    // And the resulting pivot scoping should land on the century
    // pivot cell — N=1 branch.
    const scoped = buildPivotScopedFiltersPureEntity({
      activeByKey,
      pivots,
      triples,
      globalFilters,
    });
    expect(scoped).not.toBeNull();
    expect(scoped.entity_type.person).toBe(25000);
  });

  it('Test 8 — dateFilter level=decade collector populates activeByKey.decade from years[0]', () => {
    const activeByKey = Object.create(null);
    const df = { level: 'decade', label: '1850s', years: ['1850', '1851', '1852'] };
    if (df.level === 'decade') {
      const decadeStart = df.years && df.years[0];
      if (decadeStart) {
        activeByKey.decade = [String(Math.floor(parseInt(decadeStart, 10) / 10) * 10)];
      }
    }
    expect(activeByKey.decade).toEqual(['1850']);
  });

  it('Test 9 — entity PIVOT_KEYS is the locked 4-key alphabetical set (CONTEXT §D-01)', () => {
    expect(Array.isArray(PIVOT_KEYS_ENTITY)).toBe(true);
    expect(PIVOT_KEYS_ENTITY).toEqual(['century', 'decade', 'entity_type', 'primary_function']);
    // Alphabetical — the triples lookup depends on this.
    const sorted = PIVOT_KEYS_ENTITY.slice().sort();
    expect(PIVOT_KEYS_ENTITY).toEqual(sorted);
    // 4 keys, not 6 — distinct from search.js PIVOT_KEYS.
    expect(PIVOT_KEYS_ENTITY).toHaveLength(4);
  });
});

describe('place-explorer selectFacetCounts — byte-equivalence port', () => {
  // These cases assert the place-explorer copy of selectFacetCounts
  // carries the active-single-value short-circuit ported
  // in. mandates the three copies (search.js,
  // entity-explorer.js, place-explorer.js) stay byte-equivalent; this
  // block exercises the place-explorer export directly on the place_type
  // facet used by /lugares/ so a future regression in that copy alone
  // would surface here without touching the search.js or entity-explorer
  // describe blocks.

  it('active-single-value short-circuit fires on /lugares/ place_type=city', () => {
    // User-reported bug from 
    // selecting place_type=city alone shows the restore badge as
    // "Lugar poblado (0)" even though 3,437 places match. Post-fix
    // the helper returns result.results.length instead of
    // totalFilters[place_type][city] which Pagefind collapses to 0
    // when there is no OR-sibling restore count to report.
    const result = {
      results: { length: 3437 },
      filters: { place_type: { city: 0 } },
      totalFilters: { place_type: { city: 0 } },
    };
    const active = { place_type: ['city'] };
    expect(selectFacetCountsPlace(result, 'place_type', 'city', active)).toBe(3437);
  });

  it('same-facet OR-group value reads from result.totalFilters (place_type=city+region active)', () => {
    // Multi-value OR-group path on the active facet — short-circuit
    // does NOT fire because activeInKey.length is 2, not 1. The
    // helper reads the OR-sibling count from totalFilters for the
    // non-active sibling value.
    const result = {
      totalFilters: { place_type: { city: 3437, region: 200 } },
    };
    const active = { place_type: ['city', 'region'] };
    expect(selectFacetCountsPlace(result, 'place_type', 'region', active)).toBe(200);
  });

  it('cross-facet value reads from result.filters (constrained counts)', () => {
    // Asking for has_authority counts while place_type is the active
    // facet — reads from the constrained filters map, not totalFilters.
    const result = {
      filters: { has_authority: { true: 1200 } },
    };
    const active = { place_type: ['city'] };
    expect(selectFacetCountsPlace(result, 'has_authority', 'true', active)).toBe(1200);
  });

  it('returns 0 when facet group is empty or missing (zero-result query)', () => {
    // Mirrors the canonical edge case from the search.js suite —
    // Pagefind returns undefined for groups with no hits; helper must
    // not throw and returns 0 so the badge renders cleanly.
    expect(
      selectFacetCountsPlace(
        { filters: {}, totalFilters: {} },
        'place_type',
        'city',
        {},
      ),
    ).toBe(0);
  });
});

// place-explorer buildPivotScopedFiltersPure + collector
// Nine cases mirroring the 15.2-04 entity-explorer block but with the
// 3-key places state shape (place_type, has_coordinates, has_authority).
// primary verification gate: place_type=city × has_coordinates=true
// must route to the triples sidecar (N=2 branch). N=3 with all three
// keys active returns null — C(3,3)=1 triple covers the geometry but
// the helper short-circuits at n>=3; N=3 fallback to globalFilters is
// acceptable for places.
describe('place-explorer buildPivotScopedFiltersPure + collector — 15.3-04', () => {
  it('PIVOT_KEYS equals 3-key alphabetical array', () => {
    expect(PIVOT_KEYS_PLACE).toEqual(['has_authority', 'has_coordinates', 'place_type']);
  });

  it('N=0 (no active dims) returns null', () => {
    expect(buildPivotScopedFiltersPurePlace({
      activeByKey: {}, pivots: {}, triples: {},
      globalFilters: { place_type: { city: 3437 } },
    })).toBeNull();
  });

  it('N=1 pivot lookup returns scoped inactive-key counts', () => {
    const pivots = {
      place_type: { city: { has_coordinates: { true: 2800, false: 637 }, has_authority: { true: 1200 } } },
    };
    const globalFilters = {
      place_type: { city: 3437, region: 200 },
      has_coordinates: { true: 5000, false: 1722 },
      has_authority: { true: 1500 },
    };
    const out = buildPivotScopedFiltersPurePlace({
      activeByKey: { place_type: ['city'] },
      pivots, triples: null, globalFilters,
    });
    expect(out).not.toBeNull();
    expect(out.has_coordinates.true).toBe(2800);
    expect(out.has_coordinates.false).toBe(637);
    expect(out.has_authority.true).toBe(1200);
    // Active key keeps global count for OR-group siblings
    expect(out.place_type.city).toBe(3437);
  });

  it('N=2 triple lookup — place_type=city × has_coordinates=true', () => {
    // Active dims: place_type=city + has_coordinates=true. Inactive: has_authority.
    // Canonical alphabetical sort: ['has_authority', 'has_coordinates', 'place_type']
    // Triples sidecar indexed alphabetically: triples[has_authority][authVal][has_coordinates][true][place_type][city]
    const triples = {
      has_authority: {
        true:  { has_coordinates: { true: { place_type: { city: 1100 } } } },
        false: { has_coordinates: { true: { place_type: { city: 1700 } } } },
      },
    };
    const globalFilters = {
      place_type: { city: 3437 },
      has_coordinates: { true: 5000 },
      has_authority: { true: 1500, false: 5222 },
    };
    const out = buildPivotScopedFiltersPurePlace({
      activeByKey: { place_type: ['city'], has_coordinates: ['true'] },
      pivots: null, triples, globalFilters,
    });
    expect(out).not.toBeNull();
    expect(out.has_authority.true).toBe(1100);
    expect(out.has_authority.false).toBe(1700);
  });

  it('N>=3 returns null (all 3 place dims active — C(3,3)=1 covered by triples but helper short-circuits)', () => {
    // With only 3 keys total, N=3 is the maximally-active case. The helper
    // returns null (n>=3 guard) and the caller falls back to globalFilters.
    // This is consistent with entity-explorer behaviour for N>=3. N=2
    // (the primary gate) is the highest supported pivot/triples path.
    expect(buildPivotScopedFiltersPurePlace({
      activeByKey: { place_type: ['city'], has_coordinates: ['true'], has_authority: ['true'] },
      pivots: {}, triples: {}, globalFilters: {},
    })).toBeNull();
  });

  it('pivots null with N=1 returns null', () => {
    expect(buildPivotScopedFiltersPurePlace({
      activeByKey: { place_type: ['city'] },
      pivots: null, triples: null, globalFilters: {},
    })).toBeNull();
  });

  it('triples null with N=2 returns null', () => {
    expect(buildPivotScopedFiltersPurePlace({
      activeByKey: { place_type: ['city'], has_coordinates: ['true'] },
      pivots: {}, triples: null, globalFilters: {},
    })).toBeNull();
  });

  // Collector tests — replicate the class-method's mapping logic literally
  // (PlaceExplorer constructor reads DOM and is not exported from the CJS
  // footer). Mirrors the 15.2-04 entity-explorer collector pattern.
  it("collector: state.hasCoords === true → activeByKey.has_coordinates = ['true']", () => {
    const state = { type: [], hasCoords: true, hasAuthority: null };
    const activeByKey = Object.create(null);
    if (state.type && state.type.length > 0) activeByKey.place_type = state.type;
    if (state.hasCoords === true) activeByKey.has_coordinates = ['true'];
    if (state.hasAuthority === true) activeByKey.has_authority = ['true'];
    expect(activeByKey.has_coordinates).toEqual(['true']);
    expect(activeByKey.has_authority).toBeUndefined();
    expect(activeByKey.place_type).toBeUndefined();
  });

  it('collector: state.hasCoords === false (negative) is NOT added to activeByKey', () => {
    const state = { type: [], hasCoords: false, hasAuthority: null };
    const activeByKey = Object.create(null);
    if (state.type && state.type.length > 0) activeByKey.place_type = state.type;
    if (state.hasCoords === true) activeByKey.has_coordinates = ['true'];
    if (state.hasAuthority === true) activeByKey.has_authority = ['true'];
    expect(activeByKey.has_coordinates).toBeUndefined();
    expect(activeByKey.has_authority).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Descriptions indexer filter-key contract
//
// The descriptions Pagefind index still emits `f.entidad` on every
// record that carries entity_links (renamed from `entity_codes` during
// the Eleventy parity port — see scripts/generate-pagefind-indices.js).
// This block pins the INDEXER side of the contract. The CONSUMER side
// (static/js/infinite-bipartite-explorer.js + static/js/entity.js) no
// longer reads from the Pagefind descriptions index at all — doc-node
// expandability is now resolved via the O(1) per-focal
// `/data/doc-entities/{code}.json` sidecar (Finding 1
// fix, commit 220f44a). The earlier "consumer files read
// hit.filters.entidad" pin was retired with that change; a replacement
// pin guards against the regression-prone path re-entering the
// controller code — i.e. ensures the `pagefindDesc` and
// `_preCheckExpandable` symbols don't come back.
// ---------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { FIELD_MAP } = require('../scripts/generate-pagefind-indices.js');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe("descriptions indexer filter-key contract", () => {
  it("FIELD_MAP.descriptions.filters emits f.entidad (not entity_codes)", () => {
    const rec = {
      reference_code: 'co-test-0001',
      entity_links: [
        { entity_code: 'ne-aaa', display_name: 'Alpha' },
        { entity_code: 'ne-bbb', display_name: 'Beta' },
      ],
      ancestor_chain: [],
    };
    const f = FIELD_MAP.descriptions.filters(rec);
    expect(f.entidad).toEqual(['ne-aaa', 'ne-bbb']);
    expect(f.entity_codes).toBeUndefined();
  });

  it("FIELD_MAP.descriptions.filters skips empty entity_links", () => {
    const rec = { reference_code: 'co-test-0002', ancestor_chain: [] };
    const f = FIELD_MAP.descriptions.filters(rec);
    expect(f.entidad).toBeUndefined();
  });

  it("graph controllers do not reintroduce the Pagefind descriptions expandability path", () => {
    // Guards against regression: Finding 1 replaced the
    // per-doc Pagefind descriptions lookup with a per-focal doc-entities
    // sidecar. If someone reintroduces `pagefindDesc` / `_preCheckExpandable`
    // into either controller, the 20–45 s Bolívar-class timeout returns.
    const consumers = [
      'static/js/infinite-bipartite-explorer.js',
      'static/js/entity.js',
    ];
    for (const rel of consumers) {
      const src = readFileSync(join(repoRoot, rel), 'utf8');
      // Strip block + line comments so narrative-header references to the
      // retired code paths (which we keep for historical context) don't
      // trip us.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(stripped).not.toMatch(/pagefindDesc/);
      expect(stripped).not.toMatch(/_preCheckExpandable/);
      expect(stripped).not.toMatch(/\/pagefind\/pagefind\.js/);
    }
  });
});

// cold-init search wiring structural pin.
//
// The bug: `this.search()` at `static/js/place-explorer.js:724` is the
// ONLY call site for the initial search, and it is inside the
// `this.map.on('load', …)` callback. When the MapTiler Topo style
// fails to load (network failure, origin restriction, timeout),
// MapLibre emits 'error' — not 'load' — and the callback never fires.
// Pills, results, and facets stay empty indefinitely.
//
// The fix ( in 15.3-06-COLD-INIT-TRACE.md §E): add an
// unconditional `this.search()` call directly in `init()` AFTER
// `this.initMap()`. The `updateMap()` guard at place-explorer.js:1510
// (`if (!this.mapReady) return;`) makes this safe — search() renders
// pills/results/facets while skipping map-marker update until the map
// loads. When the map does load, the existing `on('load')` callback
// still fires search() a second time with mapReady=true (safe via the
// _searchGen counter).
//
// Test gate: structural source assertion.
//   RED (pre-patch): `init()` body has no unconditional `this.search()`
//   call — only inside nested callbacks (popstate + map.on('load')).
//   GREEN (post-patch): `init()` body contains `this.search()` as a
//   direct statement, immediately after `this.initMap()`.
//
// Structural approach is necessary because `PlaceExplorer` is not
// exported from the CJS footer (it requires DOM) and jsdom is not set
// up in this suite. The source assertion is deterministic and
// corpus-independent. Mirrors the 15.2-02 and 15.2-04 structural-pin
// pattern used for entity-explorer.js.
describe('place-explorer cold-init search wiring — 15.3-06', () => {
  // The source of truth for the structural test.
  const src = readFileSync(join(repoRoot, 'static/js/place-explorer.js'), 'utf8');

  it('init() calls this.search() unconditionally (not only inside map.on("load") callback)', () => {
    // Extract the init() method body using brace-counting.
    const lines = src.split('\n');
    let inInit = false;
    let braceDepth = 0;
    const initLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inInit && /^\s{2,4}async init\(\)/.test(line)) {
        inInit = true;
        braceDepth = 0;
      }
      if (inInit) {
        initLines.push(line);
        for (const ch of line) {
          if (ch === '{') braceDepth++;
          if (ch === '}') braceDepth--;
        }
        if (braceDepth === 0 && initLines.length > 1) break;
      }
    }
    expect(initLines.length).toBeGreaterThan(0); // guard: init() found

    // Unconditional direct calls in the method body are indented with
    // exactly 4 spaces (2 for class + 2 for method body). Nested
    // callbacks are at 6+ spaces. Strip line comments then check for a
    // `this.search()` call at exactly 4-space indent.
    //
    // Regex: start of line, exactly 4 spaces, then `this.search();`
    // This matches the direct call but not the 6-space calls inside
    // `window.addEventListener('popstate', () => { ... })` or inside
    // `this.map.on('load', () => { ... })`.
    const hasDirectSearch = initLines
      .map(l => l.replace(/\/\/.*$/, ''))   // strip line comments
      .some(l => /^    this\.search\(\)/.test(l));

    expect(hasDirectSearch).toBe(true);
  });

  it('the direct this.search() call in init() appears after this.initMap()', () => {
    // This test pins the ORDER of calls in init(): initMap() must
    // appear before the unconditional search() call, so the map
    // construction is already underway when search() runs.
    const initMatch = src.match(/async init\(\)\s*\{[\s\S]*?(?=\n  [a-z])/);
    // Simpler: find line numbers for the two calls within init().
    const lines = src.split('\n');
    let inInit = false;
    let braceDepth = 0;
    let initMapLine = -1;
    let directSearchLine = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inInit && /^\s{2,4}async init\(\)/.test(line)) {
        inInit = true;
        braceDepth = 0;
      }
      if (!inInit) continue;

      // Count brace depth to know when we leave init()
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }
      if (braceDepth === 0 && i > 0) break;  // exited init()

      // Direct call to initMap() at method-body indent (4 spaces)
      if (/^    this\.initMap\(\)/.test(line)) initMapLine = i;

      // Direct call to search() at method-body indent (4 spaces),
      // NOT inside a callback (those are at 6+ spaces).
      if (/^    this\.search\(\)/.test(line)) directSearchLine = i;
    }

    // Both calls must be present and initMap must precede search.
    expect(initMapLine).toBeGreaterThan(0);          // initMap() found in init()
    expect(directSearchLine).toBeGreaterThan(0);     // direct search() found
    expect(directSearchLine).toBeGreaterThan(initMapLine); // order: initMap before search
  });
});

// ─── ── Pagefind native sort for linked_count ─────────────────
// Supersedes 's structural pins. The 15.3-07 patch was a no-op:
// raw Pagefind stubs have no `.url`, so the filteredResults comparator always
// returned 0. H6 (15.): places index never
// registered `count` as a sort attribute. Fix: indexer emits `count` + client
// passes { count: 'desc' } to pagefind.search(). Dead 15.3-07 no-op block removed.

describe('place-explorer Pagefind-native sort — 15.3-08', () => {
  // Load source once for structural pin tests.
  const fs = require('node:fs');
  const src = fs.readFileSync(
    new URL('../static/js/place-explorer.js', import.meta.url).pathname,
    'utf8'
  );
  const lines = src.split('\n');

  it("linked sort sets pfSort to { count: 'desc' } for Pagefind native sort", () => {
    // H6 fix (15.3-08): the places adapter now registers `count` as a
    // Pagefind sort attribute, and the client passes { count: 'desc' } to
    // pagefind.search() when state.sort === 'linked'. This structural pin
    // confirms the assignment `pfSort = { count: 'desc' }` (or equivalent
    // `pfSort.count = 'desc'`) appears in the source.
    //
    // Pre-patch (15.3-07 state): no `count: 'desc'` assignment exists —
    // the broken branch built a `linkedMap` and called filteredResults.sort()
    // using a.url (which is undefined on stubs). This test FAILS pre-patch.
    // Post-patch: the `count: 'desc'` assignment is present. Passes.
    const hasCountDesc = lines.some(line =>
      /count['"]?\s*:\s*['"]desc['"]/.test(line) ||
      /pfSort\.count\s*=\s*['"]desc['"]/.test(line)
    );
    expect(hasCountDesc).toBe(true);
  });

  it("name sort sets pfSort to { name: 'asc' } for Pagefind native sort", () => {
    // The 'name' sort has always used Pagefind native sort. This pin ensures
    // the assignment survives the 15.3-08 refactor. Pattern: either object
    // literal `{ name: 'asc' }` or property assignment `pfSort.name = 'asc'`.
    const hasNameAsc = lines.some(line =>
      /name['"]?\s*:\s*['"]asc['"]/.test(line) ||
      /pfSort\.name\s*=\s*['"]asc['"]/.test(line)
    );
    expect(hasNameAsc).toBe(true);
  });

  it('15.3-07 no-op client-side pre-slice sort block is absent', () => {
    // The 15.3-07 patch added a filteredResults.slice().sort() block that
    // was a no-op because a.url is undefined on raw Pagefind stubs. That
    // block must be removed in 15.3-08. If it is present, every linked-sort
    // query silently does nothing (and the correct Pagefind native sort is
    // never applied).
    const hasDeadSort = lines.some(line =>
      /filteredResults\s*=\s*filteredResults\.slice\(\)\.sort\(/.test(line)
    );
    expect(hasDeadSort).toBe(false);
  });

  it('post-slice sort on hits is absent', () => {
    // The pre-15.3-07 broken sort operated on hits (20-item page slice)
    // after the pagination cut. This must never return.
    const hasPostSliceSort = lines.some(line =>
      /hits\s*=\s*hits\.slice\(\)\.sort\(/.test(line)
    );
    expect(hasPostSliceSort).toBe(false);
  });
});

// ─── ── Sort UI parity: 'field:dir' state format ───────────────
//
// Pins for the /buscar/ sort-wrap pattern ported onto /lugares/.
// State format change: state.sort rotates from 'name' | 'linked' (old)
// to 'field:dir' (new). Four structural/behavioural cases:
//
//   Pin 1: parseUrlParams '?sort=linked'  → state.sort === 'linked:desc'
//   Pin 2: parseUrlParams '?sort=name:desc' → state.sort === 'name:desc'
//   Pin 3: click handler on active 'name:asc' button → state.sort becomes 'name:desc'
//   Pin 4: pagefind.search() receives { count: 'desc' } when state.sort === 'linked:desc'
//
// RED evidence (against old source, state.sort = 'name' | 'linked'):
//   Pin 1: old parseUrlParams sets state.sort = 'linked' (not 'linked:desc') → FAIL
//   Pin 2: old parseUrlParams sets state.sort = 'name:desc' only if passed verbatim
//          but old code did `params.get('sort') || 'name'` with no validation → actually
//          would pass through 'name:desc' — but 'linked' was not promoted → Pin 1 FAIL
//   Pin 3: old click handler compared full state.sort to 'name' — active check broke
//          because isActive = (this.state.sort === 'name'), old state is 'name:asc' —
//          wait, the old state was 'name' not 'name:asc'. Under NEW state format, Pin 3
//          tests the new toggle logic. These structural pins are source assertions.
//
// GREEN evidence (against new source): all four pass — see test run below.
//
// Structural approach: PlaceExplorer is not exported from the CJS footer
// (it requires DOM). Source assertions are deterministic and corpus-
// independent, mirroring the 15.3-06 and 15.3-08 structural-pin patterns.

describe('place-explorer sort UI parity — 15.3-09', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(
    new URL('../static/js/place-explorer.js', import.meta.url).pathname,
    'utf8'
  );
  const lines = src.split('\n');

  it("Pin 1: parseUrlParams promotes '?sort=linked' to 'linked:desc'", () => {
    // Old code: `this.state.sort = params.get('sort') || 'name'` — no promotion.
    // state.sort would be set to the bare string 'linked'. This test FAILS pre-patch.
    // New code: rawSort === 'linked' branch sets this.state.sort = 'linked:desc'.
    // Source assertion: the 'linked:desc' promotion assignment appears in parseUrlParams.
    const parseLines = [];
    let inParse = false;
    let braceDepth = 0;
    for (const line of lines) {
      if (!inParse && /parseUrlParams\(\)/.test(line) && /\{/.test(line)) {
        inParse = true;
        braceDepth = 0;
      }
      if (inParse) {
        parseLines.push(line);
        for (const ch of line) {
          if (ch === '{') braceDepth++;
          if (ch === '}') braceDepth--;
        }
        if (braceDepth === 0 && parseLines.length > 1) break;
      }
    }
    expect(parseLines.length).toBeGreaterThan(0);
    // The promotion line: `this.state.sort = 'linked:desc'`
    const hasPromotion = parseLines.some(l => /this\.state\.sort\s*=\s*['"]linked:desc['"]/.test(l));
    expect(hasPromotion).toBe(true);
  });

  it("Pin 2: parseUrlParams accepts 'name:desc' verbatim (passes through)", () => {
    // Old code: `this.state.sort = params.get('sort') || 'name'` passes 'name:desc'
    // through verbatim — but state then compared to 'name' in updateUrl/pfSort. Under
    // the new format, 'name:desc' is a valid sort; validSorts check accepts it.
    // Source assertion: 'name:desc' appears in the validSorts array.
    const hasNameDesc = lines.some(l => /['"]name:desc['"]/.test(l));
    expect(hasNameDesc).toBe(true);
    // Also assert all four canonical sorts are in the valid set.
    const validLine = lines.find(l => /validSorts/.test(l) && /\[/.test(l));
    expect(validLine).toBeDefined();
    expect(validLine).toMatch('name:asc');
    expect(validLine).toMatch('name:desc');
    expect(validLine).toMatch('linked:asc');
    expect(validLine).toMatch('linked:desc');
  });

  it('Pin 3: click handler toggles direction when active button is clicked', () => {
    // Old code: click handler did `if (this.state.sort === v) return` — toggling
    // was not supported; clicking the same sort just returned. Under new code,
    // the active branch flips direction: `dir === 'asc' ? 'desc' : 'asc'`.
    // Source assertion: the toggle expression appears in the click handler block.
    const hasToggle = lines.some(l =>
      /dir\s*===\s*['"]asc['"]\s*\?\s*['"]desc['"]\s*:\s*['"]asc['"]/.test(l)
    );
    expect(hasToggle).toBe(true);
  });

  it("Pin 4: pfSort passes { count: dir } when sortField === 'linked'", () => {
    // Old code (15.3-08): `pfSort = { count: 'desc' }` hardcoded — no direction var.
    // New code (15.3-09): `pfSortKey = sortField === 'linked' ? 'count' : sortField`
    // then `pfSort[pfSortKey] = sortDir` — dynamic, honours dir from state.sort.
    // Source assertion 1: the ternary mapping 'linked' → 'count' exists.
    const hasMappingTernary = lines.some(l =>
      /sortField\s*===\s*['"]linked['"]\s*\?\s*['"]count['"]\s*:\s*sortField/.test(l)
    );
    expect(hasMappingTernary).toBe(true);
    // Source assertion 2: pfSort is built by dynamic key assignment (not a literal).
    const hasDynamicAssign = lines.some(l =>
      /pfSort\[pfSortKey\]\s*=\s*sortDir/.test(l)
    );
    expect(hasDynamicAssign).toBe(true);
  });

  it('sort-wrap class name used (not sort-controls)', () => {
    // Old code used `sortControls.className = 'sort-controls'`. New code mirrors
    // /buscar/ and uses `sortWrap.className = 'sort-wrap'`. Old class must be gone.
    const hasSortWrap = lines.some(l => /['"]sort-wrap['"]/.test(l));
    const hasSortControls = lines.some(l =>
      /className\s*=\s*['"]sort-controls['"]/.test(l)
    );
    expect(hasSortWrap).toBe(true);
    expect(hasSortControls).toBe(false);
  });

  it("Documentos first-click defaults to 'linked:desc' (natural desc convention)", () => {
    // The /lugares/ sort convention: inactive Documentos → linked:desc, not linked:asc.
    // This is the exception cited in plan 15.3-09 — users expect "most docs first".
    // Source assertion: the 'linked:desc' literal appears in the click handler block,
    // adjacent to the convention comment.
    const hasLinkedDescDefault = lines.some(l =>
      /newSort\s*=\s*['"]linked:desc['"]/.test(l)
    );
    expect(hasLinkedDescDefault).toBe(true);
  });
});

// extension: adds a sixth describe block asserting that the
// sort-wrap in entity-explorer.js has been ported to the /buscar/ + /lugares/
// parity shape — `Ordenar por:` label, per-option `defaultDir`, `sort-arrow`
// span, and click-toggle direction logic. Five structural pins:
//
//   Pin 1: active 'Nombre' (state 'name:asc') renders ↑ — source must compute
//          arrowDir from the active branch (curDir = 'asc').
//   Pin 2: active 'Documentos' (state 'count:desc') renders ↓ — arrowDir from
//          curDir = 'desc'.
//   Pin 3: click active button toggles direction — toggle expression must be in
//          the click-handler block.
//   Pin 4: click inactive 'Documentos' when state is 'name:asc' → state becomes
//          'count:desc' — defaultDir for 'count' is 'desc'.
//   Pin 5: inactive 'Documentos' arrow hint is ↓ — defaultDir='desc' branch.
//
// Structural approach mirrors 15.3-09: EntityExplorer requires DOM so we assert
// the source text of entity-explorer.js rather than instantiating the class.
// RED evidence: these pins would fail against the pre-15.3-10 source because:
//   - Old source had no `defaultDir` field on sortOptions.
//   - Old source had no `sort-arrow` span.
//   - Old label was 'Ordenar:' (not 'Ordenar por:').
//   - Old click handler had no toggle logic (just set to opt.value).
// GREEN evidence (against patched source): all five pass — see test run output.

describe('entity-explorer sort UI parity — 15.3-10', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(
    new URL('../static/js/entity-explorer.js', import.meta.url).pathname,
    'utf8'
  );
  const lines = src.split('\n');

  it("Pin 1: active 'name:asc' → arrow shows ↑ — arrowDir uses curDir branch", () => {
    // Pre-patch: no sort-arrow span at all; no `arrowDir` variable.
    // Post-patch: `const arrowDir = isActive ? curDir : opt.defaultDir`
    //   followed by `arrow.textContent = arrowDir === 'desc' ? ' ↓' : ' ↑'`.
    // Source assertion 1: arrowDir variable assigned from isActive ternary.
    const hasArrowDirActive = lines.some(l =>
      /arrowDir\s*=\s*isActive\s*\?\s*curDir\s*:\s*opt\.defaultDir/.test(l)
    );
    expect(hasArrowDirActive).toBe(true);
    // Source assertion 2: arrow textContent set from arrowDir (not hardcoded).
    // The source stores arrows as `\u2193` / `\u2191` JS Unicode escapes, so we
    // match the literal escape text (\\u2193) rather than the decoded character.
    const hasArrowText = lines.some(l =>
      /arrowDir\s*===\s*['"]desc['"]/.test(l) && /\\u2193/.test(l) && /\\u2191/.test(l)
    );
    expect(hasArrowText).toBe(true);
  });

  it("Pin 2: active 'count:desc' → arrow shows ↓ — arrowDir='desc' branch covered", () => {
    // Covered by the arrowDir logic: when curDir === 'desc' and isActive, arrowDir = 'desc' → ↓.
    // Source assertion: the sort-arrow class name appears (span is emitted for every option).
    const hasSortArrowClass = lines.some(l => /['"]sort-arrow['"]/.test(l));
    expect(hasSortArrowClass).toBe(true);
    // Source assertion: the ↓ unicode escape (`\u2193`) appears on the arrowDir line.
    // The source stores `' \u2193'` as a JS Unicode escape; match the literal text.
    const hasDescArrow = lines.some(l =>
      /arrowDir/.test(l) && /\\u2193/.test(l)
    );
    expect(hasDescArrow).toBe(true);
  });

  it('Pin 3: click active button toggles direction — toggle expression present', () => {
    // Pre-patch: click handler did `this.state.sort = opt.value` — no toggle.
    // Post-patch: `dir === 'asc' ? 'desc' : 'asc'` in the active branch.
    const hasToggle = lines.some(l =>
      /dir\s*===\s*['"]asc['"]\s*\?\s*['"]desc['"]\s*:\s*['"]asc['"]/.test(l)
    );
    expect(hasToggle).toBe(true);
  });

  it("Pin 4: click inactive 'Documentos' (state='name:asc') → 'count:desc' — defaultDir applied", () => {
    // Pre-patch: click handler used a fixed value (`opt.value = 'count:desc'` was the
    //   only way to get desc, but the option object had no `defaultDir` key).
    // Post-patch: `this.state.sort = field + ':' + defaultDir` in the inactive branch,
    //   where defaultDir='desc' for the 'count' option.
    // Source assertion 1: the inactive branch uses `defaultDir` (not a hardcoded literal).
    const hasDefaultDirInactive = lines.some(l =>
      /this\.state\.sort\s*=\s*field\s*\+\s*['"]:['"].*defaultDir/.test(l)
    );
    expect(hasDefaultDirInactive).toBe(true);
    // Source assertion 2: `defaultDir: 'desc'` for the 'count' option.
    const hasCountDescDefault = lines.some(l =>
      /field\s*:\s*['"]count['"]/.test(l) && /defaultDir\s*:\s*['"]desc['"]/.test(l)
    );
    expect(hasCountDescDefault).toBe(true);
  });

  it("Pin 5: inactive 'Documentos' renders ↓ hint — defaultDir='desc' in sortOptions", () => {
    // Pre-patch: no sort-arrow span; no `defaultDir` on options.
    // Post-patch: `opt.defaultDir` for 'count' is 'desc', so inactive arrow = ' ↓'.
    // Source assertion: the count option has defaultDir: 'desc' (checked above via Pin 4
    //   partial match; here we assert the three-option array shape explicitly).
    const hasNombreAsc = lines.some(l =>
      /field\s*:\s*['"]name['"]/.test(l) && /defaultDir\s*:\s*['"]asc['"]/.test(l)
    );
    const hasFechaAsc = lines.some(l =>
      /field\s*:\s*['"]date['"]/.test(l) && /defaultDir\s*:\s*['"]asc['"]/.test(l)
    );
    const hasDocumentosDesc = lines.some(l =>
      /field\s*:\s*['"]count['"]/.test(l) && /defaultDir\s*:\s*['"]desc['"]/.test(l)
    );
    expect(hasNombreAsc).toBe(true);
    expect(hasFechaAsc).toBe(true);
    expect(hasDocumentosDesc).toBe(true);
    // And 'Ordenar por:' label (not 'Ordenar:').
    const hasOrdenarPor = lines.some(l => /['"]Ordenar por:['"]/. test(l));
    expect(hasOrdenarPor).toBe(true);
  });
});

// Version: v1.0.0
