/**
 * Entity Explorer Sidebar
 *
 * Powers the left-hand side of the `/entidades/` page. This is the
 * orchestrator for searching and filtering the ~92,000 entities (people,
 * corporate bodies, families) described in the Zasqua catalogue.
 *
 * Search runs entirely in the visitor's browser through Pagefind, a static
 * search library that ships a pre-built index alongside the site. The
 * explorer reads the `/pagefind-entities/` index (a dedicated entity-only
 * index, distinct from the descriptions index used by `/buscar/`), parses
 * the URL query string into its internal state, and renders four linked
 * pieces of UI: a search input, a facet sidebar (entity type, primary
 * function, and a century → decade → year date tree), an active-filter
 * pill row with a clear-all button, and a paginated result list with
 * sort controls. State is written back to the URL with `history.pushState`
 * so results are shareable and the browser back button works as expected.
 *
 * Because the `primary_function` facet has 1,573 distinct values, the
 * sidebar truncates it to ten and opens a searchable modal for "Ver todos".
 * A separate focal-card role facet (rendered into the selected-entity
 * card) lets the visitor narrow which documents hang off the focal entity
 * in the graph by documentary role — producer, witness, scribe, etc.
 *
 * The module also owns a viewport-filter mode: when enabled, it renders
 * result cards directly from the in-memory graph nodes currently visible
 * in the graph canvas, bypassing Pagefind entirely so an unfiltered 92k
 * query doesn't block the WebAssembly thread for tens of seconds.
 *
 * Callback hooks (`onEntitySelected`, `onFilterChanged`, `onFocalRoleFilterChanged`,
 * `onFocalCleared`, `onReady`) are wired by the inline script in
 * `entidades.njk` so the sidebar and the graph stay in sync without
 * either side holding a direct reference to the other.
 *
 * @version v0.5.0
 */

// Role labels shared with entity.js and infinite-bipartite-explorer.js
var roleLabels = {
  creator: 'Productor',
  contributor: 'Colaborador',
  publisher: 'Editor',
  subject: 'Materia',
  mentioned: 'Mencionado',
  sender: 'Remitente',
  recipient: 'Destinatario',
  plaintiff: 'Demandante',
  defendant: 'Demandado',
  author: 'Autor',
  scribe: 'Escribano',
  notary: 'Notario',
  witness: 'Testigo',
  petitioner: 'Peticionario',
  judge: 'Juez',
  appellant: 'Apelante',
  victim: 'Víctima',
  creditor: 'Acreedor',
  seller: 'Vendedor',
  debtor: 'Deudor',
  buyer: 'Comprador',
  albacea: 'Albacea',
  mortgagee: 'Acreedor hipotecario',
  official: 'Funcionario',
  heir: 'Heredero',
  spouse: 'Cónyuge',
  grantor: 'Otorgante',
  donor: 'Donante',
  mortgagor: 'Deudor hipotecario'
};

// Entity colours shared with entity.js and infinite-bipartite-explorer.js
var entityColors = {
  person: '#8B2942',
  corporate_body: '#6666BB',
  corporate: '#6666BB',
  family: '#6666BB'
};

// Documentary-role taxonomy.
// Spanish primary, English secondary. Members are the canonical lowercase
// enum values stored in DescriptionEntity.role. Some values (fiador,
// apoderado, editor, photographer, artist) are not in the live data yet.
// Groups with zero hits in the focal entity's shard are hidden in the UI.
var roleGroups = [
  {
    id: 'production',
    label_es: 'Producción y menciones',
    label_en: 'Production & mentions',
    members: ['creator', 'author', 'editor', 'publisher', 'mentioned', 'subject', 'official']
  },
  {
    id: 'correspondence',
    label_es: 'Correspondencia',
    label_en: 'Correspondence',
    members: ['sender', 'recipient']
  },
  {
    id: 'notarial',
    label_es: 'Atestación notarial',
    label_en: 'Notarial attestation',
    members: ['scribe', 'witness', 'notary']
  },
  {
    id: 'legal',
    label_es: 'Procesos judiciales',
    label_en: 'Legal proceedings',
    members: ['plaintiff', 'defendant', 'petitioner', 'judge', 'appellant', 'fiador', 'apoderado', 'victim']
  },
  {
    id: 'family',
    label_es: 'Familia y sucesión',
    label_en: 'Family & inheritance',
    members: ['heir', 'albacea', 'spouse']
  },
  {
    id: 'transactions',
    label_es: 'Transacciones',
    label_en: 'Transactions',
    members: ['grantor', 'donor', 'seller', 'buyer', 'mortgagor', 'mortgagee', 'creditor', 'debtor']
  },
  {
    id: 'visual',
    label_es: 'Materiales visuales',
    label_en: 'Visual materials',
    members: ['photographer', 'artist']
  }
];

class EntityExplorer {
  constructor(container) {
    this.container = container;
    this.pagefind = null;
    this.globalFilters = null;
    this.perPage = 20;

    this.entityTypeLabels = {};
    try {
      this.entityTypeLabels = JSON.parse(container.dataset.entityTypes || '{}');
    } catch (e) {
      console.warn('EntityExplorer: could not parse data-entity-types');
    }

    this.state = {
      q: '',
      entity_type: [],
      primary_function: [],
      dateFilter: null,  // { level: 'century'|'decade'|'year', label, years: string[] }
      sort: '',
      page: 1
    };

    // Focal-card role filter — scoped to the currently selected entity's
    // documents. Lives on the right-column card (not the left sidebar)
    // because role is a per-document relationship, not an entity property.
    // Reset whenever the focal entity changes.
    this.focalRoleFilter = new Set();
    this.focalShard = [];

    // Viewport filter — when true, render the result list directly from
    // the in-memory graph nodes whose data is currently visible in the
    // canvas viewport. We bypass Pagefind because an unfiltered query on
    // the 92k entity index would block the WASM thread for tens of
    // seconds. The host wires _visibleEntitiesSource (and the
    // lower-level _visibleCodeSource for post-filtering with other
    // facets) so the explorer doesn't need a direct reference to the
    // graph instance.
    this.viewportFilter = false;
    this._visibleCodeSource = null;
    this._visibleEntitiesSource = null;

    // Callback hooks — set by wiring script in entidades.njk
    this.onEntitySelected = null;  // (entityCode) — fired when user clicks entity in results
    this.onFilterChanged = null;   // (filters) — fired when any filter/search changes
    this.onFocalRoleFilterChanged = null;  // (Set<role>) — focal-card role filter changed

    this.facetGroupState = { entity_type: true, primary_function: true, date: true };
    // Compact mode: when facets are rendered separately into #sidebar-facets,
    // suppress the inline facet column in render() to avoid duplication.
    this.compactMode = !!document.getElementById('sidebar-facets');
    // Note: init() is called explicitly by the wiring script (entidades.njk) to control
    // initialization order. Do not call this.init() here.
  }

  async init() {
    this.parseUrlParams();

    try {
      this.pagefind = await import('/pagefind-entities/pagefind.js');
      await this.pagefind.options({ basePath: '/pagefind-entities/' });
      await this.pagefind.init();
      this.globalFilters = await this.pagefind.filters();
    } catch (e) {
      console.error('EntityExplorer: failed to load Pagefind:', e);
      this.showError();
      return;
    }

    // Render sidebar facets (entity type, role, date) and the search input
    // into their dedicated containers
    this.renderSidebarFacets(document.getElementById('sidebar-facets'));
    if (typeof this.onReady === 'function') this.onReady();
    const searchInputContainer = document.getElementById('entity-search-input');
    if (searchInputContainer) {
      searchInputContainer.innerHTML = '';
      searchInputContainer.appendChild(this.renderSearchInput());
    }

    window.addEventListener('popstate', () => {
      this.parseUrlParams();
      this.search();
    });

    this.search();
  }

  // --- URL state ---

  parseUrlParams() {
    const params = new URLSearchParams(window.location.search);
    this.state.q = params.get('q') || '';
    this.state.entity_type = params.getAll('tipo');
    this.state.primary_function = params.getAll('funcion');
    this.state.sort = params.get('orden') || '';
    this.state.page = parseInt(params.get('pagina'), 10) || 1;

    // Date drill-down: one active at a time
    this.state.dateFilter = null;
    const fechaNivel = params.get('fecha_nivel');
    const fechaValor = params.get('fecha_valor');
    if (fechaNivel && fechaValor) {
      if (fechaNivel === 'year') {
        this.state.dateFilter = { level: 'year', label: fechaValor, years: [fechaValor] };
      } else if (fechaNivel === 'decade') {
        const base = parseInt(fechaValor, 10);
        const years = [];
        for (let i = base; i < base + 10; i++) years.push(String(i));
        this.state.dateFilter = { level: 'decade', label: `${fechaValor}s`, years };
      } else if (fechaNivel === 'century') {
        const num = parseInt(fechaValor, 10);
        const base = (num - 1) * 100;
        const years = [];
        for (let i = base; i < base + 100; i++) years.push(String(i));
        this.state.dateFilter = { level: 'century', label: `Siglo ${this.romanCentury(num)}`, years };
      }
    }
  }

  updateUrl() {
    const params = new URLSearchParams();
    if (this.state.q) params.set('q', this.state.q);
    for (const t of this.state.entity_type) params.append('tipo', t);
    for (const f of this.state.primary_function) params.append('funcion', f);
    if (this.state.sort) params.set('orden', this.state.sort);
    if (this.state.page > 1) params.set('pagina', this.state.page);

    if (this.state.dateFilter) {
      const df = this.state.dateFilter;
      if (df.level === 'year') {
        params.set('fecha_nivel', 'year');
        params.set('fecha_valor', df.years[0]);
      } else if (df.level === 'decade') {
        params.set('fecha_nivel', 'decade');
        params.set('fecha_valor', df.years[0]);
      } else if (df.level === 'century') {
        const firstYear = parseInt(df.years[0], 10);
        const centuryNum = Math.floor(firstYear / 100) + 1;
        params.set('fecha_nivel', 'century');
        params.set('fecha_valor', String(centuryNum));
      }
    }

    const qs = params.toString();
    const url = qs ? `/entidades/?${qs}` : '/entidades/';
    history.pushState(null, '', url);
  }

  // --- Search ---

  async search() {
    if (!this.pagefind) return;

    const hasActiveFilters = this.state.entity_type.length > 0 ||
      this.state.primary_function.length > 0 ||
      this.state.dateFilter !== null ||
      this.viewportFilter;

    const isPreSearch = !this.state.q && !hasActiveFilters && !this.state.sort;

    this.showLoading();
    // Yield once so the spinner can paint before any WASM blocks. Use
    // setTimeout instead of requestAnimationFrame: rAF is paused in hidden
    // tabs (e.g. when the user opens /entidades/ in a background tab and
    // switches to it later), which would otherwise leave the explorer
    // permanently stuck on the loading spinner.
    await new Promise(r => setTimeout(r, 0));

    try {
      if (isPreSearch) {
        // Reset left-sidebar facets to global counts — the user has cleared
        // all filters, so other options should reappear at their full counts.
        const sidebarFacetsEl = document.getElementById('sidebar-facets');
        if (sidebarFacetsEl) this.renderSidebarFacets(sidebarFacetsEl, this.globalFilters);

        // Show browse prompt with total entity count
        const totalCount = this.getTotalEntityCount();
        this.renderSearchResults({
          hits: [],
          filters: this.globalFilters,
          total: 0,
          page: 1,
          total_pages: 0,
          query: '',
          browsePrompt: true,
          browsePromptMode: 'landing',
          totalEntityCount: totalCount
        });
        return;
      }

      // Filter-only with too many results: skip the slow Pagefind scan
      // and show the same warning prompt as description-search.
      // Viewport-only mode bypasses Pagefind entirely (synthesises hits
      // from in-memory graph nodes), so the threshold doesn't apply there.
      const onlyViewportActive = this.viewportFilter
        && this.state.entity_type.length === 0
        && this.state.primary_function.length === 0
        && this.state.dateFilter === null;
      if (!this.state.q && hasActiveFilters && !this.skipBrowsePrompt && !onlyViewportActive) {
        const estimated = this.estimateFilterCount();
        if (estimated > 10000) {
          this.renderSearchResults({
            hits: [],
            filters: this.globalFilters,
            total: estimated,
            page: 1,
            total_pages: 0,
            query: '',
            browsePrompt: true,
            browsePromptMode: 'overload'
          });
          return;
        }
      }

      // Reset the override so future filter changes re-evaluate the threshold
      this.skipBrowsePrompt = false;

      // Resolve dateFilter years against actual index
      if (this.state.dateFilter && this.globalFilters && this.globalFilters.year) {
        const indexYears = new Set(Object.keys(this.globalFilters.year));
        this.state.dateFilter.years = this.state.dateFilter.years.filter(y => indexYears.has(y));
      }

      // Build Pagefind filters
      const pfFilters = {};
      if (this.state.entity_type.length) pfFilters.entity_type = { any: this.state.entity_type };
      if (this.state.primary_function.length) pfFilters.primary_function = { any: this.state.primary_function };
      if (this.state.dateFilter && this.state.dateFilter.years.length) {
        pfFilters.year = { any: this.state.dateFilter.years };
      }

      // Build Pagefind sort. Apply the count:desc default only for real
      // searches — never on initial load (the pre-search guard above already
      // short-circuited that case). Sorting the full 92k index in WASM blocks
      // the main thread for 30+ seconds, so we only pay that cost when the
      // user has actually narrowed the result set with a query or filter.
      const effectiveSort = this.state.sort || 'count:desc';
      const [sortField, sortDir] = effectiveSort.split(':');
      const pfSort = { [sortField]: sortDir };

      // Viewport-only fast path: when the user has no other filters active
      // and the viewport toggle is on, render result cards directly from
      // the in-memory graph node data instead of going through Pagefind. A
      // null/null Pagefind search on the 92k entity index blocks the WASM
      // thread for tens of seconds; the visible viewport is at most ~100
      // entities, so we just synthesise hit objects from getVisibleEntities.
      const viewportOnly = this.viewportFilter && Object.keys(pfFilters).length === 0 && !this.state.q;
      let search;
      let allResults;
      if (viewportOnly) {
        const visible = (typeof this._visibleEntitiesSource === 'function')
          ? (this._visibleEntitiesSource() || [])
          : [];
        // Sort client-side per current sort selection (default count desc).
        const sortKey = (this.state.sort || 'count:desc').split(':');
        visible.sort((a, b) => {
          if (sortKey[0] === 'name') {
            return (a.label || '').localeCompare(b.label || '', 'es') * (sortKey[1] === 'desc' ? -1 : 1);
          }
          if (sortKey[0] === 'date') {
            return ((a.date_earliest || '') < (b.date_earliest || '') ? -1 : 1) * (sortKey[1] === 'desc' ? -1 : 1);
          }
          // count:desc default
          return (b.linked_count || 0) - (a.linked_count || 0);
        });
        // Synthesise Pagefind-style hit objects so renderResultCard works.
        allResults = visible.map(e => ({
          url: `/${e.entity_code}/`,
          data: () => Promise.resolve({
            url: `/${e.entity_code}/`,
            meta: {
              title: e.label,
              entity_type: e.entity_type,
              linked_count: String(e.linked_count || 0),
              date_earliest: e.date_earliest || '',
              date_latest: e.date_latest || ''
            }
          })
        }));
        // Compute scoped facet counts from the visible entities so the
        // left sidebar facets narrow to reflect what's actually in the
        // graph viewport (and empty facet groups disappear).
        const scopedFacets = { entity_type: {}, primary_function: {}, year: {}, century: {}, decade: {} };
        for (const e of visible) {
          if (e.entity_type) {
            scopedFacets.entity_type[e.entity_type] = (scopedFacets.entity_type[e.entity_type] || 0) + 1;
          }
          if (e.primary_function) {
            scopedFacets.primary_function[e.primary_function] = (scopedFacets.primary_function[e.primary_function] || 0) + 1;
          }
          // Year coverage: contribute the entity once per year in its lifespan
          const yEarly = parseInt(e.date_earliest, 10);
          const yLate = parseInt(e.date_latest, 10);
          if (!Number.isNaN(yEarly) && !Number.isNaN(yLate) && yEarly <= yLate && yLate - yEarly < 200) {
            const seenCenturies = new Set();
            const seenDecades = new Set();
            for (let y = yEarly; y <= yLate; y++) {
              const ys = String(y);
              scopedFacets.year[ys] = (scopedFacets.year[ys] || 0) + 1;
              const c = String(Math.floor((y - 1) / 100) + 1);
              const d = String(Math.floor(y / 10) * 10);
              if (!seenCenturies.has(c)) {
                seenCenturies.add(c);
                scopedFacets.century[c] = (scopedFacets.century[c] || 0) + 1;
              }
              if (!seenDecades.has(d)) {
                seenDecades.add(d);
                scopedFacets.decade[d] = (scopedFacets.decade[d] || 0) + 1;
              }
            }
          }
        }
        search = { results: allResults, filters: scopedFacets };
      } else {
        search = await this.pagefind.search(this.state.q || null, {
          filters: Object.keys(pfFilters).length ? pfFilters : undefined,
          sort: pfSort
        });
        allResults = search.results;
        // Combine viewport with other filters: post-filter by visible code set.
        if (this.viewportFilter && typeof this._visibleCodeSource === 'function') {
          const visibleCodes = this._visibleCodeSource() || new Set();
          allResults = search.results.filter(r => {
            const m = (r.url || '').match(/\/(ne-[^/]+)\//);
            return m && visibleCodes.has(m[1]);
          });
        }
      }

      const total = allResults.length;
      const totalPages = Math.ceil(total / this.perPage);
      const start = (this.state.page - 1) * this.perPage;
      const pageResults = allResults.slice(start, start + this.perPage);
      const hits = await Promise.all(pageResults.map(r => r.data()));

      const scopedFilters = search.filters || this.globalFilters;

      // Re-render the left-sidebar facets with scoped counts so other
      // filter options narrow to reflect what's still reachable.
      const sidebarFacetsEl = document.getElementById('sidebar-facets');
      if (sidebarFacetsEl) this.renderSidebarFacets(sidebarFacetsEl, scopedFilters);

      this.renderSearchResults({
        hits,
        filters: scopedFilters,
        total,
        page: this.state.page,
        total_pages: totalPages,
        query: this.state.q
      });

      // Fire filter callback so graph stays in sync
      if (this.onFilterChanged) {
        this.onFilterChanged({
          entityTypes: new Set(this.state.entity_type),
          functions: new Set(this.state.primary_function),
          searchQuery: this.state.q
        });
      }
    } catch (error) {
      console.error('EntityExplorer: search error:', error);
      this.showError();
    }
  }

  getTotalEntityCount() {
    if (!this.globalFilters) return 0;
    // Sum counts from entity_type filter as proxy for total entity count
    if (this.globalFilters.entity_type) {
      return Object.values(this.globalFilters.entity_type).reduce((a, b) => a + b, 0);
    }
    return 0;
  }

  // Estimate the result-set size for a filter-only query by summing the
  // global facet counts of each active filter and taking the smallest
  // (intersection upper bound). Mirrors search.js#estimateFilterCount.
  estimateFilterCount() {
    if (!this.globalFilters) return 0;
    const counts = [];

    if (this.state.entity_type.length && this.globalFilters.entity_type) {
      let sum = 0;
      for (const v of this.state.entity_type) {
        sum += this.globalFilters.entity_type[v] || 0;
      }
      counts.push(sum);
    }

    if (this.state.primary_function.length && this.globalFilters.primary_function) {
      let sum = 0;
      for (const v of this.state.primary_function) {
        sum += this.globalFilters.primary_function[v] || 0;
      }
      counts.push(sum);
    }

    if (this.state.dateFilter && this.state.dateFilter.years && this.globalFilters.year) {
      let sum = 0;
      for (const y of this.state.dateFilter.years) {
        sum += this.globalFilters.year[y] || 0;
      }
      counts.push(sum);
    }

    if (counts.length === 0) return this.getTotalEntityCount();
    return Math.min.apply(null, counts);
  }

  // --- Rendering ---

  renderSearchResults(data) {
    this._lastRenderData = data;
    this.container.innerHTML = '';

    const layout = document.createElement('div');
    layout.className = 'search-layout';

    // Results column
    const resultsCol = document.createElement('div');
    resultsCol.className = 'search-results';
    resultsCol.setAttribute('aria-live', 'polite');

    // Mobile filter toggle
    const mobileToggle = document.createElement('button');
    mobileToggle.className = 'mobile-filter-toggle';
    mobileToggle.type = 'button';
    mobileToggle.innerHTML = 'Filtrar resultados <span class="toggle-chevron">&#9660;</span>';
    mobileToggle.addEventListener('click', () => {
      const sidebar = this.container.querySelector('.search-sidebar');
      if (sidebar) {
        sidebar.classList.toggle('sidebar-open');
        mobileToggle.classList.toggle('toggle-open');
      }
    });
    resultsCol.appendChild(mobileToggle);

    // Browse prompt — two modes:
    //   landing  → no query, no filters (initial pre-search state)
    //   overload → filter-only with too many results to scan via Pagefind
    // Both share the same visual treatment (count + hint + button + warning)
    // matching the description-search overload prompt for consistency.
    if (data.browsePrompt) {
      const mode = data.browsePromptMode || 'landing';

      // Active filter pills (only relevant in overload mode)
      if (mode === 'overload') {
        const pills = this.renderPills();
        if (pills) resultsCol.appendChild(pills);
      }

      const prompt = document.createElement('div');
      prompt.className = 'search-browse-prompt';

      const countText = document.createElement('p');
      countText.className = 'browse-prompt-count';
      if (mode === 'overload') {
        countText.innerHTML = `<strong>${Number(data.total).toLocaleString('es-CO')}</strong> entidades coinciden con estos filtros.`;
      } else {
        const totalCount = data.totalEntityCount || 0;
        countText.innerHTML = totalCount > 0
          ? `<strong>${totalCount.toLocaleString('es-CO')}</strong> entidades en el archivo.`
          : '';
      }
      prompt.appendChild(countText);

      const hint = document.createElement('p');
      hint.className = 'browse-prompt-hint';
      hint.textContent = mode === 'overload'
        ? 'Agrega m\u00E1s t\u00E9rminos o filtros para acotar los resultados, o presiona:'
        : 'Empieza a escribir para buscar, o explora filtrando por tipo o fecha, o presiona:';
      prompt.appendChild(hint);

      const continueBtn = document.createElement('button');
      continueBtn.type = 'button';
      continueBtn.className = 'browse-prompt-btn';
      continueBtn.textContent = mode === 'overload' ? 'Ver todos' : 'Explorar todas';
      continueBtn.addEventListener('click', async () => {
        if (mode === 'overload') {
          // Force the next search to bypass the threshold guard
          this.skipBrowsePrompt = true;
          this.search();
          return;
        }
        // Landing mode: clear state and run a full search
        this.state.q = '';
        this.state.entity_type = [];
        this.state.primary_function = [];
        this.state.dateFilter = null;
        this.state.page = 1;
        this.updateUrl();

        this.showLoading();
        await new Promise(r => setTimeout(r, 0));
        try {
          const search = await this.pagefind.search(null);
          const total = search.results.length;
          const totalPages = Math.ceil(total / this.perPage);
          const pageResults = search.results.slice(0, this.perPage);
          const hits = await Promise.all(pageResults.map(r => r.data()));
          this.renderSearchResults({
            hits,
            filters: search.filters || this.globalFilters,
            total,
            page: 1,
            total_pages: totalPages,
            query: ''
          });
        } catch (e) {
          console.error('EntityExplorer: explore all error:', e);
          this.showError();
        }
      });
      prompt.appendChild(continueBtn);

      const warning = document.createElement('p');
      warning.className = 'browse-prompt-warning';
      warning.textContent = 'Tomar\u00E1 algunos segundos en cargar.';
      prompt.appendChild(warning);

      resultsCol.appendChild(prompt);

      if (!this.compactMode) {
        const sidebar = this.renderFacets(data);
        layout.appendChild(sidebar);
      }
      layout.appendChild(resultsCol);
      this.container.appendChild(layout);
      return;
    }

    // Results info bar (count + sort)
    resultsCol.appendChild(this.renderResultsInfo(data));

    // Active filter pills
    const pills = this.renderPills();
    if (pills) resultsCol.appendChild(pills);

    // (Search input lives in the left filter sidebar — see init().)

    // Result items or empty state
    if (data.hits.length === 0) {
      resultsCol.appendChild(this.renderNoResults());
    } else {
      const resultsList = document.createElement('div');
      resultsList.className = 'search-results-list';
      for (const hit of data.hits) {
        resultsList.appendChild(this.renderResultCard(hit, data.query));
      }
      resultsCol.appendChild(resultsList);
    }

    // Pagination
    if (data.total_pages > 1) {
      resultsCol.appendChild(this.renderPagination(data));
    }

    // Sidebar (suppressed in compact mode — facets render into #sidebar-facets)
    if (!this.compactMode) {
      const sidebar = this.renderFacets(data);
      layout.appendChild(sidebar);
    }
    layout.appendChild(resultsCol);

    this.container.appendChild(layout);
  }

  renderSearchInput() {
    // Use the same .refine-search styling as the descriptions explorer
    // (rounded pill, stone-50 bg, burgundy focus border).
    const wrap = document.createElement('div');
    wrap.className = 'refine-search';

    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Buscar entidades...';
    input.value = this.state.q;
    input.setAttribute('aria-label', 'Buscar entidades');

    let debounce = null;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.state.q = input.value.trim();
        this.state.page = 1;
        this.updateUrl();
        this.search();
      }, 300);
    });

    wrap.appendChild(input);
    return wrap;
  }

  renderResultCard(hit) {
    const item = document.createElement('div');
    item.className = 'search-result-item';

    // Clicking an entity in the index loads it in the graph
    item.style.cursor = 'pointer';
    item.addEventListener('click', (e) => {
      // Extract entity code from the result URL (pattern: /{code}/)
      const match = (hit.url || '').match(/\/(ne-[^/]+)\//);
      if (match && match[1] && this.onEntitySelected) {
        e.preventDefault();
        this.onEntitySelected(match[1]);
      }
    });

    // Row 1: title + type badge + date range
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex; flex-wrap:wrap; align-items:baseline; gap:0.5rem;';

    const title = document.createElement('h3');
    title.className = 'result-title';
    title.style.margin = '0';
    const link = document.createElement('a');
    link.href = hit.url;
    link.textContent = hit.meta.title || '';
    // Allow normal link navigation when onEntitySelected is not wired
    link.addEventListener('click', (e) => {
      if (this.onEntitySelected) e.stopPropagation();
    });
    title.appendChild(link);
    row1.appendChild(title);

    // Entity type badge
    const entityType = hit.meta.entity_type || '';
    if (entityType) {
      const badge = document.createElement('span');
      badge.className = 'entity-type-badge entity-type-badge--' + (
        entityType === 'person' ? 'person'
        : (entityType === 'corporate_body' || entityType === 'corporate') ? 'corporate'
        : entityType === 'family' ? 'family'
        : 'unknown'
      );
      badge.textContent = this.entityTypeLabels[entityType] || entityType;
      row1.appendChild(badge);
    }

    // Date range
    const dateEarliest = hit.meta.date_earliest || '';
    const dateLatest = hit.meta.date_latest || '';
    if (dateEarliest) {
      const dateMeta = document.createElement('span');
      dateMeta.className = 'result-meta';
      dateMeta.style.fontSize = '0.875rem';
      if (dateLatest && dateLatest !== dateEarliest) {
        dateMeta.textContent = `${dateEarliest}\u2013${dateLatest}`;
      } else {
        dateMeta.textContent = dateEarliest;
      }
      row1.appendChild(dateMeta);
    }

    item.appendChild(row1);

    // Row 2: primary function + doc count
    const primaryFunction = hit.meta.primary_function || '';
    const linkedCountRaw = hit.meta.linked_count || hit.meta.count || '';
    const linkedCount = parseInt(linkedCountRaw, 10) || 0;

    if (primaryFunction || linkedCount > 0) {
      const row2 = document.createElement('div');
      row2.style.marginTop = '2px';

      if (primaryFunction) {
        const funcSpan = document.createElement('span');
        funcSpan.className = 'entity-result-function';
        funcSpan.textContent = primaryFunction;
        row2.appendChild(funcSpan);
      }

      if (primaryFunction && linkedCount > 0) {
        row2.appendChild(document.createTextNode(' \u00B7 '));
      }

      if (linkedCount > 0) {
        const countSpan = document.createElement('span');
        countSpan.className = 'entity-result-doccount';
        const countFormatted = linkedCount.toLocaleString('es-CO');
        if (linkedCount === 1) {
          countSpan.textContent = `Asociado a 1 documento`;
        } else {
          countSpan.textContent = `Asociado a ${countFormatted} documentos`;
        }
        row2.appendChild(countSpan);
      }

      item.appendChild(row2);
    }

    // Row 3: name variants (max 3)
    const nameVariantsRaw = hit.meta.name_variants || '';
    if (nameVariantsRaw) {
      const variants = nameVariantsRaw.split(', ').filter(Boolean).slice(0, 3);
      if (variants.length > 0) {
        const row3 = document.createElement('div');
        row3.className = 'entity-result-variants';

        const label = document.createElement('span');
        label.style.color = 'var(--color-stone-400)';
        label.textContent = 'Tambien conocido como: ';
        row3.appendChild(label);

        row3.appendChild(document.createTextNode(variants.join(', ')));
        item.appendChild(row3);
      }
    }

    return item;
  }

  renderResultsInfo(data) {
    const info = document.createElement('div');
    info.className = 'results-info search-results-info';

    const count = document.createElement('span');
    count.className = 'results-count';
    if (data.total === 1) {
      count.textContent = '1 entidad';
    } else {
      count.textContent = `${data.total.toLocaleString('es-CO')} entidades`;
    }
    info.appendChild(count);

    // Sort controls
    const sortWrap = document.createElement('div');
    sortWrap.className = 'sort-wrap';

    const sortLabel = document.createElement('span');
    sortLabel.className = 'sort-label';
    sortLabel.textContent = 'Ordenar:';
    sortWrap.appendChild(sortLabel);

    const sortOptions = [
      { value: 'name:asc', label: 'Nombre' },
      { value: 'date:asc', label: 'Fecha' },
      { value: 'count:desc', label: 'Documentos' }
    ];

    sortOptions.forEach((opt, i) => {
      if (i > 0) {
        const divider = document.createElement('span');
        divider.className = 'sort-divider';
        divider.textContent = '|';
        sortWrap.appendChild(divider);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sort-btn';
      if (this.state.sort === opt.value) btn.classList.add('active');
      btn.textContent = opt.label;

      btn.addEventListener('click', () => {
        this.state.sort = opt.value;
        this.state.page = 1;
        this.updateUrl();
        this.search();
      });

      sortWrap.appendChild(btn);
    });

    info.appendChild(sortWrap);
    return info;
  }

  // --- Focal-card role facet ---
  //
  // Renders the 7-group documentary-role taxonomy scoped to the currently
  // selected entity's shard. Groups (and their children) with zero hits
  // in the focal entity's documents are hidden. Ticking a checkbox
  // filters which docs hang off the focal entity in the graph — it does
  // NOT filter the entity results list (role is per-document, not
  // per-entity).
  //
  // The 7-group rollup is computed client-side from a flat list of
  // canonical role values. Additional roles slot into the existing groups
  // without restructuring the UI.
  renderFocalRoleFacet(shard) {
    // Count roles in the focal entity's shard
    const counts = {};
    for (const link of shard) {
      const r = (link.role || '').toLowerCase();
      if (!r) continue;
      counts[r] = (counts[r] || 0) + 1;
    }

    // Compute per-group totals and surviving members
    const visibleGroups = [];
    for (const group of roleGroups) {
      const members = group.members
        .map(role => ({ role, count: counts[role] || 0 }))
        .filter(m => m.count > 0)
        .sort((a, b) => b.count - a.count);
      if (members.length === 0) continue;
      const total = members.reduce((s, m) => s + m.count, 0);
      visibleGroups.push({ ...group, members, total });
    }

    if (visibleGroups.length === 0) return null;

    const wrap = document.createElement('div');
    wrap.className = 'focal-role-facet';

    const header = document.createElement('div');
    header.className = 'focal-role-facet-header';
    const title = document.createElement('span');
    title.className = 'focal-role-facet-title';
    title.textContent = 'Filtrar conexiones a documentos por rol';
    header.appendChild(title);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'focal-role-facet-clear';
    clearBtn.textContent = 'Limpiar';
    clearBtn.style.display = this.focalRoleFilter.size > 0 ? '' : 'none';
    clearBtn.addEventListener('click', () => {
      this.focalRoleFilter = new Set();
      this._notifyFocalRoleFilter();
      // Re-render the facet so checkboxes reset
      const stale = wrap.parentElement;
      const fresh = this.renderFocalRoleFacet(this.focalShard);
      if (stale && fresh) stale.replaceChild(fresh, wrap);
    });
    header.appendChild(clearBtn);
    wrap.appendChild(header);

    for (const group of visibleGroups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'focal-role-group';

      const groupHeader = document.createElement('div');
      groupHeader.className = 'focal-role-group-header';

      // Group-level checkbox: checked iff every visible member is active
      const allChecked = group.members.every(m => this.focalRoleFilter.has(m.role));
      const someChecked = group.members.some(m => this.focalRoleFilter.has(m.role));
      const groupCheckbox = document.createElement('input');
      groupCheckbox.type = 'checkbox';
      groupCheckbox.className = 'focal-role-group-checkbox';
      groupCheckbox.checked = allChecked;
      groupCheckbox.indeterminate = someChecked && !allChecked;
      groupCheckbox.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      groupCheckbox.addEventListener('change', () => {
        if (groupCheckbox.checked) {
          group.members.forEach(m => this.focalRoleFilter.add(m.role));
        } else {
          group.members.forEach(m => this.focalRoleFilter.delete(m.role));
        }
        this._notifyFocalRoleFilter();
        const stale = wrap.parentElement;
        const fresh = this.renderFocalRoleFacet(this.focalShard);
        if (stale && fresh) stale.replaceChild(fresh, wrap);
      });
      groupHeader.appendChild(groupCheckbox);

      const groupLabel = document.createElement('span');
      groupLabel.className = 'focal-role-group-label';
      groupLabel.textContent = group.label_es;
      groupHeader.appendChild(groupLabel);

      const groupCount = document.createElement('span');
      groupCount.className = 'focal-role-group-count';
      groupCount.textContent = `(${group.total.toLocaleString('es-CO')})`;
      groupHeader.appendChild(groupCount);

      const chevron = document.createElement('span');
      chevron.className = 'focal-role-group-chevron';
      const expanded = someChecked; // expand if anything in this group is checked
      chevron.textContent = expanded ? '\u2212' : '+';
      groupHeader.appendChild(chevron);

      groupHeader.addEventListener('click', () => {
        const isExpanded = groupEl.classList.toggle('is-expanded');
        chevron.textContent = isExpanded ? '\u2212' : '+';
      });
      if (expanded) groupEl.classList.add('is-expanded');

      groupEl.appendChild(groupHeader);

      const memberList = document.createElement('div');
      memberList.className = 'focal-role-group-members';
      for (const m of group.members) {
        const optLabel = document.createElement('label');
        optLabel.className = 'focal-role-option';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = m.role;
        cb.checked = this.focalRoleFilter.has(m.role);
        cb.addEventListener('change', () => {
          if (cb.checked) {
            this.focalRoleFilter.add(m.role);
          } else {
            this.focalRoleFilter.delete(m.role);
          }
          this._notifyFocalRoleFilter();
          // Refresh group-level checkbox state and clear button visibility
          const stale = wrap.parentElement;
          const fresh = this.renderFocalRoleFacet(this.focalShard);
          if (stale && fresh) stale.replaceChild(fresh, wrap);
        });
        optLabel.appendChild(cb);

        const text = document.createElement('span');
        text.className = 'focal-role-option-label';
        text.textContent = roleLabels[m.role] || m.role;
        optLabel.appendChild(text);

        const cnt = document.createElement('span');
        cnt.className = 'focal-role-option-count';
        cnt.textContent = `(${m.count.toLocaleString('es-CO')})`;
        optLabel.appendChild(cnt);

        memberList.appendChild(optLabel);
      }
      groupEl.appendChild(memberList);

      wrap.appendChild(groupEl);
    }

    return wrap;
  }

  // Notify the graph that the focal-card role filter changed.
  _notifyFocalRoleFilter() {
    if (typeof this.onFocalRoleFilterChanged === 'function') {
      this.onFocalRoleFilterChanged(new Set(this.focalRoleFilter));
    }
  }

  // --- Sidebar facets (entity type, function, date) ---

  renderSidebarFacets(containerEl, filtersArg) {
    if (!containerEl || !this.globalFilters) return;

    containerEl.innerHTML = '';

    // Use scoped filters from a recent search when available so the facet
    // counts narrow as the user applies filters (matching the descriptions
    // explorer behavior). Fall back to globalFilters on initial render.
    const filters = filtersArg || this.globalFilters;

    if (filters.entity_type) {
      containerEl.appendChild(this.renderFacetGroup(
        'Tipo de entidad',
        'entity_type',
        filters.entity_type,
        this.state.entity_type,
        (value) => this.entityTypeLabels[value] || value
      ));
    }

    if (filters.primary_function) {
      containerEl.appendChild(this.renderFacetGroup(
        'Función principal',
        'primary_function',
        filters.primary_function,
        this.state.primary_function,
        (value) => value,
        null,
        10
      ));
    }

    if (filters.year && Object.values(filters.year).some(c => c > 0)) {
      containerEl.appendChild(this.renderDateTree(filters.year, filters.century || {}, filters.decade || {}));
    }
  }

  // --- Selected entity card (right column) ---
  // Renders into the #focal-entity-card host. Layout: eyebrow + Cormorant
  // name + periwinkle type pill + big burgundy doc count + "Ver página
  // completa" link, with an X button that restores the stub state.

  highlightEntity(entityCode, entityMeta, shard) {
    this._currentFocalCode = entityCode;
    this._currentFocalMeta = entityMeta || {};

    // Reset focal-card role filter when focal entity changes
    if (entityCode !== this._lastFocalForRoleFilter) {
      this.focalRoleFilter = new Set();
      this._lastFocalForRoleFilter = entityCode;
    }
    this.focalShard = Array.isArray(shard) ? shard : [];

    const cardEl = document.getElementById('focal-entity-card');
    if (cardEl) {
      const typeLabel = entityMeta.entity_type === 'person' ? 'Persona'
        : entityMeta.entity_type === 'corporate_body' || entityMeta.entity_type === 'corporate' ? 'Entidad corporativa'
        : entityMeta.entity_type === 'family' ? 'Familia'
        : (entityMeta.entity_type || '');

      cardEl.classList.remove('is-stub');
      cardEl.innerHTML = '';

      // Header row: eyebrow + close button
      const header = document.createElement('div');
      header.className = 'selected-entity-header';
      const eyebrow = document.createElement('div');
      eyebrow.className = 'selected-entity-eyebrow';
      eyebrow.textContent = 'Entidad seleccionada';
      header.appendChild(eyebrow);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'selected-entity-close';
      closeBtn.setAttribute('aria-label', 'Deseleccionar entidad');
      closeBtn.textContent = '\u2715';
      closeBtn.addEventListener('click', () => {
        this.clearFocalCard();
        if (typeof this.onFocalCleared === 'function') this.onFocalCleared();
      });
      header.appendChild(closeBtn);
      cardEl.appendChild(header);

      const nameEl = document.createElement('div');
      nameEl.className = 'selected-entity-name';
      nameEl.textContent = entityMeta.label || entityCode;
      cardEl.appendChild(nameEl);

      if (typeLabel) {
        const badge = document.createElement('span');
        badge.className = 'selected-entity-badge selected-entity-badge--' + (
          entityMeta.entity_type === 'person' ? 'person'
          : (entityMeta.entity_type === 'corporate_body' || entityMeta.entity_type === 'corporate') ? 'corporate'
          : entityMeta.entity_type === 'family' ? 'family'
          : 'unknown'
        );
        badge.textContent = typeLabel;
        cardEl.appendChild(badge);
      }

      // Big doc count
      const count = entityMeta.linked_count || 0;
      const stat = document.createElement('div');
      stat.className = 'selected-entity-stat';
      const statNum = document.createElement('div');
      statNum.className = 'selected-entity-stat-num';
      statNum.textContent = Number(count).toLocaleString('es-CO');
      const statLbl = document.createElement('div');
      statLbl.className = 'selected-entity-stat-label';
      statLbl.textContent = count === 1 ? 'documento vinculado' : 'documentos vinculados';
      stat.appendChild(statNum);
      stat.appendChild(statLbl);
      cardEl.appendChild(stat);

      // Documentary-role facet (scoped to this entity's docs).
      // Hidden entirely if the shard has no roles to show.
      const roleFacet = this.renderFocalRoleFacet(this.focalShard);
      if (roleFacet) cardEl.appendChild(roleFacet);

      // Footer link
      const footer = document.createElement('div');
      footer.className = 'selected-entity-footer';
      const link = document.createElement('a');
      link.className = 'selected-entity-link';
      link.href = `/${entityCode}/`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Ver ficha completa \u2192';
      footer.appendChild(link);
      cardEl.appendChild(footer);
    }

    // Highlight the entity in the result list if present
    const existingItem = this.container.querySelector(
      `.search-result-item a[href*="/${entityCode}/"]`
    );
    if (existingItem) {
      this.container.querySelectorAll('.search-result-item.graph-focused')
        .forEach(el => el.classList.remove('graph-focused'));
      const itemEl = existingItem.closest('.search-result-item');
      if (itemEl) {
        itemEl.classList.add('graph-focused');
        itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  clearFocalCard() {
    this._currentFocalCode = null;
    this._currentFocalMeta = null;
    const cardEl = document.getElementById('focal-entity-card');
    if (!cardEl) return;
    cardEl.classList.add('is-stub');
    cardEl.innerHTML = '<div class="selected-entity-stub">Selecciona una entidad para ver más detalles</div>';
    this.container.querySelectorAll('.search-result-item.graph-focused')
      .forEach(el => el.classList.remove('graph-focused'));
  }

  renderFacets(data) {
    const sidebar = document.createElement('aside');
    sidebar.className = 'search-sidebar';

    // Mobile filter panel header
    const panelHeader = document.createElement('div');
    panelHeader.className = 'filter-panel-header';
    panelHeader.innerHTML =
      '<span class="filter-panel-title">Filtros</span>' +
      '<button class="filter-panel-close" type="button" aria-label="Cerrar filtros">' +
      '<span class="material-symbols-outlined">close</span></button>';
    sidebar.appendChild(panelHeader);

    // Desktop heading
    const heading = document.createElement('h3');
    heading.className = 'search-sidebar-heading';
    heading.textContent = 'Filtros';
    sidebar.appendChild(heading);

    // Sidebar search input
    sidebar.appendChild(this.renderSidebarSearchInput());

    const filters = data.filters || {};

    // Facet: entity type
    if (filters.entity_type) {
      sidebar.appendChild(this.renderFacetGroup(
        'Tipo de entidad',
        'entity_type',
        filters.entity_type,
        this.state.entity_type,
        (value) => this.entityTypeLabels[value] || value
      ));
    }

    // Facet: primary function
    if (filters.primary_function) {
      sidebar.appendChild(this.renderFacetGroup(
        'Función principal',
        'primary_function',
        filters.primary_function,
        this.state.primary_function,
        (value) => value,
        null,
        10
      ));
    }

    // Facet: date drill-down tree
    if (filters.year && Object.values(filters.year).some(c => c > 0)) {
      sidebar.appendChild(this.renderDateTree(filters.year, filters.century || {}, filters.decade || {}));
    }

    // Mobile panel bottom close
    const panelBottom = document.createElement('div');
    panelBottom.className = 'filter-panel-bottom-close';
    panelBottom.innerHTML =
      '<button type="button">' +
      '<span class="material-symbols-outlined">expand_less</span> Cerrar filtros</button>';
    sidebar.appendChild(panelBottom);

    // Wire up close handlers
    const closePanel = () => {
      sidebar.classList.remove('sidebar-open');
      const toggle = this.container.querySelector('.mobile-filter-toggle');
      if (toggle) toggle.classList.remove('toggle-open');
    };
    panelHeader.querySelector('.filter-panel-close').addEventListener('click', closePanel);
    panelBottom.querySelector('button').addEventListener('click', closePanel);

    return sidebar;
  }

  renderSidebarSearchInput() {
    const wrap = document.createElement('div');
    wrap.className = 'search-refine-wrap';

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'search-refine-input';
    input.placeholder = 'Buscar entidades...';
    input.value = this.state.q;
    input.setAttribute('aria-label', 'Buscar entidades');

    let debounce = null;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        this.state.q = input.value.trim();
        this.state.page = 1;
        this.updateUrl();
        this.search();
      }, 300);
    });

    wrap.appendChild(input);
    return wrap;
  }

  renderFacetGroup(title, stateKey, facetData, activeValues, labelFn, sortFn, maxVisible) {
    const group = document.createElement('div');
    group.className = 'facet-group';

    const isOpen = this.facetGroupState[stateKey] !== false;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'facet-group-toggle';
    toggle.innerHTML = `<span class="facet-group-title">${this.escapeHtml(title)}</span><span class="facet-group-indicator">${isOpen ? '\u2212' : '+'}</span>`;
    toggle.addEventListener('click', () => {
      this.facetGroupState[stateKey] = !this.facetGroupState[stateKey];
      const content = group.querySelector('.facet-group-content');
      const indicator = toggle.querySelector('.facet-group-indicator');
      if (content) {
        content.style.display = this.facetGroupState[stateKey] ? '' : 'none';
        indicator.textContent = this.facetGroupState[stateKey] ? '\u2212' : '+';
      }
    });
    group.appendChild(toggle);

    const content = document.createElement('div');
    content.className = 'facet-group-content';
    content.style.display = isOpen ? '' : 'none';

    const entries = Object.entries(facetData).sort((a, b) => {
      const aActive = activeValues.includes(a[0]) ? 1 : 0;
      const bActive = activeValues.includes(b[0]) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      if (sortFn) return sortFn(a, b);
      return b[1] - a[1];
    });

    const hasActive = activeValues.length > 0;
    let rendered = 0;

    for (const [value, count] of entries) {
      if (hasActive && !activeValues.includes(value)) continue;
      if (count === 0 && !activeValues.includes(value)) continue;

      if (maxVisible && !hasActive && rendered >= maxVisible) break;

      const label = document.createElement('label');
      label.className = 'facet-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = value;
      checkbox.checked = activeValues.includes(value);
      checkbox.addEventListener('change', () => {
        this.handleFilterChange(stateKey, value, checkbox.checked);
      });
      label.appendChild(checkbox);

      const text = document.createElement('span');
      text.className = 'facet-label-text';
      text.textContent = labelFn(value);
      label.appendChild(text);

      const countSpan = document.createElement('span');
      countSpan.className = 'facet-count';
      countSpan.textContent = `(${Number(count).toLocaleString('es-CO')})`;
      label.appendChild(countSpan);

      content.appendChild(label);
      rendered++;
    }

    // "Ver todos" button when there are more items than maxVisible
    if (maxVisible && !hasActive && entries.length > maxVisible) {
      const showAllBtn = document.createElement('button');
      showAllBtn.type = 'button';
      showAllBtn.className = 'facet-show-all-btn';
      showAllBtn.textContent = `Ver todos (${entries.length.toLocaleString('es-CO')})`;
      showAllBtn.addEventListener('click', () => {
        this.openFacetModal(title, stateKey, entries, activeValues, labelFn);
      });
      content.appendChild(showAllBtn);
    }

    group.appendChild(content);
    return group;
  }

  openFacetModal(title, stateKey, entries, activeValues, labelFn) {
    // Remove any existing modal
    var existing = document.getElementById('facet-modal-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'facet-modal-overlay';
    overlay.className = 'facet-modal-overlay';

    var modal = document.createElement('div');
    modal.className = 'facet-modal';

    // Header
    var header = document.createElement('div');
    header.className = 'facet-modal-header';
    var titleEl = document.createElement('h3');
    titleEl.textContent = title;
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'facet-modal-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(titleEl);
    header.appendChild(closeBtn);
    modal.appendChild(header);

    // Search input
    var searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'facet-modal-search';
    searchInput.placeholder = 'Buscar...';
    modal.appendChild(searchInput);

    // List container
    var list = document.createElement('div');
    list.className = 'facet-modal-list';

    var self = this;

    // Sort entries alphabetically by label for the modal
    var sortedEntries = entries.slice().sort(function(a, b) {
      return labelFn(a[0]).localeCompare(labelFn(b[0]), 'es');
    });

    function renderModalEntries(filter) {
      list.innerHTML = '';
      var filterLower = (filter || '').toLowerCase();
      var isFiltering = filterLower.length > 0;
      var shown = 0;
      var currentLetter = '';

      for (var i = 0; i < sortedEntries.length; i++) {
        var value = sortedEntries[i][0];
        var count = sortedEntries[i][1];
        if (count === 0) continue;
        var labelText = labelFn(value);
        if (isFiltering && labelText.toLowerCase().indexOf(filterLower) === -1) continue;

        // Letter header (skip when searching)
        if (!isFiltering) {
          var firstLetter = labelText[0].toUpperCase();
          if (firstLetter !== currentLetter) {
            currentLetter = firstLetter;
            var letterHeader = document.createElement('div');
            letterHeader.className = 'facet-modal-letter';
            letterHeader.textContent = currentLetter;
            list.appendChild(letterHeader);
          }
        }

        var label = document.createElement('label');
        label.className = 'facet-option';

        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = value;
        checkbox.checked = activeValues.includes(value);
        (function(v, cb) {
          cb.addEventListener('change', function() {
            self.handleFilterChange(stateKey, v, cb.checked);
            if (cb.checked && !activeValues.includes(v)) activeValues.push(v);
            else if (!cb.checked) {
              var idx = activeValues.indexOf(v);
              if (idx !== -1) activeValues.splice(idx, 1);
            }
          });
        })(value, checkbox);
        label.appendChild(checkbox);

        var text = document.createElement('span');
        text.className = 'facet-label-text';
        text.textContent = labelText;
        label.appendChild(text);

        var countSpan = document.createElement('span');
        countSpan.className = 'facet-count';
        countSpan.textContent = '(' + Number(count).toLocaleString('es-CO') + ')';
        label.appendChild(countSpan);

        list.appendChild(label);
        shown++;
      }
      if (shown === 0) {
        var empty = document.createElement('p');
        empty.className = 'facet-modal-empty';
        empty.textContent = 'No se encontraron resultados';
        list.appendChild(empty);
      }
    }

    renderModalEntries('');

    searchInput.addEventListener('input', function() {
      renderModalEntries(searchInput.value);
    });

    modal.appendChild(list);
    overlay.appendChild(modal);

    // Close on overlay click (outside modal)
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) overlay.remove();
    });

    // Close on Escape
    var escHandler = function(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(overlay);
    searchInput.focus();
  }

  renderDateTree(yearData, centuryFacet, decadeFacet) {
    // centuryFacet / decadeFacet: pagefind filter maps from dedicated
    // entity-level century/decade tags. Each entity contributes once per
    // century/decade it spans, so these counts represent unique entities.
    // The year-level data is unchanged (single year per entity per year).
    centuryFacet = centuryFacet || {};
    decadeFacet = decadeFacet || {};
    const group = document.createElement('div');
    group.className = 'facet-group';

    const isOpen = this.facetGroupState.date !== false;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'facet-group-toggle';
    toggle.innerHTML = '<span class="facet-group-title">Fecha</span><span class="facet-group-indicator">' + (isOpen ? '\u2212' : '+') + '</span>';
    toggle.addEventListener('click', () => {
      this.facetGroupState.date = !this.facetGroupState.date;
      const content = group.querySelector('.facet-group-content');
      const indicator = toggle.querySelector('.facet-group-indicator');
      if (content) {
        content.style.display = this.facetGroupState.date ? '' : 'none';
        indicator.textContent = this.facetGroupState.date ? '\u2212' : '+';
      }
    });
    group.appendChild(toggle);

    const content = document.createElement('div');
    content.className = 'facet-group-content';
    content.style.display = isOpen ? '' : 'none';

    // Build century → decade → year hierarchy from flat year data
    const centuries = new Map();
    for (const [yearStr, count] of Object.entries(yearData)) {
      const year = parseInt(yearStr, 10);
      if (isNaN(year)) continue;
      if (count === 0) continue;
      const centuryNum = Math.floor(year / 100) + 1;
      const decadeBase = Math.floor(year / 10) * 10;

      if (!centuries.has(centuryNum)) {
        centuries.set(centuryNum, { decades: new Map(), total: 0, years: [] });
      }
      const century = centuries.get(centuryNum);
      century.total += count;
      century.years.push(yearStr);

      if (!century.decades.has(decadeBase)) {
        century.decades.set(decadeBase, new Map());
      }
      century.decades.get(decadeBase).set(yearStr, count);
    }

    const df = this.state.dateFilter;
    const tree = document.createElement('ul');
    tree.className = 'date-tree';

    const sortedCenturies = Array.from(centuries.entries()).sort((a, b) => a[0] - b[0]);

    for (const [centuryNum, centuryData] of sortedCenturies) {
      const centuryLabel = `Siglo ${this.romanCentury(centuryNum)}`;

      if (df && df.level === 'century' && df.label !== centuryLabel) continue;
      if (df && (df.level === 'decade' || df.level === 'year')) {
        const selectedYear = parseInt(df.years[0], 10);
        const selectedCentury = Math.floor(selectedYear / 100) + 1;
        if (selectedCentury !== centuryNum) continue;
      }

      const isCenturyActive = df && df.level === 'century' && df.label === centuryLabel;
      const existingYears = centuryData.years;

      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'date-tree-row';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'date-tree-toggle';
      const autoExpand = isCenturyActive || (df && (df.level === 'decade' || df.level === 'year'));
      toggleBtn.textContent = autoExpand ? '\u25BE' : '\u25B8';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'date-tree-checkbox';
      checkbox.checked = isCenturyActive;
      checkbox.addEventListener('change', () => {
        this.handleDateSelect(checkbox.checked ? {
          level: 'century', label: centuryLabel, years: existingYears
        } : null);
      });

      const label = document.createElement('span');
      label.className = 'date-tree-label';
      label.textContent = centuryLabel;

      const countSpan = document.createElement('span');
      countSpan.className = 'date-tree-count';
      const centuryEntityCount = centuryFacet[String(centuryNum)];
      const centuryDisplay = (centuryEntityCount != null ? centuryEntityCount : centuryData.total);
      countSpan.textContent = `(${Number(centuryDisplay).toLocaleString('es-CO')})`;

      row.appendChild(toggleBtn);
      row.appendChild(checkbox);
      row.appendChild(label);
      row.appendChild(countSpan);
      li.appendChild(row);

      // Decades
      const decadeList = document.createElement('ul');
      decadeList.className = 'date-tree-children' + (autoExpand ? '' : ' collapsed');

      const sortedDecades = Array.from(centuryData.decades.entries()).sort((a, b) => a[0] - b[0]);

      for (const [decadeBase, yearsMap] of sortedDecades) {
        const decadeLabel = `${decadeBase}s`;
        const decadeExistingYears = Array.from(yearsMap.keys());

        if (df && df.level === 'decade' && df.label !== decadeLabel) continue;
        if (df && df.level === 'year') {
          const selectedDecade = Math.floor(parseInt(df.years[0], 10) / 10) * 10;
          if (selectedDecade !== decadeBase) continue;
        }

        let decadeTotal = 0;
        for (const c of yearsMap.values()) decadeTotal += c;
        const decadeEntityCount = decadeFacet[String(decadeBase)];
        if (decadeEntityCount != null) decadeTotal = decadeEntityCount;

        const isDecadeActive = df && df.level === 'decade' && df.label === decadeLabel;
        const autoExpandDecade = isDecadeActive || (df && df.level === 'year');

        const decadeLi = document.createElement('li');
        const decadeRow = document.createElement('div');
        decadeRow.className = 'date-tree-row';

        const decadeToggle = document.createElement('button');
        decadeToggle.type = 'button';
        decadeToggle.className = 'date-tree-toggle';
        decadeToggle.textContent = autoExpandDecade ? '\u25BE' : '\u25B8';

        const decadeCb = document.createElement('input');
        decadeCb.type = 'checkbox';
        decadeCb.className = 'date-tree-checkbox';
        decadeCb.checked = isDecadeActive;
        decadeCb.addEventListener('change', () => {
          this.handleDateSelect(decadeCb.checked ? {
            level: 'decade', label: decadeLabel, years: decadeExistingYears
          } : null);
        });

        const decadeLabelSpan = document.createElement('span');
        decadeLabelSpan.className = 'date-tree-label';
        decadeLabelSpan.textContent = decadeLabel;

        const decadeCount = document.createElement('span');
        decadeCount.className = 'date-tree-count';
        decadeCount.textContent = `(${decadeTotal.toLocaleString('es-CO')})`;

        decadeRow.appendChild(decadeToggle);
        decadeRow.appendChild(decadeCb);
        decadeRow.appendChild(decadeLabelSpan);
        decadeRow.appendChild(decadeCount);
        decadeLi.appendChild(decadeRow);

        // Years
        const yearList = document.createElement('ul');
        yearList.className = 'date-tree-children' + (autoExpandDecade ? '' : ' collapsed');

        const sortedYears = Array.from(yearsMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

        for (const [yearStr, yearCount] of sortedYears) {
          if (df && df.level === 'year' && df.years[0] !== yearStr) continue;

          const isYearActive = df && df.level === 'year' && df.years[0] === yearStr;

          const yearLi = document.createElement('li');
          const yearRow = document.createElement('div');
          yearRow.className = 'date-tree-row';

          const spacer = document.createElement('span');
          spacer.className = 'date-tree-spacer';

          const yearCb = document.createElement('input');
          yearCb.type = 'checkbox';
          yearCb.className = 'date-tree-checkbox';
          yearCb.checked = isYearActive;
          yearCb.addEventListener('change', () => {
            this.handleDateSelect(yearCb.checked ? {
              level: 'year', label: yearStr, years: [yearStr]
            } : null);
          });

          const yearLabelSpan = document.createElement('span');
          yearLabelSpan.className = 'date-tree-label';
          yearLabelSpan.textContent = yearStr;

          const yearCountSpan = document.createElement('span');
          yearCountSpan.className = 'date-tree-count';
          yearCountSpan.textContent = `(${yearCount.toLocaleString('es-CO')})`;

          yearRow.appendChild(spacer);
          yearRow.appendChild(yearCb);
          yearRow.appendChild(yearLabelSpan);
          yearRow.appendChild(yearCountSpan);
          yearLi.appendChild(yearRow);
          yearList.appendChild(yearLi);
        }

        decadeLi.appendChild(yearList);

        decadeToggle.addEventListener('click', () => {
          const expanded = yearList.classList.contains('collapsed');
          yearList.classList.toggle('collapsed');
          decadeToggle.textContent = expanded ? '\u25BE' : '\u25B8';
        });

        decadeList.appendChild(decadeLi);
      }

      li.appendChild(decadeList);

      toggleBtn.addEventListener('click', () => {
        const expanded = decadeList.classList.contains('collapsed');
        decadeList.classList.toggle('collapsed');
        toggleBtn.textContent = expanded ? '\u25BE' : '\u25B8';
      });

      tree.appendChild(li);
    }

    content.appendChild(tree);
    group.appendChild(content);
    return group;
  }

  renderPills() {
    const hasFilters = this.state.q ||
      this.state.entity_type.length > 0 ||
      this.state.primary_function.length > 0 ||
      this.state.dateFilter !== null;

    if (!hasFilters) return null;

    const container = document.createElement('div');
    container.className = 'active-filters';

    // Query pill
    if (this.state.q) {
      container.appendChild(this.createPill(
        `\u201C${this.state.q}\u201D`,
        () => {
          this.state.q = '';
          this.state.page = 1;
          this.updateUrl();
          this.search();
        }
      ));
    }

    // Entity type pills
    for (const t of this.state.entity_type) {
      container.appendChild(this.createPill(
        this.entityTypeLabels[t] || t,
        () => this.handlePillRemove('entity_type', t)
      ));
    }

    // Primary function pills
    for (const f of this.state.primary_function) {
      container.appendChild(this.createPill(
        f,
        () => this.handlePillRemove('primary_function', f)
      ));
    }

    // Date filter pill
    if (this.state.dateFilter) {
      container.appendChild(this.createPill(
        this.state.dateFilter.label,
        () => {
          this.state.dateFilter = null;
          this.state.page = 1;
          this.updateUrl();
          this.search();
        }
      ));
    }

    // Clear all button
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'clear-filters-btn';
    clearBtn.textContent = 'Limpiar filtros';
    clearBtn.addEventListener('click', () => this.handleClearAll());
    container.appendChild(clearBtn);

    return container;
  }

  createPill(label, onRemove) {
    const pill = document.createElement('span');
    pill.className = 'filter-pill';

    const text = document.createElement('span');
    text.textContent = label;
    pill.appendChild(text);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'filter-pill-remove';
    removeBtn.innerHTML = '&times;';
    removeBtn.setAttribute('aria-label', `Eliminar filtro: ${label}`);
    removeBtn.addEventListener('click', onRemove);
    pill.appendChild(removeBtn);

    return pill;
  }

  renderPagination(data) {
    const nav = document.createElement('nav');
    nav.className = 'search-pagination';
    nav.setAttribute('aria-label', 'Paginacion');

    const currentPage = data.page;
    const totalPages = data.total_pages;

    if (currentPage > 1) {
      nav.appendChild(this.createPageLink('\u00AB', currentPage - 1));
    } else {
      nav.appendChild(this.createPageSpan('\u00AB', true));
    }

    const pages = this.getPageRange(currentPage, totalPages);
    for (const p of pages) {
      if (p === '...') {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'pagination-ellipsis';
        ellipsis.textContent = '...';
        nav.appendChild(ellipsis);
      } else if (p === currentPage) {
        nav.appendChild(this.createPageSpan(p, false, true));
      } else {
        nav.appendChild(this.createPageLink(p, p));
      }
    }

    if (currentPage < totalPages) {
      nav.appendChild(this.createPageLink('\u00BB', currentPage + 1));
    } else {
      nav.appendChild(this.createPageSpan('\u00BB', true));
    }

    return nav;
  }

  getPageRange(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = [1];
    if (current > 3) pages.push('...');
    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (current < total - 2) pages.push('...');
    pages.push(total);
    return pages;
  }

  createPageLink(label, page) {
    const a = document.createElement('a');
    a.className = 'pagination-link';
    a.href = '#';
    a.textContent = label;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      this.handlePageChange(page);
    });
    return a;
  }

  createPageSpan(label, disabled, active) {
    const span = document.createElement('span');
    span.className = 'pagination-link';
    if (disabled) span.classList.add('disabled');
    if (active) span.classList.add('active');
    span.textContent = label;
    return span;
  }

  renderNoResults() {
    const div = document.createElement('div');
    div.className = 'search-no-results';

    const msg = document.createElement('p');
    msg.textContent = 'No se encontraron entidades';
    div.appendChild(msg);

    const suggestion = document.createElement('p');
    suggestion.className = 'no-results-suggestion';
    suggestion.textContent = 'Intenta con otro termino o elimina algunos filtros.';
    div.appendChild(suggestion);

    return div;
  }

  // --- State displays ---

  showLoading() {
    const existingResults = this.container.querySelector('.search-results');
    if (existingResults) {
      existingResults.classList.add('results-loading');
      if (!existingResults.querySelector('.search-loading-overlay')) {
        const overlay = document.createElement('div');
        overlay.className = 'search-loading-overlay';
        overlay.innerHTML = '<div class="search-spinner" aria-busy="true"></div>';
        existingResults.appendChild(overlay);
      }
      return;
    }
    this.container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'search-loading';
    div.innerHTML = '<div class="search-spinner" aria-busy="true"></div>';
    this.container.appendChild(div);
  }

  showError() {
    this.container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'search-error';

    const msg = document.createElement('p');
    msg.textContent = 'No se pudo cargar el indice';
    div.appendChild(msg);

    const hint = document.createElement('p');
    hint.textContent = 'Recarga la pagina para intentarlo de nuevo.';
    div.appendChild(hint);

    const retry = document.createElement('a');
    retry.href = '#';
    retry.textContent = 'Recargar';
    retry.addEventListener('click', (e) => {
      e.preventDefault();
      window.location.reload();
    });
    div.appendChild(retry);

    this.container.appendChild(div);
  }

  // --- Event handlers ---

  handleFilterChange(stateKey, value, checked) {
    this.state[stateKey] = checked ? [value] : [];
    this.state.page = 1;
    this.updateUrl();
    this.search();
  }

  handlePillRemove(stateKey, value) {
    this.state[stateKey] = this.state[stateKey].filter(v => v !== value);
    this.state.page = 1;
    this.updateUrl();
    this.search();
  }

  handleDateSelect(filter) {
    this.state.dateFilter = filter;
    this.state.page = 1;
    this.updateUrl();
    this.search();
  }

  handleClearAll() {
    this.state.q = '';
    this.state.entity_type = [];
    this.state.primary_function = [];
    this.state.dateFilter = null;
    this.state.page = 1;
    this.updateUrl();
    this.search();
  }

  handlePageChange(page) {
    this.state.page = page;
    this.updateUrl();
    this.search();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // --- Utilities ---

  romanCentury(num) {
    const romans = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX',
      'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX',
      'XX', 'XXI', 'XXII'];
    return romans[num] || String(num);
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// EntityExplorer is instantiated and initialised by the wiring script in
// entidades.njk, which controls initialization order relative to the graph.
