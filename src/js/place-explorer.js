/**
 * Place Explorer
 *
 * Powers the `/lugares/` page — a map-centric interface for browsing
 * the ~7,000 geographic entities named across the Zasqua catalogue.
 * The explorer has two linked surfaces: a MapLibre GL map with a
 * Protomaps terrain basemap and clustered burgundy markers, and a
 * Pagefind-backed list of places with facets and pagination. The two
 * stay in sync — selecting a place on either surface highlights it on
 * the other, and a viewport toggle restricts the list to places
 * currently visible on the map.
 *
 * The template (`lugares.njk`) lays out the explorer grid and leaves
 * the interactive slots empty. This class populates them:
 *   - `#place-search-input`       → search input
 *   - `#sidebar-facets`           → place type, coordinate availability,
 *                                   external authority facets
 *   - `#place-explorer`           → results header, paginated list,
 *                                   active-filter pills, sort toggle
 *   - `#selected-place-card`      → sticky selected-place card
 *   - `#viewport-filter-toggle`   → map-bound filter toggle
 *   - `#explorer-map`             → the MapLibre canvas itself
 *
 * Map coordinates come from `/data/place-index.json` — a trimmed
 * index produced at build time by `scripts/precompute-links.js`.
 * Search results come from the dedicated `/pagefind-places/` index.
 * A generation counter guards against stale in-flight searches so
 * rapid filter clicks don't cause checkboxes to revert.
 *
 * @version v0.5.0
 */

class PlaceExplorer {
  constructor(container) {
    this.container = container;
    this.allPlaces = [];      // Loaded from place-index.json — map coordinates only
    this.pagefind = null;
    this.globalFilters = {};
    this.lastSearch = null;   // Cached last Pagefind search result (for viewport re-filter)
    this.map = null;
    this.mapReady = false;
    this.perPage = 20;
    this._debounce = null;
    this._onMoveEnd = null;
    this._searchGen = 0;

    this.placeTypes = {};
    try {
      this.placeTypes = JSON.parse(container.dataset.placeTypes || '{}');
    } catch (e) {
      console.warn('PlaceExplorer: could not parse data-place-types');
    }

    this.protomapsKey = container.dataset.protomapsKey || '';

    this.state = {
      q: '',
      type: [],
      hasCoords: null,
      hasAuthority: null,
      sort: 'name',
      page: 1,
      mapBound: false
    };

    this.facetGroupState = { type: true, coords: true, authority: true };

    this.init();
  }

  async init() {
    this.parseUrlParams();
    this.showLoadingOverlay();

    try {
      // Load Pagefind and place-index.json in parallel
      const pagefindInit = (async () => {
        this.pagefind = await import('/pagefind-places/pagefind.js');
        await this.pagefind.options({ basePath: '/pagefind-places/' });
        await this.pagefind.init();
        this.globalFilters = await this.pagefind.filters();
      })();

      const jsonLoad = (async () => {
        const response = await fetch('/data/place-index.json');
        if (!response.ok) throw new Error('HTTP ' + response.status);
        this.allPlaces = await response.json();
      })();

      await Promise.all([pagefindInit, jsonLoad]);
    } catch (e) {
      this.hideLoadingOverlay();
      this.showError();
      return;
    }

    this.hideLoadingOverlay();
    this.buildDOM();
    this.initMap();
    this.initExampleButtons();
    this.initViewportFilter();

    // Update place count live from Pagefind index
    var countEl = document.getElementById('place-count-live');
    if (countEl) {
      try {
        var allPlaces = await this.pagefind.search(null, {});
        var n = allPlaces.results.length;
        if (n > 0) countEl.textContent = n.toLocaleString('es-CO');
      } catch (e) {
        // keep static count from template
      }
    }

    window.addEventListener('popstate', () => {
      this.parseUrlParams();
      this.syncFormToState();
      this.search();
    });
  }

  showLoadingOverlay() {
    var overlay = document.createElement('div');
    overlay.className = 'search-loading search-loading-overlay';
    overlay.id = 'place-explorer-loading';
    overlay.innerHTML = '<p>Cargando lugares\u2026</p>';
    this.container.appendChild(overlay);
  }

  hideLoadingOverlay() {
    var overlay = document.getElementById('place-explorer-loading');
    if (overlay) overlay.remove();
  }

  showError() {
    this.container.innerHTML =
      '<div class="search-no-results">' +
      '<p style="font-size:1.1rem;font-weight:500;color:var(--color-stone-600)">No se pudo cargar el \u00edndice de lugares.</p>' +
      '<p style="color:var(--color-stone-400)">Comprueba tu conexi\u00f3n e intenta recargar la p\u00e1gina.</p>' +
      '</div>';
  }

  // ─── Protomaps terrain-only style ───────────────────────────────────────────

  buildTerrainStyle() {
    var REMOVE = new Set(['roads', 'transit', 'buildings', 'pois', 'landuse', 'landcover']);
    var allLayers = basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'es' });
    var terrainLayers = allLayers.filter(function(l) { return !REMOVE.has(l['source-layer']); });
    return {
      version: 8,
      glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
      sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
      sources: {
        protomaps: {
          type: 'vector',
          url: 'https://api.protomaps.com/tiles/v4.json?key=' + this.protomapsKey,
          attribution: '<a href="https://protomaps.com">Protomaps</a> \u00a9 <a href="https://openstreetmap.org">OpenStreetMap</a>'
        }
      },
      layers: terrainLayers
    };
  }

  // ─── DOM construction ───────────────────────────────────────────────────────

  buildDOM() {
    // ── Search input into #place-search-input ──────────────────────────────
    var searchSlot = document.getElementById('place-search-input');
    if (searchSlot) {
      this.searchInput = document.createElement('input');
      this.searchInput.type = 'search';
      this.searchInput.placeholder = 'Buscar por nombre de lugar\u2026';
      this.searchInput.value = this.state.q;
      this.searchInput.style.cssText = 'width:100%;padding:0.75rem 1.25rem;font-size:1rem;border:1px solid var(--color-stone-300);border-radius:50px;outline:none;font-family:var(--font-sans);box-sizing:border-box';
      this.searchInput.addEventListener('input', () => {
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => {
          this.state.q = this.searchInput.value;
          this.state.page = 1;
          this.search();
          this.updateUrl();
        }, 250);
      });
      searchSlot.appendChild(this.searchInput);
    }

    // ── Active filter pills into #place-explorer (results column) ─────────
    this.pillsEl = document.createElement('div');
    this.pillsEl.className = 'active-filters';
    this.pillsEl.style.marginBottom = '0.75rem';
    this.container.appendChild(this.pillsEl);

    // ── Results info bar ───────────────────────────────────────────────────
    this.resultsInfoEl = document.createElement('div');
    this.resultsInfoEl.className = 'search-results-info';
    this.resultsInfoEl.style.marginBottom = '0.5rem';
    this.container.appendChild(this.resultsInfoEl);

    // ── Results list ───────────────────────────────────────────────────────
    this.resultsListEl = document.createElement('div');
    this.resultsListEl.className = 'results-list';
    this.container.appendChild(this.resultsListEl);

    // ── Pagination ─────────────────────────────────────────────────────────
    this.paginationEl = document.createElement('div');
    this.paginationEl.className = 'search-pagination';
    this.container.appendChild(this.paginationEl);

    // ── Facets go into #sidebar-facets ─────────────────────────────────────
    this.facetContainer = document.getElementById('sidebar-facets');
    if (!this.facetContainer) {
      // Fallback: create inline (shouldn't happen with new template)
      this.facetContainer = document.createElement('div');
      this.facetContainer.className = 'facet-container';
      this.container.appendChild(this.facetContainer);
    }
  }

  // ─── Map init ───────────────────────────────────────────────────────────────

  initMap() {
    if (typeof maplibregl === 'undefined') return;

    var style;
    if (typeof basemaps !== 'undefined' && this.protomapsKey && this.protomapsKey !== 'YOUR_KEY_HERE') {
      style = this.buildTerrainStyle();
    } else {
      // Fallback: plain style without Protomaps key (dev/no-key scenario)
      style = {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f8f7f2' } }]
      };
    }

    // Detect available font from basemap layers for cluster count labels
    var clusterFont = ['Noto Sans Regular'];
    if (typeof basemaps !== 'undefined') {
      try {
        var allLayers = basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'es' });
        for (var li = 0; li < allLayers.length; li++) {
          var tf = allLayers[li].layout && allLayers[li].layout['text-font'];
          if (tf && Array.isArray(tf) && tf.length > 0) {
            clusterFont = tf;
            break;
          }
        }
      } catch (e) { /* keep default */ }
    }
    this._clusterFont = clusterFont;

    this.map = new maplibregl.Map({
      container: 'explorer-map',
      style: style,
      center: [-74.0, 5.5],
      zoom: 5,
      renderWorldCopies: false
    });

    this.map.fitBounds([[-83.0, -5.0], [-60.0, 15.0]], { padding: 20, animate: false });

    this.map.on('load', () => {
      this.mapReady = true;

      // GeoJSON source with clustering enabled
      this.map.addSource('places', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterMaxZoom: 12,
        clusterRadius: 50
      });

      // Cluster circles — size scales with point_count
      this.map.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'places',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#8B2942',
          'circle-radius': [
            'step', ['get', 'point_count'],
            14,
            10, 18,
            50, 22,
            200, 28
          ],
          'circle-opacity': 0.85,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff'
        }
      });

      // Cluster count labels
      this.map.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'places',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-font': this._clusterFont,
          'text-size': 11
        },
        paint: {
          'text-color': '#fff'
        }
      });

      // Unclustered individual place markers
      this.map.addLayer({
        id: 'unclustered-point',
        type: 'circle',
        source: 'places',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': '#8B2942',
          'circle-radius': 6,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fff'
        }
      });

      // Click on cluster: zoom to expand children
      this.map.on('click', 'clusters', async (e) => {
        var features = this.map.queryRenderedFeatures(e.point, { layers: ['clusters'] });
        if (!features.length) return;
        var clusterId = features[0].properties.cluster_id;
        var zoom = await this.map.getSource('places').getClusterExpansionZoom(clusterId);
        this.map.easeTo({ center: features[0].geometry.coordinates, zoom: zoom });
      });

      // Click on unclustered point: select place in sidebar
      this.map.on('click', 'unclustered-point', (e) => {
        var feat = e.features[0];
        if (!feat) return;
        var placeRecord = this.allPlaces.find(function(p) {
          return String(p.id) === String(feat.properties.id);
        }) || feat.properties;
        this.highlightPlace(placeRecord);
      });

      // Cursor pointer on interactive layers
      this.map.on('mouseenter', 'clusters', () => {
        this.map.getCanvas().style.cursor = 'pointer';
      });
      this.map.on('mouseleave', 'clusters', () => {
        this.map.getCanvas().style.cursor = '';
      });
      this.map.on('mouseenter', 'unclustered-point', () => {
        this.map.getCanvas().style.cursor = 'pointer';
      });
      this.map.on('mouseleave', 'unclustered-point', () => {
        this.map.getCanvas().style.cursor = '';
      });

      // Initial search after map is ready
      this.search();
    });
  }

  // ─── Example place buttons (in header intro text) ───────────────────────────

  initExampleButtons() {
    var buttons = document.querySelectorAll('.explorer-page-intro button[data-place]');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        var slug = btn.getAttribute('data-place');
        if (!slug) return;
        var found = this.allPlaces.find(function(p) {
          var normalised = p.display_name
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[áä]/g, 'a')
            .replace(/[éë]/g, 'e')
            .replace(/[íï]/g, 'i')
            .replace(/[óö]/g, 'o')
            .replace(/[úü]/g, 'u')
            .replace(/ñ/g, 'n')
            .replace(/[^a-z0-9-]/g, '');
          return normalised === slug || normalised.startsWith(slug);
        });
        if (found) {
          this.highlightPlace(found);
        }
      });
    });
  }

  // ─── Viewport filter ────────────────────────────────────────────────────────

  initViewportFilter() {
    var toggle = document.getElementById('viewport-filter-toggle');
    var label = toggle && toggle.querySelector('.viewport-filter-label');
    if (!toggle) return;

    toggle.addEventListener('click', () => {
      this.state.mapBound = !this.state.mapBound;
      toggle.classList.toggle('is-active', this.state.mapBound);
      toggle.setAttribute('aria-pressed', this.state.mapBound ? 'true' : 'false');
      if (label) {
        label.textContent = this.state.mapBound
          ? 'Filtrando por vista del mapa'
          : 'Filtrar por vista del mapa';
      }

      if (this.state.mapBound && this.map) {
        this._onMoveEnd = () => {
          if (!this.state.mapBound) return;
          clearTimeout(this._debounce);
          this._debounce = setTimeout(() => { this.search(); }, 250);
        };
        this.map.on('moveend', this._onMoveEnd);
      } else {
        if (this._onMoveEnd && this.map) {
          this.map.off('moveend', this._onMoveEnd);
          this._onMoveEnd = null;
        }
      }

      this.state.page = 1;
      this.search();
    });
  }

  // ─── Selected place card ────────────────────────────────────────────────────

  highlightPlace(place) {
    var card = document.getElementById('selected-place-card');
    if (!card) return;

    var name = place.display_name || '';
    var placeType = place.place_type || '';
    var typeLabel = this.placeTypes[placeType] || placeType;
    var n = place.linked_description_count || 0;
    var docText = n + ' ' + (n === 1 ? 'documento vinculado' : 'documentos vinculados');
    var placeId = place.id;
    var placeCode = place.place_code || ('nl-' + placeId);

    card.innerHTML =
      '<div class="selected-entity-header">' +
        '<h3 class="selected-entity-name">' + this.escapeHtml(name) + '</h3>' +
        '<button type="button" class="selected-entity-close" aria-label="Cerrar">&times;</button>' +
      '</div>' +
      '<span class="selected-entity-badge">' + this.escapeHtml(typeLabel) + '</span>' +
      '<div class="selected-entity-stat" style="margin-top:0.75rem">' + this.escapeHtml(docText) + '</div>' +
      '<a href="/' + this.escapeHtml(placeCode) + '/" class="selected-entity-link" ' +
      'style="display:block;margin-top:0.5rem">Ver ficha &rarr;</a>';

    // Close button clears back to stub
    var closeBtn = card.querySelector('.selected-entity-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        card.innerHTML = '<div class="selected-entity-stub">Selecciona un lugar para ver m\u00e1s detalles</div>';
      });
    }

    // Pan/zoom map to place coordinates
    if (place.latitude != null && place.longitude != null && this.map && this.mapReady) {
      this.map.easeTo({ center: [place.longitude, place.latitude], zoom: Math.max(this.map.getZoom(), 8) });
    }
  }

  // ─── URL state ──────────────────────────────────────────────────────────────

  parseUrlParams() {
    var params = new URLSearchParams(window.location.search);
    this.state.q = params.get('q') || '';
    this.state.type = params.getAll('type');
    this.state.hasCoords = params.has('coords') ? params.get('coords') === '1' : null;
    this.state.hasAuthority = params.has('authority') ? params.get('authority') === '1' : null;
    this.state.sort = params.get('sort') || 'name';
    this.state.page = parseInt(params.get('page') || '1', 10);
    this.state.mapBound = params.get('map_bound') === '1';
  }

  updateUrl() {
    var params = new URLSearchParams();
    if (this.state.q) params.set('q', this.state.q);
    for (var i = 0; i < this.state.type.length; i++) params.append('type', this.state.type[i]);
    if (this.state.hasCoords !== null) params.set('coords', this.state.hasCoords ? '1' : '0');
    if (this.state.hasAuthority !== null) params.set('authority', this.state.hasAuthority ? '1' : '0');
    if (this.state.sort !== 'name') params.set('sort', this.state.sort);
    if (this.state.page > 1) params.set('page', String(this.state.page));
    if (this.state.mapBound) params.set('map_bound', '1');
    var qs = params.toString();
    var url = qs ? '/lugares/?' + qs : '/lugares/';
    history.pushState(null, '', url);
  }

  // Sync form controls to restored state (after popstate)
  syncFormToState() {
    if (this.searchInput) this.searchInput.value = this.state.q;
    var toggle = document.getElementById('viewport-filter-toggle');
    var label = toggle && toggle.querySelector('.viewport-filter-label');
    if (toggle) {
      toggle.classList.toggle('is-active', this.state.mapBound);
      toggle.setAttribute('aria-pressed', this.state.mapBound ? 'true' : 'false');
      if (label) {
        label.textContent = this.state.mapBound
          ? 'Filtrando por vista del mapa'
          : 'Filtrar por vista del mapa';
      }
    }
  }

  // ─── Pagefind search ─────────────────────────────────────────────────────────

  async search() {
    if (!this.pagefind) return;
    if (!this.resultsListEl) return;

    // Generation counter prevents stale in-flight searches from
    // calling renderFacets() and resetting checkbox state
    var gen = ++this._searchGen;

    // Build Pagefind filters
    var pfFilters = {};
    if (this.state.type.length > 0) pfFilters.place_type = { any: this.state.type };
    if (this.state.hasCoords !== null) pfFilters.has_coordinates = this.state.hasCoords ? 'true' : 'false';
    if (this.state.hasAuthority !== null) pfFilters.has_authority = this.state.hasAuthority ? 'true' : 'false';

    // Build Pagefind sort
    var pfSort = {};
    if (this.state.sort === 'name') pfSort.name = 'asc';

    try {
      var searchResult = await this.pagefind.search(
        this.state.q || null,
        {
          filters: Object.keys(pfFilters).length ? pfFilters : undefined,
          sort: this.state.sort === 'name' ? pfSort : undefined
        }
      );

      if (gen !== this._searchGen) return;

      this.lastSearch = searchResult;

      var allResults = searchResult.results;
      var scopedFilters = searchResult.filters || this.globalFilters;

      // Apply viewport filter if mapBound is active
      var filteredResults = allResults;
      if (this.state.mapBound && this.map && this.mapReady) {
        var bounds = this.map.getBounds();
        var viewportNames = new Set(
          this.allPlaces
            .filter(function(p) {
              return p.latitude != null && p.longitude != null &&
                p.longitude >= bounds.getWest() && p.longitude <= bounds.getEast() &&
                p.latitude >= bounds.getSouth() && p.latitude <= bounds.getNorth();
            })
            .map(function(p) { return p.display_name; })
        );
        // Load data for all results to check title against viewport names.
        // Pagefind stubs don't expose URL or title, so we must resolve them.
        var allData = await Promise.all(allResults.map(function(r) { return r.data(); }));
        if (gen !== this._searchGen) return;
        allData = allData.filter(function(d) { return viewportNames.has(d.meta.title); });
        var total = allData.length;
        var totalPages = Math.ceil(total / this.perPage) || 1;
        if (this.state.page > totalPages) this.state.page = 1;
        var start = (this.state.page - 1) * this.perPage;
        var hits = allData.slice(start, start + this.perPage);
      } else {
        var total = filteredResults.length;
        var totalPages = Math.ceil(total / this.perPage) || 1;
        if (this.state.page > totalPages) this.state.page = 1;
        var start = (this.state.page - 1) * this.perPage;
        var pageResults = filteredResults.slice(start, start + this.perPage);
        var hits = await Promise.all(pageResults.map(function(r) { return r.data(); }));
        if (gen !== this._searchGen) return;
      }

      // Apply 'linked' sort after loading (Pagefind doesn't support count sort)
      if (this.state.sort === 'linked') {
        hits = hits.slice().sort(function(a, b) {
          var aCount = parseInt(a.meta.linked_count || '0', 10);
          var bCount = parseInt(b.meta.linked_count || '0', 10);
          var diff = bCount - aCount;
          if (diff !== 0) return diff;
          return (a.meta.title || '').localeCompare(b.meta.title || '', 'es');
        });
      }

      // Sync map markers with search/filter state
      if (this.state.q || this.state.type.length || this.state.hasCoords !== null || this.state.hasAuthority !== null) {
        var matchingCodes = new Set();
        for (var ri = 0; ri < allResults.length; ri++) {
          var url = allResults[ri].url || '';
          var segments = url.split('/').filter(Boolean);
          if (segments.length > 0) matchingCodes.add(segments[segments.length - 1]);
        }
        var filteredPlaces = this.allPlaces.filter(function(p) {
          return matchingCodes.has(p.place_code);
        });
        this.updateMap(filteredPlaces);
      } else {
        this.updateMap(this.allPlaces);
      }

      // When viewport-filtering, recompute facet counts from the
      // in-memory place data filtered to the current map bounds.
      if (this.state.mapBound && this.map && this.mapReady) {
        var vpBounds = this.map.getBounds();
        var vpPlaces = this.allPlaces.filter(function(p) {
          return p.latitude != null && p.longitude != null &&
            p.longitude >= vpBounds.getWest() && p.longitude <= vpBounds.getEast() &&
            p.latitude >= vpBounds.getSouth() && p.latitude <= vpBounds.getNorth();
        });
        var vpFacets = { place_type: {}, has_coordinates: {}, has_authority: {} };
        for (var vi = 0; vi < vpPlaces.length; vi++) {
          var vp = vpPlaces[vi];
          var pt = vp.place_type || 'unknown';
          vpFacets.place_type[pt] = (vpFacets.place_type[pt] || 0) + 1;
          var hasCoords = (vp.latitude != null && vp.longitude != null) ? 'true' : 'false';
          vpFacets.has_coordinates[hasCoords] = (vpFacets.has_coordinates[hasCoords] || 0) + 1;
          var hasAuth = (vp.has_wikidata || vp.has_tgn || vp.has_whg || vp.has_hgis) ? 'true' : 'false';
          vpFacets.has_authority[hasAuth] = (vpFacets.has_authority[hasAuth] || 0) + 1;
        }
        scopedFilters = vpFacets;
      }

      this.renderResultsInfo(total, allResults.length);
      this.renderResults(hits, total);
      this.renderPagination(total);
      this.renderFacets(scopedFilters);
      this.renderPills();
    } catch (e) {
      console.error('PlaceExplorer search error:', e);
    }
  }

  // ─── Results info bar ───────────────────────────────────────────────────────

  renderResultsInfo(total, rawTotal) {
    this.resultsInfoEl.innerHTML = '';

    var countSpan = document.createElement('span');
    countSpan.className = 'results-count';

    var hasFilters = this.state.q || this.state.type.length > 0 ||
      this.state.hasCoords !== null || this.state.hasAuthority !== null || this.state.mapBound;

    if (!hasFilters) {
      countSpan.textContent = (rawTotal || total).toLocaleString('es-CO') + ' lugares';
    } else if (total === 1) {
      countSpan.textContent = '1 lugar encontrado';
    } else {
      countSpan.textContent = total.toLocaleString('es-CO') + ' lugares encontrados';
    }
    this.resultsInfoEl.appendChild(countSpan);

    // Sort controls
    var sortControls = document.createElement('div');
    sortControls.className = 'sort-controls';

    var sortOptions = [
      { value: 'name', label: 'Nombre' },
      { value: 'linked', label: 'Documentos' }
    ];

    for (var i = 0; i < sortOptions.length; i++) {
      var opt = sortOptions[i];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sort-btn';
      btn.dataset.sort = opt.value;
      btn.textContent = opt.label;
      if (this.state.sort === opt.value) btn.classList.add('active');
      btn.addEventListener('click', ((v) => () => {
        if (this.state.sort === v) return;
        this.state.sort = v;
        this.state.page = 1;
        this.search();
        this.updateUrl();
      })(opt.value));
      sortControls.appendChild(btn);
    }
    this.resultsInfoEl.appendChild(sortControls);
  }

  // ─── Results list ───────────────────────────────────────────────────────────

  renderResults(hits, total) {
    this.resultsListEl.innerHTML = '';

    if (total === 0) {
      var empty = document.createElement('div');
      empty.className = 'search-no-results';
      empty.innerHTML =
        '<p style="font-size:1.1rem;font-weight:500;color:var(--color-stone-600)">Sin resultados</p>' +
        '<p style="color:var(--color-stone-400)">No se encontraron lugares con estos criterios.</p>';
      var clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'clear-filters-btn';
      clearBtn.style.marginTop = '0.75rem';
      clearBtn.textContent = 'Borrar todos los filtros';
      clearBtn.addEventListener('click', () => this.clearFilters());
      empty.appendChild(clearBtn);
      this.resultsListEl.appendChild(empty);
      return;
    }

    for (var i = 0; i < hits.length; i++) {
      var hit = hits[i];
      var item = document.createElement('div');
      item.className = 'result-item';

      var placeName = hit.meta.title || '';
      var placeType = hit.meta.place_type || '';
      var hasCoords = hit.meta.has_coordinates === 'true';
      var linkedCount = parseInt(hit.meta.linked_count || '0', 10);
      var nameVariants = hit.meta.name_variants || '';
      var placeUrl = hit.url;

      // Row 1: name + inline meta
      var row1 = document.createElement('div');
      row1.style.cssText = 'display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap';

      var titleLink = document.createElement('a');
      titleLink.href = placeUrl;
      titleLink.className = 'result-title';
      titleLink.textContent = placeName;

      // Wire click: select place in map/card instead of navigating
      titleLink.addEventListener('click', (e) => {
        e.preventDefault();
        var pName = e.currentTarget.textContent;
        var found = this.allPlaces.find(function(p) { return p.display_name === pName; });
        if (found) this.highlightPlace(found);
      });

      row1.appendChild(titleLink);

      var badge = document.createElement('span');
      badge.className = 'level-badge';
      badge.textContent = this.placeTypes[placeType] || placeType;
      row1.appendChild(badge);

      var count = document.createElement('span');
      count.style.cssText = 'font-size:0.85rem;color:var(--color-stone-500)';
      count.textContent = linkedCount > 0
        ? '\u00b7 Asociado a ' + linkedCount + ' ' + (linkedCount === 1 ? 'documento' : 'documentos')
        : '\u00b7 Sin documentos asociados';
      row1.appendChild(count);

      // Indicators (pushed right)
      var indicators = document.createElement('span');
      indicators.style.cssText = 'display:inline-flex;gap:0.35rem;align-items:center;margin-left:auto';

      if (hasCoords) {
        var pin = document.createElement('span');
        pin.className = 'material-symbols-outlined';
        pin.style.cssText = 'font-size:1.3rem;color:var(--color-burgundy);font-variation-settings:"wght" 200';
        pin.textContent = 'location_on';
        pin.title = 'Con coordenadas';
        indicators.appendChild(pin);
      }

      if (hit.meta.has_authority === 'true') {
        var authBadge = document.createElement('span');
        authBadge.className = 'authority-pill';
        authBadge.style.cssText += 'font-size:0.7rem;padding:2px 6px';
        authBadge.textContent = 'Autoridad';
        authBadge.title = 'Con v\u00ednculo de autoridad';
        indicators.appendChild(authBadge);
      }

      row1.appendChild(indicators);
      item.appendChild(row1);

      // Row 2: name variants (if any)
      if (nameVariants) {
        var variantsList = nameVariants.split(',').map(function(v) { return v.trim(); }).filter(Boolean);
        if (variantsList.length > 0) {
          var variants = document.createElement('div');
          variants.style.cssText = 'font-size:0.8rem;color:var(--color-stone-400);margin-top:0.15rem';
          variants.textContent = variantsList.join(', ');
          item.appendChild(variants);
        }
      }

      this.resultsListEl.appendChild(item);
    }
  }

  // ─── Pagination ─────────────────────────────────────────────────────────────

  renderPagination(total) {
    this.paginationEl.innerHTML = '';
    var totalPages = Math.ceil(total / this.perPage);
    if (totalPages <= 1) return;

    var current = this.state.page;

    var addLink = (label, page, isActive, isEllipsis) => {
      if (isEllipsis) {
        var span = document.createElement('span');
        span.className = 'pagination-ellipsis';
        span.textContent = '\u2026';
        this.paginationEl.appendChild(span);
        return;
      }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pagination-link' + (isActive ? ' active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        this.state.page = page;
        this.search();
        this.updateUrl();
        if (this.resultsListEl) this.resultsListEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      this.paginationEl.appendChild(btn);
    };

    var visiblePages = new Set();
    visiblePages.add(1);
    visiblePages.add(totalPages);
    for (var i = Math.max(1, current - 2); i <= Math.min(totalPages, current + 2); i++) {
      visiblePages.add(i);
    }

    var sorted = Array.from(visiblePages).sort(function(a, b) { return a - b; });
    var prev = 0;
    for (var j = 0; j < sorted.length; j++) {
      var p = sorted[j];
      if (p - prev > 1) addLink(null, null, false, true);
      addLink(String(p), p, p === current, false);
      prev = p;
    }
  }

  // ─── Facets ─────────────────────────────────────────────────────────────────

  renderFacets(filters) {
    this.facetContainer.innerHTML = '';

    var pfFilters = filters || this.globalFilters;

    // Group 1: Tipo de lugar
    var typeGroup = this.makeFacetGroup('Tipo de lugar', 'type', this.facetGroupState.type);
    var typeContent = typeGroup.querySelector('.facet-group-content');

    var typeCounts = pfFilters.place_type || {};
    for (var key in this.placeTypes) {
      if (!Object.prototype.hasOwnProperty.call(this.placeTypes, key)) continue;
      var label = this.placeTypes[key];
      var count = typeCounts[key] || 0;
      if (count === 0 && !this.state.type.includes(key)) continue;
      var lbl = document.createElement('label');
      lbl.className = 'facet-option';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = key;
      cb.checked = this.state.type.includes(key);
      cb.addEventListener('change', ((k) => () => {
        if (cb.checked) {
          if (!this.state.type.includes(k)) this.state.type.push(k);
        } else {
          this.state.type = this.state.type.filter(function(t) { return t !== k; });
        }
        this.state.page = 1;
        this.search();
        this.updateUrl();
      })(key));
      lbl.appendChild(cb);
      var txt = document.createElement('span');
      txt.className = 'facet-label-text';
      txt.textContent = label;
      lbl.appendChild(txt);
      var cnt = document.createElement('span');
      cnt.className = 'facet-count';
      cnt.textContent = '(' + count.toLocaleString('es-CO') + ')';
      lbl.appendChild(cnt);
      typeContent.appendChild(lbl);
    }
    this.facetContainer.appendChild(typeGroup);

    // Group 2: Coordenadas
    var coordsGroup = this.makeFacetGroup('Coordenadas', 'coords', this.facetGroupState.coords);
    var coordsContent = coordsGroup.querySelector('.facet-group-content');
    var coordsCounts = pfFilters.has_coordinates || {};
    var coordsWithCoords = coordsCounts['true'] || 0;

    var coordsLbl = document.createElement('label');
    coordsLbl.className = 'facet-option';
    var coordsCb = document.createElement('input');
    coordsCb.type = 'checkbox';
    coordsCb.checked = this.state.hasCoords === true;
    coordsCb.addEventListener('change', () => {
      this.state.hasCoords = coordsCb.checked ? true : null;
      this.state.page = 1;
      this.search();
      this.updateUrl();
    });
    coordsLbl.appendChild(coordsCb);
    var coordsTxt = document.createElement('span');
    coordsTxt.className = 'facet-label-text';
    coordsTxt.textContent = 'Solo lugares con coordenadas';
    coordsLbl.appendChild(coordsTxt);
    var coordsCnt = document.createElement('span');
    coordsCnt.className = 'facet-count';
    coordsCnt.textContent = '(' + coordsWithCoords.toLocaleString('es-CO') + ')';
    coordsLbl.appendChild(coordsCnt);
    coordsContent.appendChild(coordsLbl);
    this.facetContainer.appendChild(coordsGroup);

    // Group 3: Autoridades
    var authGroup = this.makeFacetGroup('Autoridades', 'authority', this.facetGroupState.authority);
    var authContent = authGroup.querySelector('.facet-group-content');
    var authCounts = pfFilters.has_authority || {};
    var withAuthority = authCounts['true'] || 0;

    var authLbl = document.createElement('label');
    authLbl.className = 'facet-option';
    var authCb = document.createElement('input');
    authCb.type = 'checkbox';
    authCb.checked = this.state.hasAuthority === true;
    authCb.addEventListener('change', () => {
      this.state.hasAuthority = authCb.checked ? true : null;
      this.state.page = 1;
      this.search();
      this.updateUrl();
    });
    authLbl.appendChild(authCb);
    var authTxt = document.createElement('span');
    authTxt.className = 'facet-label-text';
    authTxt.textContent = 'Solo con autoridad externa';
    authLbl.appendChild(authTxt);
    var authCnt = document.createElement('span');
    authCnt.className = 'facet-count';
    authCnt.textContent = '(' + withAuthority.toLocaleString('es-CO') + ')';
    authLbl.appendChild(authCnt);
    authContent.appendChild(authLbl);
    this.facetContainer.appendChild(authGroup);
  }

  makeFacetGroup(title, stateKey, isOpen) {
    var group = document.createElement('div');
    group.className = 'facet-group';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'facet-group-toggle';
    toggle.innerHTML =
      '<span class="facet-group-title">' + this.escapeHtml(title) + '</span>' +
      '<span class="facet-group-indicator">' + (isOpen ? '\u2212' : '+') + '</span>';

    var content = document.createElement('div');
    content.className = 'facet-group-content';
    content.style.display = isOpen ? '' : 'none';

    toggle.addEventListener('click', () => {
      this.facetGroupState[stateKey] = !this.facetGroupState[stateKey];
      var indicator = toggle.querySelector('.facet-group-indicator');
      content.style.display = this.facetGroupState[stateKey] ? '' : 'none';
      indicator.textContent = this.facetGroupState[stateKey] ? '\u2212' : '+';
    });

    group.appendChild(toggle);
    group.appendChild(content);
    return group;
  }

  // ─── Filter pills ───────────────────────────────────────────────────────────

  renderPills() {
    this.pillsEl.innerHTML = '';

    var hasAny = this.state.type.length > 0 ||
      this.state.hasCoords !== null ||
      this.state.hasAuthority !== null;

    if (!hasAny) return;

    for (var i = 0; i < this.state.type.length; i++) {
      var t = this.state.type[i];
      var label = this.placeTypes[t] || t;
      this.pillsEl.appendChild(this.makePill(label, ((k) => () => {
        this.state.type = this.state.type.filter(function(x) { return x !== k; });
        this.state.page = 1;
        this.search();
        this.updateUrl();
      })(t)));
    }

    if (this.state.hasCoords !== null) {
      this.pillsEl.appendChild(this.makePill('Con coordenadas', () => {
        this.state.hasCoords = null;
        this.state.page = 1;
        this.search();
        this.updateUrl();
      }));
    }

    if (this.state.hasAuthority !== null) {
      this.pillsEl.appendChild(this.makePill('Con autoridades', () => {
        this.state.hasAuthority = null;
        this.state.page = 1;
        this.search();
        this.updateUrl();
      }));
    }

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'clear-filters-btn';
    clearBtn.textContent = 'Borrar todos los filtros';
    clearBtn.addEventListener('click', () => this.clearFilters());
    this.pillsEl.appendChild(clearBtn);
  }

  makePill(label, onRemove) {
    var pill = document.createElement('span');
    pill.className = 'filter-pill';
    pill.textContent = label;
    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'filter-pill-remove';
    removeBtn.setAttribute('aria-label', 'Eliminar filtro: ' + label);
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', onRemove);
    pill.appendChild(removeBtn);
    return pill;
  }

  clearFilters() {
    this.state.q = '';
    this.state.type = [];
    this.state.hasCoords = null;
    this.state.hasAuthority = null;
    this.state.page = 1;
    if (this.searchInput) this.searchInput.value = '';
    this.search();
    this.updateUrl();
  }

  // ─── Map data update ────────────────────────────────────────────────────────

  updateMap(places) {
    if (!this.mapReady) return;
    var features = places
      .filter(function(p) { return p.latitude != null && p.longitude != null; })
      .map(function(p) {
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
          properties: {
            id: p.id,
            display_name: p.display_name,
            place_type: p.place_type,
            linked_description_count: p.linked_description_count
          }
        };
      });
    var source = this.map.getSource('places');
    if (source) {
      source.setData({ type: 'FeatureCollection', features: features });
    }
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────

  escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// Self-invoking init
document.addEventListener('DOMContentLoaded', function() {
  var container = document.getElementById('place-explorer');
  if (container) new PlaceExplorer(container);
});
