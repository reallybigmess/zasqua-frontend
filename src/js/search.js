/**
 * Search Page
 *
 * Powers the `/buscar/` page — the faceted search interface over the whole
 * Zasqua catalogue. Because the site is statically hosted, the search runs
 * entirely in the visitor's browser using Pagefind, a static search library
 * that ships a pre-built index alongside the site and loads WebAssembly to
 * query it. No server is required.
 *
 * This module parses the URL query string to rebuild the active search state
 * (query text, text-filter chips with AND/NOT operators, country, repository,
 * level, digital status, date filter at year/decade/century granularity,
 * ancestor scope, parent reference code, linked entity authority codes,
 * linked place authority ids, sort, and page), sends a search to Pagefind,
 * and renders the results panel and facet sidebar. It also writes state
 * back to the URL with `history.pushState` so results are shareable and
 * the browser back button works as expected.
 *
 * The `entidad` and `lugar` filters narrow results to descriptions that
 * mention a specific entity or place — the description pages emit these
 * as Pagefind filter spans, and the entity and place explorers link into
 * the search page with these filters set so a visitor can go from an
 * authority record straight to the documents that reference it.
 *
 * Two performance safeguards live here — a "browse prompt" that skips the
 * expensive Pagefind scan when a filter-only query would return more than ten
 * thousand results, and a requestAnimationFrame nudge before each search so
 * the loading spinner paints before the WASM call blocks the main thread.
 * Level labels (fondo, serie, file, etc.) are passed in via a data attribute
 * on the container so the same script can honour English or Spanish builds.
 *
 * @version v0.5.0
 */

class SearchPage {
  constructor(container) {
    this.container = container;
    this.pagefind = null;
    this.perPage = 20;
    this.levelLabels = {};
    try {
      this.levelLabels = JSON.parse(container.dataset.levelLabels || '{}');
    } catch (e) {
      console.warn('Could not parse level labels');
    }

    // Build reverse map: display label → internal code (for levelLabels pill display)
    this.levelLabelToCode = {};
    for (const [code, label] of Object.entries(this.levelLabels)) {
      this.levelLabelToCode[label] = code;
    }

    this.state = {
      q: '',
      textFilters: [],
      country: [],       // display names (e.g. "Colombia", "Perú")
      repository: [],   // display names (Pagefind filters use display text)
      level: [],         // display labels (e.g. "Fondo", "Serie")
      digital_status: [],  // 'zasqua', 'external' (future), 'none'
      dateFilter: null,  // { level: 'century'|'decade'|'year', label, years: [...existing years only] }
      ancestor: [],
      parent: '',
      sort: '',
      page: 1,
      entidad: [],
      lugar: []
    };

    this.facetGroupState = { country: true, repository: true, digital_status: true, level: true, date: true };

    this.init();
  }

  async init() {
    this.parseUrlParams();

    try {
      this.pagefind = await import('/pagefind/pagefind.js');
      await this.pagefind.init();
      // Cache global filter counts (for landing page and year validation)
      this.globalFilters = await this.pagefind.filters();
    } catch (e) {
      console.error('Failed to load Pagefind:', e);
      this.showError();
      return;
    }

    window.addEventListener('popstate', () => {
      this.parseUrlParams();
      this.search();
    });

    this.search();
  }

  parseUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const qValues = params.getAll('q');
    this.state.q = qValues[0] || '';
    this.state.textFilters = qValues.slice(1).map(v => {
      if (v.startsWith('-')) {
        return { term: v.slice(1), op: 'NOT' };
      }
      return { term: v, op: 'AND' };
    });
    this.state.country = params.getAll('country');
    this.state.repository = params.getAll('repository');
    this.state.level = params.getAll('level');
    this.state.digital_status = params.getAll('digital_status');
    // Parse date filter from URL (only one active at a time): year=1750, decade=1550, century=16
    this.state.dateFilter = null;
    const urlYear = params.get('year');
    const urlDecade = params.get('decade');
    const urlCentury = params.get('century');
    if (urlYear) {
      this.state.dateFilter = { level: 'year', label: urlYear, years: [urlYear] };
    } else if (urlDecade) {
      const base = parseInt(urlDecade, 10);
      const years = [];
      for (let i = base; i < base + 10; i++) years.push(String(i));
      this.state.dateFilter = { level: 'decade', label: `${urlDecade}s`, years };
    } else if (urlCentury) {
      const num = parseInt(urlCentury, 10);
      const base = (num - 1) * 100;
      const years = [];
      for (let i = base; i < base + 100; i++) years.push(String(i));
      this.state.dateFilter = { level: 'century', label: `Siglo ${this.romanCentury(num)}`, years };
    }
    this.state.ancestor = params.getAll('ancestor');
    this.state.entidad = params.getAll('entidad');
    this.state.lugar = params.getAll('lugar');
    this.state.parent = params.get('parent') || '';
    this.state.sort = params.get('sort') || '';
    this.state.page = parseInt(params.get('page'), 10) || 1;
  }

  updateUrl() {
    const params = new URLSearchParams();
    if (this.state.q) params.append('q', this.state.q);
    for (const f of this.state.textFilters) {
      params.append('q', f.op === 'NOT' ? `-${f.term}` : f.term);
    }
    for (const c of this.state.country) {
      params.append('country', c);
    }
    for (const repo of this.state.repository) {
      params.append('repository', repo);
    }
    for (const level of this.state.level) {
      params.append('level', level);
    }
    for (const ds of this.state.digital_status) {
      params.append('digital_status', ds);
    }
    if (this.state.dateFilter) {
      const df = this.state.dateFilter;
      if (df.level === 'year') params.set('year', df.years[0]);
      else if (df.level === 'decade') params.set('decade', df.years[0]);
      else if (df.level === 'century') {
        const firstYear = parseInt(df.years[0], 10);
        params.set('century', String(Math.floor(firstYear / 100) + 1));
      }
    }
    for (const a of this.state.ancestor) {
      params.append('ancestor', a);
    }
    for (const e of this.state.entidad) params.append('entidad', e);
    for (const l of this.state.lugar) params.append('lugar', l);
    if (this.state.parent) params.set('parent', this.state.parent);
    if (this.state.sort) params.set('sort', this.state.sort);
    if (this.state.page > 1) params.set('page', this.state.page);

    const qs = params.toString();
    const url = qs ? `/buscar/?${qs}` : '/buscar/';
    history.pushState(null, '', url);
  }

  async search() {
    if (!this.pagefind) return;

    // Build combined query from main query + AND text filters
    const andTerms = this.state.textFilters.filter(f => f.op === 'AND').map(f => f.term);
    const combinedQuery = [this.state.q, ...andTerms].filter(Boolean).join(' ');

    // Check if any filters are active
    const hasActiveFilters = this.state.country.length > 0 ||
      this.state.repository.length > 0 ||
      this.state.level.length > 0 ||
      this.state.digital_status.length > 0 ||
      this.state.dateFilter !== null ||
      this.state.ancestor.length > 0 ||
      this.state.parent ||
      this.state.textFilters.some(f => f.op === 'NOT');

    const isLanding = !combinedQuery && !hasActiveFilters;

    this.showLoading();
    // Force browser to paint the spinner before Pagefind's WASM blocks the main thread
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      if (isLanding) {
        // No query, no filters — show sidebar with global counts
        const data = {
          hits: [],
          filters: this.globalFilters,
          total: 0,
          page: 1,
          total_pages: 0,
          query: '',
          landing: true
        };
        this.renderSearchResults(data);
        return;
      }

      // Resolve dateFilter years against actual index data
      // (URL-loaded filters may contain years that don't exist in the index)
      if (this.state.dateFilter && this.globalFilters.year) {
        const indexYears = new Set(Object.keys(this.globalFilters.year));
        this.state.dateFilter.years = this.state.dateFilter.years.filter(y => indexYears.has(y));
      }

      // Option D: For filter-only queries with large expected result sets,
      // skip the expensive Pagefind WASM scan and show a browse prompt instead.
      // Text searches are always fast (word index narrows candidates); only
      // filter-only queries over large sets are slow (~5s for 55K results).
      if (!combinedQuery && hasActiveFilters && !this.skipBrowsePrompt) {
        const estimated = this.estimateFilterCount();
        if (estimated > 10000) {
          const data = {
            hits: [],
            filters: this.globalFilters,
            total: estimated,
            page: 1,
            total_pages: 0,
            query: '',
            browsePrompt: true
          };
          this.renderSearchResults(data);
          return;
        }
      }

      // Reset the override so future filter changes re-evaluate the threshold
      this.skipBrowsePrompt = false;

      // Build Pagefind filters
      // Note: Pagefind arrays are AND (all must match). Use { any: [...] }
      // for OR (match any). Single values work either way.
      const pfFilters = {};
      if (this.state.country.length) pfFilters.country = { any: this.state.country };
      if (this.state.repository.length) pfFilters.repository = { any: this.state.repository };
      if (this.state.level.length) pfFilters.level = { any: this.state.level };
      if (this.state.digital_status.length) pfFilters.digital_status = { any: this.state.digital_status };
      if (this.state.dateFilter && this.state.dateFilter.years.length) {
        pfFilters.year = { any: this.state.dateFilter.years };
      }
      if (this.state.ancestor.length) pfFilters.ancestor = { any: this.state.ancestor };
      if (this.state.entidad.length) pfFilters.entidad = { any: this.state.entidad };
      if (this.state.lugar.length) pfFilters.lugar = { any: this.state.lugar };
      if (this.state.parent) {
        pfFilters.parent_reference_code = this.state.parent;
      }

      // Build Pagefind sort
      const pfSort = {};
      if (this.state.sort) {
        const [field, dir] = this.state.sort.split(':');
        // Map our sort field names to Pagefind attribute names
        const pfField = field === 'date_start_year' ? 'date' : field;
        pfSort[pfField] = dir;
      }

      // Pass null when no query text (filter-only search)
      const search = await this.pagefind.search(combinedQuery || null, {
        filters: Object.keys(pfFilters).length ? pfFilters : undefined,
        sort: Object.keys(pfSort).length ? pfSort : undefined
      });

      // Lazy-load the current page of results
      const total = search.results.length;
      const totalPages = Math.ceil(total / this.perPage);
      const start = (this.state.page - 1) * this.perPage;
      const pageResults = search.results.slice(start, start + this.perPage);
      const hits = await Promise.all(pageResults.map(r => r.data()));

      // Use scoped filter counts from the search result
      // search.filters: counts if each value were added to current filters
      // (cross-facet values show the right breakdown; same-facet inactive values show 0)
      const scopedFilters = search.filters || this.globalFilters;

      // Normalise into the shape renderSearchResults expects
      const data = {
        hits,
        filters: scopedFilters,
        total,
        page: this.state.page,
        total_pages: totalPages,
        query: combinedQuery
      };

      this.renderSearchResults(data);
    } catch (error) {
      console.error('Search error:', error);
      this.showError();
    }
  }

  // --- Rendering ---

  renderSearchResults(data) {
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
    mobileToggle.innerHTML = 'Filtros <span class="toggle-chevron">&#9660;</span>';
    mobileToggle.addEventListener('click', () => {
      const sidebar = this.container.querySelector('.search-sidebar');
      if (sidebar) {
        sidebar.classList.toggle('sidebar-open');
        mobileToggle.classList.toggle('toggle-open');
      }
    });
    resultsCol.appendChild(mobileToggle);

    // Landing state: show search prompt in results column
    if (data.landing) {
      const landing = document.createElement('div');
      landing.className = 'search-empty-query';

      const logo = document.createElement('img');
      logo.src = '/img/zasqua-3-burgundy-sm.svg';
      logo.alt = 'Zasqua';
      logo.className = 'search-landing-logo';
      landing.appendChild(logo);

      const hints = document.createElement('div');
      hints.className = 'search-landing-hints';
      hints.innerHTML =
        '<p>Zasqua tiene un sistema de b\u00FAsqueda flexible a partir de filtros: escribe un t\u00E9rmino o selecciona un filtro en el panel de filtros para comenzar a explorar el cat\u00E1logo. Luego agrega m\u00E1s hasta encontrar lo que buscas. El sistema ignorar\u00E1 tildes y diacr\u00EDticos, y aproximar\u00E1 t\u00E9rminos cercanos con la misma ra\u00EDz.</p>' +
        '<p>Agrega t\u00E9rminos escribi\u00E9ndolos en el panel de filtros \u2014 selecciona <em>s\u00ED</em> o <em>no</em> para incluir o excluir, y presiona <em>+</em> o Enter. Cada t\u00E9rmino o filtro aparecer\u00E1 como una etiqueta que puedes eliminar y reemplazar con facilidad, as\u00ED que si\u00E9ntete libre de experimentar.</p>';
      landing.appendChild(hints);

      resultsCol.appendChild(landing);

      // Sidebar + results
      const sidebar = this.renderFacets(data);
      layout.appendChild(sidebar);
      layout.appendChild(resultsCol);
      this.container.appendChild(layout);
      return;
    }

    // Browse prompt: filter-only query with too many results for Pagefind
    if (data.browsePrompt) {
      const pills = this.renderPills();
      if (pills) resultsCol.appendChild(pills);

      const prompt = document.createElement('div');
      prompt.className = 'search-browse-prompt';

      const countText = document.createElement('p');
      countText.className = 'browse-prompt-count';
      countText.innerHTML = `<strong>${data.total.toLocaleString('es-CO')}</strong> registros coinciden con estos filtros.`;
      prompt.appendChild(countText);

      const hint = document.createElement('p');
      hint.className = 'browse-prompt-hint';
      hint.textContent = 'Agrega m\u00E1s t\u00E9rminos o filtros para acotar los resultados, o presiona:';
      prompt.appendChild(hint);

      const continueBtn = document.createElement('button');
      continueBtn.type = 'button';
      continueBtn.className = 'browse-prompt-btn';
      continueBtn.textContent = 'Ver todos';
      continueBtn.addEventListener('click', () => {
        this.skipBrowsePrompt = true;
        this.search();
      });
      prompt.appendChild(continueBtn);

      const warning = document.createElement('p');
      warning.className = 'browse-prompt-warning';
      warning.textContent = 'Tomar\u00E1 algunos segundos en cargar.';
      prompt.appendChild(warning);

      resultsCol.appendChild(prompt);

      const sidebar = this.renderFacets(data);
      layout.appendChild(sidebar);
      layout.appendChild(resultsCol);
      this.container.appendChild(layout);
      return;
    }

    // Results info bar
    resultsCol.appendChild(this.renderResultsInfo(data));

    // Active filter pills
    const pills = this.renderPills();
    if (pills) resultsCol.appendChild(pills);

    // Result items
    if (data.hits.length === 0) {
      resultsCol.appendChild(this.renderNoResults());
    } else {
      const resultsList = document.createElement('div');
      resultsList.className = 'search-results-list';
      const notTerms = this.state.textFilters
        .filter(f => f.op === 'NOT')
        .map(f => f.term.toLowerCase());
      for (const hit of data.hits) {
        const card = this.renderResultCard(hit, data.query);
        if (notTerms.length > 0) {
          const text = card.textContent.toLowerCase();
          if (notTerms.some(t => text.includes(t))) {
            card.style.display = 'none';
          }
        }
        resultsList.appendChild(card);
      }
      resultsCol.appendChild(resultsList);
    }

    // Pagination
    if (data.total_pages > 1) {
      resultsCol.appendChild(this.renderPagination(data));
    }

    // Sidebar
    const sidebar = this.renderFacets(data);
    layout.appendChild(sidebar);

    layout.appendChild(resultsCol);

    this.container.appendChild(layout);
  }

  renderResultsInfo(data) {
    const info = document.createElement('div');
    info.className = 'results-info search-results-info';

    const count = document.createElement('span');
    count.className = 'results-count';
    count.textContent = data.total.toLocaleString('es-CO') + ' resultados';
    info.appendChild(count);

    // Sort buttons
    const sortWrap = document.createElement('div');
    sortWrap.className = 'sort-wrap';

    const sortLabel = document.createElement('span');
    sortLabel.className = 'sort-label';
    sortLabel.textContent = 'Ordenar por:';
    sortWrap.appendChild(sortLabel);

    const sortOptions = [
      { field: 'date_start_year', label: 'Fecha' },
      { field: 'title', label: 'Título' },
      { field: 'reference_code', label: 'Código' },
      { field: '', label: 'Relevancia' }
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

      const currentField = this.state.sort ? this.state.sort.split(':')[0] : '';
      const currentDir = this.state.sort ? this.state.sort.split(':')[1] : '';
      const isActive = opt.field === '' ? !this.state.sort : currentField === opt.field;

      if (isActive) btn.classList.add('active');

      btn.textContent = opt.label;

      if (opt.field) {
        const arrow = document.createElement('span');
        arrow.className = 'sort-arrow';
        if (isActive) {
          arrow.textContent = currentDir === 'desc' ? ' \u2193' : ' \u2191';
        } else {
          arrow.textContent = ' \u2191';
        }
        btn.appendChild(arrow);
      }

      btn.addEventListener('click', () => {
        if (opt.field === '') {
          this.handleSort('');
        } else if (isActive) {
          const newDir = currentDir === 'asc' ? 'desc' : 'asc';
          this.handleSort(`${opt.field}:${newDir}`);
        } else {
          this.handleSort(`${opt.field}:asc`);
        }
      });

      sortWrap.appendChild(btn);
    });

    info.appendChild(sortWrap);

    return info;
  }

  renderRefineInput() {
    const wrap = document.createElement('div');
    wrap.className = 'refine-search';

    let currentOp = 'AND';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'B\u00FAsqueda...';

    const addTerm = () => {
      const term = input.value.trim();
      if (!term) return;
      const exists = this.state.textFilters.some(f => f.term === term && f.op === currentOp);
      if (!exists) {
        this.state.textFilters.push({ term, op: currentOp });
        this.state.page = 1;
        input.value = '';
        this.updateUrl();
        this.search();
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTerm();
      }
    });
    wrap.appendChild(input);

    // Divider
    const divider = document.createElement('span');
    divider.className = 'refine-divider';
    wrap.appendChild(divider);

    // Operator selector
    const opWrap = document.createElement('div');
    opWrap.className = 'refine-op';

    const opBtn = document.createElement('button');
    opBtn.type = 'button';
    opBtn.className = 'refine-op-btn';
    opBtn.innerHTML = 'S\u00ED <span class="refine-op-caret">\u25BE</span>';

    const opMenu = document.createElement('div');
    opMenu.className = 'refine-op-menu';
    opMenu.style.display = 'none';

    const options = [
      { value: 'AND', label: 'S\u00ED' },
      { value: 'NOT', label: 'No' }
    ];
    for (const opt of options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'refine-op-option';
      item.textContent = opt.label;
      item.addEventListener('click', () => {
        currentOp = opt.value;
        opBtn.innerHTML = `${opt.label} <span class="refine-op-caret">\u25BE</span>`;
        opMenu.style.display = 'none';
      });
      opMenu.appendChild(item);
    }

    opBtn.addEventListener('click', () => {
      opMenu.style.display = opMenu.style.display === 'none' ? '' : 'none';
    });

    document.addEventListener('click', (e) => {
      if (!opWrap.contains(e.target)) {
        opMenu.style.display = 'none';
      }
    });

    opWrap.appendChild(opBtn);
    opWrap.appendChild(opMenu);
    wrap.appendChild(opWrap);

    // Divider
    const divider2 = document.createElement('span');
    divider2.className = 'refine-divider';
    wrap.appendChild(divider2);

    // Add button
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'refine-add-btn';
    addBtn.innerHTML = '+';
    addBtn.setAttribute('aria-label', 'Agregar filtro de texto');
    addBtn.addEventListener('click', addTerm);
    wrap.appendChild(addBtn);

    return wrap;
  }

  renderResultCard(hit, query) {
    const item = document.createElement('div');
    item.className = 'result-item';

    // Title — Pagefind auto-captures from h1 as hit.meta.title
    const title = document.createElement('h3');
    title.className = 'result-title';
    const link = document.createElement('a');
    link.href = hit.url;
    link.innerHTML = this.highlightTerms(this.escapeHtml(hit.meta.title || ''), query);
    title.appendChild(link);
    item.appendChild(title);

    // Meta line: level badge + reference code + date
    const meta = document.createElement('div');
    meta.className = 'result-meta';

    const descLevel = hit.meta.description_level || '';
    const levelLabel = this.levelLabels[descLevel] || descLevel;
    const badge = document.createElement('span');
    badge.className = 'level-badge';
    badge.textContent = levelLabel;
    meta.appendChild(badge);

    if (hit.meta.reference_code) {
      const sep1 = document.createTextNode(' \u00B7 ');
      meta.appendChild(sep1);
      const refCode = document.createElement('span');
      refCode.textContent = hit.meta.reference_code;
      meta.appendChild(refCode);
    }

    if (hit.meta.date_expression) {
      const sep2 = document.createTextNode(' \u00B7 ');
      meta.appendChild(sep2);
      const date = document.createElement('span');
      date.textContent = hit.meta.date_expression;
      meta.appendChild(date);
    }

    item.appendChild(meta);

    // Snippet — Pagefind provides highlighted excerpt
    if (hit.excerpt) {
      const snippet = document.createElement('div');
      snippet.className = 'result-snippet';
      snippet.innerHTML = this.truncateHtml(hit.excerpt, 200);
      item.appendChild(snippet);
    }

    // Repository name
    if (hit.meta.repository_name) {
      const repo = document.createElement('div');
      repo.className = 'result-repo';
      repo.textContent = hit.meta.repository_name;
      item.appendChild(repo);
    }

    return item;
  }

  renderFacets(data) {
    const sidebar = document.createElement('aside');
    sidebar.className = 'search-sidebar';

    // Mobile filter panel header (hidden on desktop via CSS)
    const panelHeader = document.createElement('div');
    panelHeader.className = 'filter-panel-header';
    panelHeader.innerHTML =
      '<span class="filter-panel-title">Filtrar por:</span>' +
      '<button class="filter-panel-close" type="button" aria-label="Cerrar filtros">' +
      '<span class="material-symbols-outlined">close</span></button>';
    sidebar.appendChild(panelHeader);

    // Heading (visible on desktop, hidden on mobile when panel is open)
    const heading = document.createElement('h3');
    heading.className = 'search-sidebar-heading';
    heading.textContent = 'Filtrar por:';
    sidebar.appendChild(heading);

    // Refine search input
    sidebar.appendChild(this.renderRefineInput());

    const filters = data.filters || {};

    // Country facet
    if (filters.country) {
      sidebar.appendChild(this.renderFacetGroup(
        'País',
        'country',
        filters.country,
        this.state.country,
        (name) => name
      ));
    }

    // Repository facet — keyed by display name, no mapping needed
    if (filters.repository) {
      sidebar.appendChild(this.renderFacetGroup(
        'Repositorio',
        'repository',
        filters.repository,
        this.state.repository,
        (name) => name  // already display names
      ));
    }

    // Digital status facet
    if (filters.digital_status) {
      const digitalLabels = {
        'zasqua': 'Sí, disponibles en Zasqua',
        'external': 'Sí, en repositorio externo',
        'none': 'No, sin digitalizar'
      };
      const digitalOrder = ['zasqua', 'external', 'none'];
      const digitalSort = (a, b) => {
        const ai = digitalOrder.indexOf(a[0]);
        const bi = digitalOrder.indexOf(b[0]);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return b[1] - a[1];
      };
      sidebar.appendChild(this.renderFacetGroup(
        'Imágenes disponibles',
        'digital_status',
        filters.digital_status,
        this.state.digital_status,
        (value) => digitalLabels[value] || value,
        digitalSort
      ));
    }

    // Level facet — keyed by display label, sorted by archival hierarchy
    if (filters.level) {
      const levelOrder = ['Fondo', 'Subfondo', 'Colección', 'Sección', 'Serie', 'Subserie', 'Expediente', 'Tomo', 'Unidad documental'];
      const levelSort = (a, b) => {
        const ai = levelOrder.indexOf(a[0]);
        const bi = levelOrder.indexOf(b[0]);
        // Known levels first in hierarchy order, unknown levels last by count
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return b[1] - a[1];
      };
      sidebar.appendChild(this.renderFacetGroup(
        'Nivel de descripción',
        'level',
        filters.level,
        this.state.level,
        (label) => label,
        levelSort
      ));
    }

    // Date tree (century → decade → year) — only show if any years have results
    if (filters.year && Object.values(filters.year).some(c => c > 0)) {
      sidebar.appendChild(this.renderDateTree(filters.year));
    }

    // Mobile filter panel bottom close (hidden on desktop via CSS)
    const panelBottom = document.createElement('div');
    panelBottom.className = 'filter-panel-bottom-close';
    panelBottom.innerHTML =
      '<button type="button">' +
      '<span class="material-symbols-outlined">expand_less</span> Cerrar filtros</button>';
    sidebar.appendChild(panelBottom);

    // Wire up panel close handlers
    const closePanel = () => {
      sidebar.classList.remove('sidebar-open');
      const toggle = this.container.querySelector('.mobile-filter-toggle');
      if (toggle) toggle.classList.remove('toggle-open');
    };
    panelHeader.querySelector('.filter-panel-close').addEventListener('click', closePanel);
    panelBottom.querySelector('button').addEventListener('click', closePanel);

    return sidebar;
  }

  renderFacetGroup(title, stateKey, facetData, activeValues, labelFn, sortFn) {
    const group = document.createElement('div');
    group.className = 'facet-group';

    const isOpen = this.facetGroupState[stateKey] !== false;

    // Toggle button
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

    // Content
    const content = document.createElement('div');
    content.className = 'facet-group-content';
    content.style.display = isOpen ? '' : 'none';

    // Sort facet entries: active first, then custom sort or count descending
    const entries = Object.entries(facetData).sort((a, b) => {
      const aActive = activeValues.includes(a[0]) ? 1 : 0;
      const bActive = activeValues.includes(b[0]) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      if (sortFn) return sortFn(a, b);
      return b[1] - a[1];
    });

    // Exclusive drill-down: when a value is selected, hide the rest
    const hasActive = activeValues.length > 0;

    for (const [value, count] of entries) {
      if (hasActive && !activeValues.includes(value)) continue;
      // Hide values with zero results (unless currently active)
      if (count === 0 && !activeValues.includes(value)) continue;
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
    }

    group.appendChild(content);
    return group;
  }

  renderDateTree(yearData) {
    const group = document.createElement('div');
    group.className = 'facet-group';

    const isOpen = this.facetGroupState.date !== false;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'facet-group-toggle';
    toggle.innerHTML = '<span class="facet-group-title">Fecha (inicial)</span><span class="facet-group-indicator">' + (isOpen ? '\u2212' : '+') + '</span>';
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

    // Build hierarchy from flat year data: { "1622": 1, "1750": 45, ... }
    const centuries = new Map();

    for (const [yearStr, count] of Object.entries(yearData)) {
      const year = parseInt(yearStr, 10);
      if (isNaN(year)) continue;
      if (count === 0) continue;  // Hide years with zero results
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

      // Drill-down: if a century is selected, only show that century
      if (df && df.level === 'century' && df.label !== centuryLabel) continue;
      if (df && (df.level === 'decade' || df.level === 'year')) {
        // Check if this century contains the selected decade/year
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
      // Auto-expand when selected or when a child is selected
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
      countSpan.textContent = `(${centuryData.total.toLocaleString('es-CO')})`;

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

        // Drill-down: if a decade is selected, only show that decade
        if (df && df.level === 'decade' && df.label !== decadeLabel) continue;
        if (df && df.level === 'year') {
          const selectedDecade = Math.floor(parseInt(df.years[0], 10) / 10) * 10;
          if (selectedDecade !== decadeBase) continue;
        }

        let decadeTotal = 0;
        for (const c of yearsMap.values()) decadeTotal += c;

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
          // Drill-down: if a year is selected, only show that year
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

  handleDateSelect(filter) {
    this.state.dateFilter = filter;
    this.state.page = 1;
    this.updateUrl();
    this.search();
  }

  romanCentury(num) {
    const romans = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX',
      'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX',
      'XX', 'XXI', 'XXII'];
    return romans[num] || String(num);
  }

  renderPills() {
    const hasFilters = this.state.q ||
      this.state.textFilters.length > 0 ||
      this.state.country.length > 0 ||
      this.state.repository.length > 0 ||
      this.state.level.length > 0 ||
      this.state.digital_status.length > 0 ||
      this.state.dateFilter !== null ||
      this.state.ancestor.length > 0 ||
      this.state.parent;

    if (!hasFilters) return null;

    const container = document.createElement('div');
    container.className = 'active-filters';

    // Main query pill
    if (this.state.q) {
      container.appendChild(this.createPill(
        `\u201C${this.state.q}\u201D`,
        () => {
          // Promote the first AND text filter to main query, if any
          const nextAnd = this.state.textFilters.find(f => f.op === 'AND');
          if (nextAnd) {
            this.state.q = nextAnd.term;
            this.state.textFilters = this.state.textFilters.filter(t => t !== nextAnd);
          } else {
            this.state.q = '';
          }
          this.state.page = 1;
          this.updateUrl();
          this.search();
        }
      ));
    }

    // Text filter chips
    for (const f of this.state.textFilters) {
      const prefix = f.op === 'NOT' ? 'No: ' : '';
      container.appendChild(this.createPill(
        `${prefix}\u201C${f.term}\u201D`,
        () => {
          this.state.textFilters = this.state.textFilters.filter(t => t !== f);
          this.state.page = 1;
          this.updateUrl();
          this.search();
        }
      ));
    }

    // Country pills
    for (const c of this.state.country) {
      container.appendChild(this.createPill(
        c,
        () => this.handlePillRemove('country', c)
      ));
    }

    // Repository pills — display names directly
    for (const repo of this.state.repository) {
      container.appendChild(this.createPill(
        repo,
        () => this.handlePillRemove('repository', repo)
      ));
    }

    // Level pills — display labels directly
    for (const level of this.state.level) {
      container.appendChild(this.createPill(
        level,
        () => this.handlePillRemove('level', level)
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

    // Ancestor filter pills
    for (const a of this.state.ancestor) {
      container.appendChild(this.createPill(
        a,
        () => this.handlePillRemove('ancestor', a)
      ));
    }

    // Parent filter pill
    if (this.state.parent) {
      container.appendChild(this.createPill(
        this.state.parent,
        () => {
          this.state.parent = '';
          this.state.page = 1;
          this.updateUrl();
          this.search();
        }
      ));
    }

    // Digital status pills
    const digitalPillLabels = {
      'zasqua': 'Disponibles en Zasqua',
      'external': 'Repositorio externo',
      'none': 'Sin digitalizar'
    };
    for (const ds of this.state.digital_status) {
      container.appendChild(this.createPill(
        digitalPillLabels[ds] || ds,
        () => this.handlePillRemove('digital_status', ds)
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
    nav.setAttribute('aria-label', 'Paginación');

    const currentPage = data.page;
    const totalPages = data.total_pages;

    // Previous
    if (currentPage > 1) {
      nav.appendChild(this.createPageLink('\u00AB', currentPage - 1));
    } else {
      nav.appendChild(this.createPageSpan('\u00AB', true));
    }

    // Page numbers with ellipsis
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

    // Next
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

    const pages = [];
    pages.push(1);

    if (current > 3) {
      pages.push('...');
    }

    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    if (current < total - 2) {
      pages.push('...');
    }

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
    msg.textContent = 'No se encontraron resultados';
    div.appendChild(msg);

    const hasFilters = this.state.country.length > 0 ||
      this.state.repository.length > 0 ||
      this.state.level.length > 0 ||
      this.state.digital_status.length > 0;

    if (hasFilters) {
      const suggestion = document.createElement('p');
      suggestion.className = 'no-results-suggestion';
      suggestion.textContent = 'Intenta limpiar los filtros o modificar la consulta.';
      div.appendChild(suggestion);

      const clearLink = document.createElement('a');
      clearLink.href = '#';
      clearLink.textContent = 'Limpiar filtros';
      clearLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleClearAll();
      });
      div.appendChild(clearLink);
    }

    return div;
  }

  // --- State displays ---

  showLoading() {
    // If results already rendered, overlay a loading state without wiping the layout
    const existingResults = this.container.querySelector('.search-results');
    if (existingResults) {
      existingResults.classList.add('results-loading');
      // Add or reuse a spinner overlay
      if (!existingResults.querySelector('.search-loading-overlay')) {
        const overlay = document.createElement('div');
        overlay.className = 'search-loading-overlay';
        overlay.innerHTML = '<div class="search-spinner" aria-busy="true"></div>';
        existingResults.appendChild(overlay);
      }
      return;
    }
    // First load: show centered spinner
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
    msg.textContent = 'Ha ocurrido un error';
    div.appendChild(msg);

    const retry = document.createElement('a');
    retry.href = '#';
    retry.textContent = 'Intentar de nuevo';
    retry.addEventListener('click', (e) => {
      e.preventDefault();
      this.search();
    });
    div.appendChild(retry);

    this.container.appendChild(div);
  }




  // --- Event handlers ---

  handleFilterChange(stateKey, value, checked) {
    // Exclusive drill-down: selecting a value hides all others
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

  handleClearAll() {
    this.state.textFilters = [];
    this.state.country = [];
    this.state.repository = [];
    this.state.level = [];
    this.state.digital_status = [];
    this.state.dateFilter = null;
    this.state.ancestor = [];
    this.state.parent = '';
    this.state.page = 1;
    this.updateUrl();
    this.search();
  }

  handleSort(value) {
    this.state.sort = value;
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

  /**
   * Estimate the result count for the current filters using global filter counts.
   * Takes the minimum sum across active filter dimensions (conservative estimate,
   * since filters are AND'd across facets).
   */
  estimateFilterCount() {
    const counts = [];

    if (this.state.country.length && this.globalFilters.country) {
      let sum = 0;
      for (const name of this.state.country) {
        sum += this.globalFilters.country[name] || 0;
      }
      counts.push(sum);
    }

    if (this.state.repository.length && this.globalFilters.repository) {
      let sum = 0;
      for (const name of this.state.repository) {
        sum += this.globalFilters.repository[name] || 0;
      }
      counts.push(sum);
    }

    if (this.state.level.length && this.globalFilters.level) {
      let sum = 0;
      for (const name of this.state.level) {
        sum += this.globalFilters.level[name] || 0;
      }
      counts.push(sum);
    }

    if (this.state.digital_status.length && this.globalFilters.digital_status) {
      let sum = 0;
      for (const val of this.state.digital_status) {
        sum += this.globalFilters.digital_status[val] || 0;
      }
      counts.push(sum);
    }

    if (this.state.dateFilter && this.state.dateFilter.years.length && this.globalFilters.year) {
      let sum = 0;
      for (const y of this.state.dateFilter.years) {
        sum += this.globalFilters.year[y] || 0;
      }
      counts.push(sum);
    }

    if (this.state.ancestor.length && this.globalFilters.ancestor) {
      let sum = 0;
      for (const a of this.state.ancestor) {
        sum += this.globalFilters.ancestor[a] || 0;
      }
      counts.push(sum);
    }

    return counts.length ? Math.min(...counts) : 0;
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Highlight query terms in text with <mark> tags.
   * Accent-insensitive: "Garcia" highlights "García".
   */
  highlightTerms(html, query) {
    if (!query) return html;

    const terms = query.split(/\s+/).filter(t => t.length > 0);
    if (terms.length === 0) return html;

    // Normalise for accent-insensitive comparison
    const normalize = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    let result = html;
    for (const term of terms) {
      const normalizedTerm = normalize(term);
      // Build a regex that matches each character with optional diacritics
      const pattern = normalizedTerm.split('').map(ch => {
        const escaped = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return escaped + '[\u0300-\u036f]*';
      }).join('');

      try {
        const regex = new RegExp(`(${pattern})`, 'gi');
        // Only match outside existing tags
        result = result.replace(/(<[^>]*>)|([^<]+)/g, (match, tag, text) => {
          if (tag) return tag;
          return text.replace(regex, '<mark>$1</mark>');
        });
      } catch (e) {
        // If regex fails, skip this term
      }
    }

    return result;
  }

  truncateHtml(html, maxLength) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const text = tmp.textContent || '';

    if (text.length <= maxLength) return html;

    let charCount = 0;
    let result = '';
    let inTag = false;
    let tagBuffer = '';

    for (let i = 0; i < html.length; i++) {
      const ch = html[i];

      if (ch === '<') {
        inTag = true;
        tagBuffer = '<';
        continue;
      }

      if (inTag) {
        tagBuffer += ch;
        if (ch === '>') {
          inTag = false;
          result += tagBuffer;
          tagBuffer = '';
        }
        continue;
      }

      charCount++;
      result += ch;

      if (charCount >= maxLength) {
        result += '...';
        break;
      }
    }

    // Close any unclosed <mark> tags
    const openMarks = (result.match(/<mark>/gi) || []).length;
    const closeMarks = (result.match(/<\/mark>/gi) || []).length;
    for (let i = 0; i < openMarks - closeMarks; i++) {
      result += '</mark>';
    }

    return result;
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('search-page');
  if (container) {
    new SearchPage(container);
  }
});
