/**
 * Infinite Bipartite Explorer
 *
 * Powers the interactive graph on the right-hand side of the `/entidades/`
 * page. The graph is bipartite — entity nodes (people, corporate bodies,
 * families) alternate with document nodes — and "infinite" because the
 * visitor can keep expanding it: clicking an entity refocuses the graph
 * around that entity and loads its documents; clicking a document expands
 * the other entities it touches; clicking one of those entities refocuses
 * again, and so on through the archive.
 *
 * Rendering and force simulation are handled by force-graph, a canvas-based
 * d3-force wrapper loaded from a CDN as `window.ForceGraph` (no module
 * system — this file uses a classic IIFE and publishes a global
 * `InfiniteBipartiteExplorer` constructor). Nodes are drawn with a custom
 * canvas painter so entities get coloured discs sized by document count,
 * documents get one of three visual states (expanded, expandable, leaf),
 * and overflow nodes render as dashed rings with a "+N more" label.
 *
 * The data layer uses three on-demand sources: per-entity link shards
 * under `/data/entity-links/`, the Pagefind descriptions index (for
 * lazy per-document entity lookups), and a small HTML scrape of each
 * entity's authority page for display metadata. Shards, metadata, and
 * Pagefind results are all cached in memory for the life of the session.
 * A soft BFS-based prune clears distant branches after very deep
 * exploration so long sessions don't balloon past the canvas.
 *
 * Filters and cross-panel sync are implemented through public methods:
 * `applyFilters` (called by the sidebar when entity-type or text-search
 * filters change), `setFocalRoleFilter` (called when the selected-entity
 * card's documentary-role checkboxes change), `refocusOn`, and
 * `getVisibleEntities` / `getVisibleEntityCodes` (used by the sidebar's
 * viewport-filter mode). Callbacks `onEntityFocused` and
 * `onFocalVisibilityChanged` feed changes back to the sidebar.
 *
 * @version v0.5.0
 */

(function () {
  'use strict';

  // Shared constants — replicated from entity.js
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

  var entityColors = {
    person: '#8B2942',
    corporate_body: '#6666BB',
    corporate: '#6666BB',
    family: '#6666BB'
  };

  var DOC_COLOR = '#A09888';
  var OVERFLOW_COLOR = '#C0B8A8';
  var MAX_INITIAL_DOCS = 30;
  // Soft pruning limit — distant branches get cleaned up only after very
  // deep exploration. The corpus's worst-case doc has 210 connected
  // entities and only one doc breaks 200, so a normal trail will never
  // hit this and the prune is mostly a long-session safety valve.
  var MAX_HOPS = 50;
  var DEFAULT_ENTITY = 'ne-69501';

  // -----------------------------------------------------------------------
  // InfiniteBipartiteExplorer
  // -----------------------------------------------------------------------

  function InfiniteBipartiteExplorer(container) {
    this.container = container;
    this.tooltipEl = document.getElementById('graph-tooltip');
    this.legendEl = document.getElementById('graph-legend');

    // Graph state
    this.graphInstance = null;
    this.graphNodes = new Map();   // id -> node object
    this.graphEdges = [];          // [{source, target, role}]
    this.nodeNeighbours = new Map(); // id -> Set of neighbour ids
    this.nodeLinks = new Map();    // id -> Set of link objects

    // Caches
    this.shardCache = new Map();   // entityCode -> links array
    this.descLookup = new Map();   // refCode -> [entityCodes]
    this.entityMeta = new Map();   // entityCode -> {label, entity_type, linked_count}

    // State
    this.focalEntityCode = null;
    this.hopDistance = new Map();
    this.hoveredNode = null;
    this.selectedNode = null;

    // Focal-card role filter — set of role strings restricting which focal
    // docs are visible. Empty set = no filter. Composes with applyFilters'
    // entity-type / search-query visibility flags. Reset on refocus.
    this.focalRoleFilter = new Set();
    // Last filter args from applyFilters, kept so setFocalRoleFilter can
    // recompute visibility consistently with whatever the sidebar last sent.
    this._lastSidebarFilters = null;

    // Callbacks
    this.onEntityFocused = null;
    this.onFiltersNeeded = null;
  }

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.init = async function (opts) {
    var self = this;
    opts = opts || {};

    // Expandability checks are lazy (Pagefind on hover) — matches entity.js
    // pattern. No upfront fetch of any large lookup file.
    this.descLookup = new Map();
    this.expandableCache = new Map(); // refCode → array of entity codes
    this.pagefindDesc = null;

    this.initGraph();
    this.renderLegend();

    // Force dimension update after layout settles. Force-graph reads container
    // dimensions at construction; if flexbox hadn't computed yet, the canvas
    // gets stuck at small internal pixel size and CSS-upscales. Update on
    // multiple animation frames to catch async layout.
    var updateSize = function () {
      if (!self.graphInstance) return;
      var rect = self.container.getBoundingClientRect();
      var w = Math.round(rect.width);
      var h = Math.round(rect.height);
      if (w > 0 && h > 0) {
        self.graphInstance.width(w).height(h);
      }
    };
    requestAnimationFrame(function () {
      updateSize();
      requestAnimationFrame(function () {
        updateSize();
        // Use zoom(1) instead of zoomToFit — fit can produce extreme zooms
        // for sparse graphs which makes everything appear at wrong scale.
        if (self.graphInstance) self.graphInstance.zoom(1);
      });
    });

    // Back button navigation
    window.addEventListener('popstate', function (e) {
      if (e.state && e.state.entidad) {
        self.refocusOn(e.state.entidad);
      }
    });

    // Skip auto-load when the host wants the empty-state overlay to show
    // first (no ?entidad= URL param). User interaction will trigger
    // refocusOn() which populates the graph.
    if (opts.skipAutoLoad) return;

    // Determine starting entity
    var startingEntity = DEFAULT_ENTITY;
    var urlParam = new URLSearchParams(location.search).get('entidad');
    if (urlParam) {
      startingEntity = urlParam;
    } else {
      try {
        var cg = await fetch('/data/curated-entity-graph.json');
        if (cg.ok) {
          var cgData = await cg.json();
          if (cgData.nodes && cgData.nodes.length > 0) {
            startingEntity = cgData.nodes[0].id;
          }
        }
      } catch (e) {
        // fall back to DEFAULT_ENTITY
      }
    }

    await this.loadEntity(startingEntity);

    // Fire focal callback so the sidebar/overlay shows the initial entity
    // immediately, not just after the user clicks something.
    if (this.onEntityFocused) {
      this.onEntityFocused(
        startingEntity,
        this.entityMeta.get(startingEntity) || null,
        this.shardCache.get(startingEntity) || []
      );
    }
  };

  // -----------------------------------------------------------------------
  // Graph initialisation
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.initGraph = function () {
    var self = this;

    // ForceGraph is loaded via CDN as window.ForceGraph
    /* global ForceGraph */
    var initialWidth = this.container.clientWidth || 800;
    var initialHeight = this.container.clientHeight || 600;
    this.graphInstance = new ForceGraph(this.container)
      .width(initialWidth)
      .height(initialHeight)
      .graphData({ nodes: [], links: [] })
      .nodeId('id')
      .nodeCanvasObjectMode(function () { return 'replace'; })
      .nodeCanvasObject(this.drawNode.bind(this))
      .nodePointerAreaPaint(this.drawNodeHitArea.bind(this))
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      // NO .cooldownTime() — omit entirely for continuous simulation (CRITICAL)
      // NO .onEngineStop()  — omit entirely (CRITICAL)
      .onNodeHover(this.handleHover.bind(this))
      .onNodeClick(this.handleNodeClick.bind(this))
      .onNodeDragEnd(function (node) { node.fx = node.x; node.fy = node.y; })
      .onZoom(this.updateTooltipPosition.bind(this))
      .onBackgroundClick(this.dismissTooltip.bind(this))
      .linkColor(function () { return 'rgba(160,152,136,0.3)'; })
      .linkWidth(1)
      // Hide a link if either of its endpoints is filtered out. Without
      // this, filtering an entity leaves its incident edges as orphaned
      // spokes radiating from invisible nodes.
      .linkVisibility(function (link) {
        var s = typeof link.source === 'object' ? link.source : self.graphNodes.get(link.source);
        var t = typeof link.target === 'object' ? link.target : self.graphNodes.get(link.target);
        if (!s || !t) return false;
        return s._visible !== false && t._visible !== false;
      });

    // Per-node charge: stronger repulsion for entity nodes (so expanded
    // clusters of ~10–20 entities around a doc actually spread out) while
    // keeping doc nodes weak so the focal entity's large doc ring stays
    // compact.
    this.graphInstance.d3Force('charge').strength(function (node) {
      if (node.type === 'entity') return -120;
      return -20;
    });
    var graphSelf = this;
    this.graphInstance.d3Force('link').distance(function (link) {
      // Short links from the focal entity to its docs (keeps the big
      // focal ring compact). Longer links elsewhere so expanded entity
      // clusters around a doc get breathing room.
      var sId = typeof link.source === 'object' ? link.source.id : link.source;
      var tId = typeof link.target === 'object' ? link.target.id : link.target;
      var focal = graphSelf.focalEntityCode;
      if (focal && (sId === focal || tId === focal)) return 20;
      return 45;
    }).strength(0.5);

    // Resize observer — use getBoundingClientRect for sub-pixel accuracy
    new ResizeObserver(function () {
      if (!self.graphInstance) return;
      var rect = self.container.getBoundingClientRect();
      var w = Math.round(rect.width);
      var h = Math.round(rect.height);
      if (w > 0 && h > 0) {
        self.graphInstance.width(w).height(h);
      }
    }).observe(this.container);
  };

  // -----------------------------------------------------------------------
  // Node rendering (canvas)
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.drawNode = function (node, ctx, globalScale) {
    // Visibility: _visible flag (set by applyFilters)
    if (node._visible === false) return;

    // Hover dimming
    var opacity;
    if (this.hoveredNode && node.id !== this.hoveredNode.id) {
      var neighbours = this.nodeNeighbours.get(this.hoveredNode.id);
      var isNeighbour = neighbours && neighbours.has(node.id);
      opacity = isNeighbour ? 1.0 : 0.15;
    } else {
      opacity = 1.0;
    }

    ctx.globalAlpha = opacity;

    // All sizes are SCREEN pixels divided by globalScale (force-graph
    // pre-applies the zoom transform to ctx, so dividing by globalScale
    // produces a constant on-screen size regardless of zoom level).
    var s = globalScale;

    if (node.type === 'entity') {
      var color = entityColors[node.entity_type] || '#8B2942';
      var rScreen = Math.max(4, Math.min(11, Math.sqrt(node.linked_count || 1) * 1.5));
      var r = rScreen / s;

      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();

      // Label — only when zoomed in. The hover tooltip handles the
      // name on hover, so we no longer draw a canvas label for the hovered
      // node (it produced a duplicate label below the dark tooltip).
      var showLabel = s > 1.2;
      if (showLabel && node.label) {
        var fontSize = 11 / s;
        ctx.font = fontSize + 'px DM Sans, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#333';
        ctx.fillText(node.label, node.x, node.y + r + (2 / s));
      }

    } else if (node.type === 'document') {
      // Three visual states — all in screen px
      if (node.expanded === true) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, 4 / s, 0, 2 * Math.PI);
        ctx.fillStyle = DOC_COLOR;
        ctx.fill();
      } else if (node.expandable === true) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, 3 / s, 0, 2 * Math.PI);
        ctx.fillStyle = DOC_COLOR;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(node.x, node.y, 2.5 / s, 0, 2 * Math.PI);
        ctx.fillStyle = '#FAFAF9';
        ctx.fill();
        ctx.strokeStyle = DOC_COLOR;
        ctx.lineWidth = 1.2 / s;
        ctx.stroke();
      }

      // Document title shown via the dark hover tooltip — no canvas label.

    } else if (node.type === 'overflow') {
      // Dashed border circle with count label — screen px
      ctx.beginPath();
      ctx.arc(node.x, node.y, 7 / s, 0, 2 * Math.PI);
      ctx.setLineDash([3 / s, 3 / s]);
      ctx.strokeStyle = OVERFLOW_COLOR;
      ctx.lineWidth = 1.5 / s;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = (9 / s) + 'px DM Sans, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = OVERFLOW_COLOR;
      var countText = node.label || ('+' + (node.hiddenCount || 0));
      ctx.fillText(countText, node.x, node.y);
    }

    ctx.globalAlpha = 1.0;
  };

  // -----------------------------------------------------------------------
  // Hit-area paint — must match screen-space sizes used in drawNode so
  // pointer events line up with the visible nodes.
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.drawNodeHitArea = function (node, color, ctx, globalScale) {
    var s = globalScale;
    var r;
    if (node.type === 'entity') {
      r = Math.max(4, Math.min(11, Math.sqrt(node.linked_count || 1) * 1.5)) / s;
    } else if (node.type === 'overflow') {
      r = 8 / s;
    } else {
      r = 5 / s; // generous hit area for tiny doc nodes
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fill();
  };

  // -----------------------------------------------------------------------
  // Hover handling
  // -----------------------------------------------------------------------

  // force-graph (standalone) has no refresh() method — trigger a redraw by
  // re-applying the current graphData. This is cheap and reliable.
  InfiniteBipartiteExplorer.prototype._redraw = function () {
    if (!this.graphInstance) return;
    var data = this.graphInstance.graphData();
    this.graphInstance.graphData(data);
  };

  InfiniteBipartiteExplorer.prototype.handleHover = function (node) {
    this.hoveredNode = node || null;
    this.container.style.cursor = node ? 'pointer' : 'grab';
    // Do NOT call _redraw() here. Re-applying graphData on every hover
    // perturbs the d3 force simulation, which makes nodes wiggle and the
    // tooltip drift out of position. The canvas redraws on every animation
    // frame anyway because the simulation runs continuously, so drawNode
    // will pick up the new this.hoveredNode value on the next frame.

    // Show a hover tooltip in addition to the dimming. The click tooltip
    // (selectedNode) takes priority — never overwrite it from a hover.
    if (this.selectedNode) return;
    if (!node) {
      this.dismissHoverTooltip();
      return;
    }
    if (node.type === 'entity') {
      this.showEntityHoverTooltip(node);
    } else if (node.type === 'document') {
      this.showDocumentHoverTooltip(node);
    } else if (node.type === 'overflow') {
      this.showOverflowHoverTooltip(node);
    } else {
      this.dismissHoverTooltip();
    }
  };

  // -----------------------------------------------------------------------
  // Hover tooltip — uses the same #graph-tooltip element as the click
  // tooltip, but is dismissed automatically on mouseout. The click tooltip
  // sets selectedNode and takes priority; while a click tooltip is open the
  // hover handler bails out early.
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.showEntityHoverTooltip = function (node) {
    var tooltip = this.tooltipEl;
    if (!tooltip) return;

    var typeName = {
      person: 'Persona',
      corporate_body: 'Entidad corporativa',
      corporate: 'Entidad corporativa',
      family: 'Familia'
    };
    var color = entityColors[node.entity_type] || '#8B2942';

    var html = '';
    html += '<div class="graph-tooltip-header">';
    html += '<span class="entity-type-badge" style="background:' + color + ';color:#fff">';
    html += escapeHtml(typeName[node.entity_type] || node.entity_type || 'Entidad');
    html += '</span></div>';
    html += '<div class="graph-tooltip-name">' + escapeHtml(node.label || node.id) + '</div>';
    html += '<div class="graph-tooltip-meta">' + (node.linked_count || '?') + ' documentos vinculados</div>';

    tooltip.innerHTML = html;
    tooltip.classList.add('is-hover');
    this.positionTooltip(node);
    tooltip.style.display = 'block';
  };

  InfiniteBipartiteExplorer.prototype.showDocumentHoverTooltip = function (node) {
    var tooltip = this.tooltipEl;
    if (!tooltip) return;

    var html = '';
    if (node.date_expression) {
      html += '<div class="graph-tooltip-date">' + escapeHtml(formatDate(node.date_expression)) + '</div>';
    }
    if (node.role) {
      html += '<div class="graph-tooltip-role">' + escapeHtml(roleLabels[node.role] || node.role) + '</div>';
    }
    html += '<div class="graph-tooltip-name">' + escapeHtml(node.title || node.reference_code) + '</div>';
    html += '<div class="graph-tooltip-ref">' + escapeHtml(node.reference_code) + '</div>';

    tooltip.innerHTML = html;
    tooltip.classList.add('is-hover');
    this.positionTooltip(node);
    tooltip.style.display = 'block';
  };

  InfiniteBipartiteExplorer.prototype.showOverflowHoverTooltip = function (node) {
    var tooltip = this.tooltipEl;
    if (!tooltip) return;

    var html = '';
    html += '<div class="graph-tooltip-name">' + (node.hiddenCount || 0) + ' documentos m\u00e1s</div>';
    html += '<div class="graph-tooltip-meta">Haz clic para cargar el siguiente lote</div>';

    tooltip.innerHTML = html;
    tooltip.classList.add('is-hover');
    this.positionTooltip(node);
    tooltip.style.display = 'block';
  };

  InfiniteBipartiteExplorer.prototype.dismissHoverTooltip = function () {
    if (this.selectedNode) return; // click tooltip is open, leave it alone
    if (!this.tooltipEl) return;
    this.tooltipEl.classList.remove('is-hover');
    this.tooltipEl.style.display = 'none';
    this.tooltipEl.innerHTML = '';
  };

  // -----------------------------------------------------------------------
  // Click handling
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.handleNodeClick = function (node) {
    if (!node) return;
    if (node.type === 'overflow') {
      this.loadMoreDocs(node);
    } else if (node.type === 'entity') {
      // Always show the tooltip — non-focal entities get an explicit
      // "Centrar aquí" button instead of being refocused immediately on
      // click. Mirrors the doc-click pattern (which surfaces a "Desplegar"
      // confirmation button).
      this.showEntityTooltip(node);
    } else if (node.type === 'document') {
      this.showDocumentTooltip(node);
    }
  };

  // -----------------------------------------------------------------------
  // Entity tooltip
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.showEntityTooltip = function (node) {
    this.dismissTooltip();
    var tooltip = this.tooltipEl;
    if (!tooltip) return;

    var self = this;
    var typeLabel = entityColors[node.entity_type] || '#8B2942';
    var typeName = { person: 'Persona', corporate_body: 'Entidad corporativa', corporate: 'Entidad corporativa', family: 'Familia' };
    var isFocal = node.id === this.focalEntityCode;

    tooltip.innerHTML = '';

    var header = document.createElement('div');
    header.className = 'graph-tooltip-header';
    var badge = document.createElement('span');
    badge.className = 'entity-type-badge';
    badge.style.background = typeLabel;
    badge.style.color = '#fff';
    badge.textContent = typeName[node.entity_type] || node.entity_type || 'Entidad';
    header.appendChild(badge);
    tooltip.appendChild(header);

    var name = document.createElement('div');
    name.className = 'graph-tooltip-name';
    name.textContent = node.label || node.id;
    tooltip.appendChild(name);

    var ref = document.createElement('div');
    ref.className = 'graph-tooltip-ref';
    ref.textContent = node.id;
    tooltip.appendChild(ref);

    var meta = document.createElement('div');
    meta.className = 'graph-tooltip-meta';
    meta.textContent = (node.linked_count || '?') + ' documentos vinculados';
    tooltip.appendChild(meta);

    // For non-focal entities, surface a single explicit refocus action
    // (mirrors the doc-click "Desplegar" pattern). The focal entity
    // doesn't get this button — it's already the centre of the graph.
    if (!isFocal) {
      var actions = document.createElement('div');
      actions.className = 'graph-tooltip-actions';
      var refocusBtn = document.createElement('button');
      refocusBtn.type = 'button';
      refocusBtn.className = 'graph-tooltip-btn';
      refocusBtn.textContent = 'Seleccionar y desplegar v\u00EDnculos';
      refocusBtn.addEventListener('click', function () {
        self.refocusOn(node.id);
      });
      actions.appendChild(refocusBtn);
      tooltip.appendChild(actions);
    }

    this.positionTooltip(node);
    tooltip.style.display = 'block';
    this.selectedNode = node;
  };

  // -----------------------------------------------------------------------
  // Document tooltip
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.showDocumentTooltip = function (node) {
    this.dismissTooltip();
    var self = this;
    var tooltip = this.tooltipEl;
    if (!tooltip) return;

    // Match the entity-page tooltip pattern (entity.js):
    // - title is a link
    // - actions appended async after expandability is resolved via Pagefind
    var html = '';
    if (node.date_expression) {
      html += '<div class="graph-tooltip-date">' + escapeHtml(formatDate(node.date_expression)) + '</div>';
    }
    if (node.role) {
      html += '<div class="graph-tooltip-role">' + escapeHtml(roleLabels[node.role] || node.role) + '</div>';
    }
    html += '<div class="graph-tooltip-name"><a href="/descripcion/' + escapeHtml(node.reference_code) + '/" target="_blank">' + escapeHtml(node.title || node.reference_code) + '</a></div>';
    html += '<div class="graph-tooltip-ref">' + escapeHtml(node.reference_code) + '</div>';

    tooltip.innerHTML = html;
    this.positionTooltip(node);
    tooltip.style.display = 'block';
    this.selectedNode = node;

    if (node.expanded) return;

    // Resolve expandability lazily, then append the action button if any
    // new entities are reachable from this document.
    this.lookupDocEntities(node.reference_code).then(function (codes) {
      if (self.selectedNode !== node) return; // user moved on
      var newCodes = codes.filter(function (c) { return !self.graphNodes.has(c); });
      node.expandable = newCodes.length > 0;
      if (newCodes.length === 0) return;

      var actions = document.createElement('div');
      actions.className = 'graph-tooltip-actions';
      var span = document.createElement('span');
      span.textContent = 'Conectado a ' + newCodes.length + ' entidad' + (newCodes.length !== 1 ? 'es' : '') + ' m\u00e1s. ';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'graph-tooltip-btn';
      btn.textContent = 'Desplegar';
      btn.addEventListener('click', function () {
        btn.textContent = 'Cargando\u2026';
        btn.disabled = true;
        self.expandDocument(node);
      });
      actions.appendChild(span);
      actions.appendChild(btn);
      tooltip.appendChild(actions);
    });
  };

  // -----------------------------------------------------------------------
  // Lazy expandability lookup via Pagefind descriptions index
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.lookupDocEntities = async function (refCode) {
    if (this.expandableCache.has(refCode)) {
      return this.expandableCache.get(refCode);
    }
    if (!this.pagefindDesc) {
      try {
        this.pagefindDesc = await import('/pagefind/pagefind.js');
        await this.pagefindDesc.options({ basePath: '/pagefind/' });
        await this.pagefindDesc.init();
      } catch (e) {
        console.warn('[IBE] Pagefind descriptions load failed:', e);
        this.expandableCache.set(refCode, []);
        return [];
      }
    }
    try {
      var search = await this.pagefindDesc.search(refCode);
      for (var i = 0; i < search.results.length; i++) {
        var hit = await search.results[i].data();
        if (hit.meta && hit.meta.reference_code === refCode) {
          var codes = (hit.filters && hit.filters.entidad) || [];
          this.expandableCache.set(refCode, codes);
          return codes;
        }
      }
    } catch (e) {
      // fall through
    }
    this.expandableCache.set(refCode, []);
    return [];
  };

  // -----------------------------------------------------------------------
  // Tooltip positioning and dismissal
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.positionTooltip = function (node) {
    var tooltip = this.tooltipEl;
    if (!tooltip || !this.graphInstance || node.x === undefined) return;
    var coords = this.graphInstance.graph2ScreenCoords(node.x, node.y);
    tooltip.style.left = (coords.x + 12) + 'px';
    tooltip.style.top = (coords.y - 8) + 'px';
    tooltip.style.transform = 'translate(-50%, -100%)';
  };

  InfiniteBipartiteExplorer.prototype.updateTooltipPosition = function () {
    if (this.selectedNode && this.graphInstance) {
      this.positionTooltip(this.selectedNode);
    }
  };

  InfiniteBipartiteExplorer.prototype.dismissTooltip = function () {
    if (this.tooltipEl) {
      this.tooltipEl.style.display = 'none';
      this.tooltipEl.classList.remove('is-hover');
      this.tooltipEl.innerHTML = '';
    }
    this.selectedNode = null;
  };

  // -----------------------------------------------------------------------
  // Entity loading
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.loadEntity = async function (entityCode) {
    this.focalEntityCode = entityCode;

    // Fetch shard (cache-first)
    if (!this.shardCache.has(entityCode)) {
      try {
        var res = await fetch('/data/entity-links/' + entityCode + '.json');
        if (res.ok) {
          this.shardCache.set(entityCode, await res.json());
        } else {
          this.shardCache.set(entityCode, []);
        }
      } catch (e) {
        this.shardCache.set(entityCode, []);
      }
    }

    var shard = this.shardCache.get(entityCode) || [];

    // Focal entity: render all linked documents (matches entity detail page)
    var capped = shard.slice().sort(function (a, b) {
      var da = a.date_expression || '';
      var db = b.date_expression || '';
      return db.localeCompare(da);
    });

    // Entity node metadata
    var meta = await this.fetchEntityMeta(entityCode);
    var entityNode = {
      id: entityCode,
      type: 'entity',
      label: meta.label,
      entity_type: meta.entity_type,
      linked_count: shard.length
    };

    // Document nodes
    var self = this;
    var docNodes = capped.map(function (entry) {
      return {
        id: entry.reference_code,
        type: 'document',
        title: entry.title,
        date_expression: entry.date_expression,
        role: entry.role,
        reference_code: entry.reference_code,
        repository_code: entry.repository_code,
        expandable: undefined,  // resolved lazily on hover via Pagefind
        expanded: false
      };
    });

    var newNodes = [entityNode].concat(docNodes);
    var newEdges = capped.map(function (entry) {
      return { source: entityCode, target: entry.reference_code, role: entry.role };
    });

    this.addNodesToGraph(newNodes, newEdges, entityCode);
  };

  // -----------------------------------------------------------------------
  // Entity metadata fetch (with cache)
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.fetchEntityMeta = async function (entityCode) {
    if (this.entityMeta.has(entityCode)) {
      return this.entityMeta.get(entityCode);
    }

    var meta = { label: entityCode, entity_type: 'person', linked_count: 0 };

    try {
      var resp = await fetch('/' + entityCode + '/');
      if (resp.ok) {
        var html = await resp.text();
        var titleMatch = html.match(/<title>(.*?)\s*\|/);
        var typeMatch = html.match(/data-pagefind-meta="entity_type">([^<]+)/);
        var countMatch = html.match(/data-pagefind-meta="linked_count">([^<]+)/);
        if (titleMatch) meta.label = titleMatch[1].trim();
        if (typeMatch) meta.entity_type = typeMatch[1].trim();
        if (countMatch) meta.linked_count = parseInt(countMatch[1], 10) || 0;
      }
    } catch (e) {
      // use defaults
    }

    this.entityMeta.set(entityCode, meta);
    return meta;
  };

  // -----------------------------------------------------------------------
  // Incremental node addition (adapted from entity.js lines 716-760)
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.addNodesToGraph = function (newNodes, newEdges, anchorId) {
    var currentData = this.graphInstance.graphData();
    var existingNodeIds = new Set(currentData.nodes.map(function (n) { return n.id; }));
    var existingEdgeKeys = new Set(currentData.links.map(function (l) {
      var s = typeof l.source === 'object' ? l.source.id : l.source;
      var t = typeof l.target === 'object' ? l.target.id : l.target;
      return s + '→' + t;
    }));

    // Filter duplicates
    var filteredNodes = newNodes.filter(function (n) { return !existingNodeIds.has(n.id); });
    var filteredEdges = newEdges.filter(function (e) {
      var key = e.source + '→' + e.target;
      return !existingEdgeKeys.has(key);
    });

    // Position new nodes around the anchor on a ring whose radius scales
    // with node count, with a small jitter so coincident positions don't
    // deadlock the (deliberately weak) charge force.
    var anchor = currentData.nodes.find(function (n) { return n.id === anchorId; });
    if (anchor && filteredNodes.length > 0) {
      var n = filteredNodes.length;
      // ~12px arc-length per neighbour, with floor and ceiling
      var radius = Math.max(30, Math.min(260, (12 * n) / (2 * Math.PI) + 30));
      filteredNodes.forEach(function (node, i) {
        var angle = (2 * Math.PI * i) / n + (Math.random() - 0.5) * 0.2;
        var r = radius + (Math.random() - 0.5) * 10;
        node.x = anchor.x + r * Math.cos(angle);
        node.y = anchor.y + r * Math.sin(angle);
      });
    }

    // Update internal maps
    var self = this;
    filteredNodes.forEach(function (n) { self.graphNodes.set(n.id, n); });
    filteredEdges.forEach(function (e) { self.graphEdges.push(e); });

    this.graphInstance.graphData({
      nodes: currentData.nodes.concat(filteredNodes),
      links: currentData.links.concat(filteredEdges)
    });
    this.graphInstance.d3ReheatSimulation();
    this.rebuildAdjacency();

    // Eagerly resolve which of the new document nodes have further entity
    // links so they can render filled (expandable) vs hollow (leaf). This is
    // the same trick entity.js uses on the entity-detail page graph: a
    // sequential pass over Pagefind on the descriptions index. We only check
    // the freshly-added doc nodes whose expandability is still unknown so
    // each call is small and the WASM thread isn't held for long.
    var newDocNodes = filteredNodes.filter(function (n) {
      return n.type === 'document' && n.expandable === undefined;
    });
    if (newDocNodes.length > 0) this._preCheckExpandable(newDocNodes);
  };

  // -----------------------------------------------------------------------
  // Visible-viewport entity codes — used by the entity explorer's
  // "filter to graph viewport" toggle. Returns the set of entity codes
  // whose nodes currently render inside the canvas viewport rectangle.
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.getVisibleEntityCodes = function () {
    var codes = new Set();
    var bounds = this._getViewportBounds();
    if (!bounds) return codes;
    this.graphNodes.forEach(function (node, id) {
      if (node.type !== 'entity') return;
      if (node.x === undefined || node.y === undefined) return;
      if (node._visible === false) return;
      if (node.x >= bounds.minX && node.x <= bounds.maxX &&
          node.y >= bounds.minY && node.y <= bounds.maxY) {
        codes.add(id);
      }
    });
    return codes;
  };

  // Returns full entity records for nodes currently inside the viewport,
  // including label, type, and linked_count, so the explorer can render
  // result cards without going through Pagefind.
  InfiniteBipartiteExplorer.prototype.getVisibleEntities = function () {
    var entities = [];
    var bounds = this._getViewportBounds();
    if (!bounds) return entities;
    var self = this;
    this.graphNodes.forEach(function (node, id) {
      if (node.type !== 'entity') return;
      if (node.x === undefined || node.y === undefined) return;
      if (node._visible === false) return;
      if (node.x >= bounds.minX && node.x <= bounds.maxX &&
          node.y >= bounds.minY && node.y <= bounds.maxY) {
        var meta = self.entityMeta.get(id) || {};
        entities.push({
          entity_code: id,
          label: node.label || meta.label || id,
          entity_type: node.entity_type || meta.entity_type || 'person',
          linked_count: node.linked_count || meta.linked_count || 0
        });
      }
    });
    return entities;
  };

  InfiniteBipartiteExplorer.prototype._getViewportBounds = function () {
    if (!this.graphInstance) return null;
    var rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    var topLeft, bottomRight;
    try {
      topLeft = this.graphInstance.screen2GraphCoords(0, 0);
      bottomRight = this.graphInstance.screen2GraphCoords(rect.width, rect.height);
    } catch (e) {
      return null;
    }
    return {
      minX: Math.min(topLeft.x, bottomRight.x),
      maxX: Math.max(topLeft.x, bottomRight.x),
      minY: Math.min(topLeft.y, bottomRight.y),
      maxY: Math.max(topLeft.y, bottomRight.y)
    };
  };

  // -----------------------------------------------------------------------
  // Eager expandability resolution (ported from entity.js preCheckExpandable)
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype._preCheckExpandable = async function (docNodes) {
    var self = this;
    if (!this.pagefindDesc) {
      try {
        this.pagefindDesc = await import('/pagefind/pagefind.js');
        await this.pagefindDesc.options({ basePath: '/pagefind/' });
        await this.pagefindDesc.init();
      } catch (e) {
        // If Pagefind can't load, leave nodes as undefined → render hollow
        return;
      }
    }

    var dirty = false;
    for (var i = 0; i < docNodes.length; i++) {
      var node = docNodes[i];
      // The user may have refocused while we were resolving — abandon
      // expandability checks for nodes that have since been pruned.
      if (!self.graphNodes.has(node.id)) continue;
      try {
        var search = await this.pagefindDesc.search(node.reference_code);
        var resolved = false;
        for (var si = 0; si < search.results.length; si++) {
          var hit = await search.results[si].data();
          if (hit.meta && hit.meta.reference_code === node.reference_code) {
            var codes = (hit.filters && hit.filters.entidad) || [];
            // Cache for the lazy hover lookup so we don't re-fetch
            self.expandableCache.set(node.reference_code, codes);
            // Expandable iff at least one linked entity is not yet in graph
            node.expandable = false;
            for (var j = 0; j < codes.length; j++) {
              if (!self.graphNodes.has(codes[j])) { node.expandable = true; break; }
            }
            resolved = true;
            dirty = true;
            break;
          }
        }
        if (!resolved) node.expandable = false;
      } catch (e) {
        node.expandable = false;
      }
    }
    if (dirty) this._redraw();
  };

  // -----------------------------------------------------------------------
  // Adjacency rebuild
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.rebuildAdjacency = function () {
    var nodeNeighbours = new Map();
    var nodeLinks = new Map();

    var data = this.graphInstance.graphData();
    data.links.forEach(function (l) {
      var s = typeof l.source === 'object' ? l.source.id : l.source;
      var t = typeof l.target === 'object' ? l.target.id : l.target;

      if (!nodeNeighbours.has(s)) nodeNeighbours.set(s, new Set());
      if (!nodeNeighbours.has(t)) nodeNeighbours.set(t, new Set());
      nodeNeighbours.get(s).add(t);
      nodeNeighbours.get(t).add(s);

      if (!nodeLinks.has(s)) nodeLinks.set(s, new Set());
      if (!nodeLinks.has(t)) nodeLinks.set(t, new Set());
      nodeLinks.get(s).add(l);
      nodeLinks.get(t).add(l);
    });

    this.nodeNeighbours = nodeNeighbours;
    this.nodeLinks = nodeLinks;
  };

  // -----------------------------------------------------------------------
  // Legend rendering
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.renderLegend = function () {
    var el = this.legendEl;
    if (!el) return;

    el.innerHTML = [
      legendItem('#8B2942', 'filled', 'Persona'),
      legendItem('#6666BB', 'filled', 'Corporaci\u00f3n / Familia'),
      legendItem(DOC_COLOR, 'filled', 'Documento (expandible)'),
      legendItem(DOC_COLOR, 'hollow', 'Documento')
    ].join('');

    function legendItem(color, style, label) {
      var dotStyle;
      if (style === 'hollow') {
        dotStyle = 'background:transparent;border:1.5px solid ' + color + ';';
      } else {
        dotStyle = 'background:' + color + ';';
      }
      return '<span class="graph-legend-item">'
        + '<span class="graph-legend-dot" style="' + dotStyle + '"></span>'
        + '<span>' + label + '</span>'
        + '</span>';
    }
  };

  // -----------------------------------------------------------------------
  // Date formatter (replicated from entity.js lines 842-869)
  // -----------------------------------------------------------------------

  function formatDate(dateStr) {
    if (!dateStr) return '';

    var months = [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
    ];

    if (dateStr.indexOf(' .. ') !== -1) {
      var parts = dateStr.split(' .. ');
      return formatDate(parts[0]) + ' \u2013 ' + formatDate(parts[1]);
    }

    var match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      var day = parseInt(match[3], 10);
      var month = months[parseInt(match[2], 10) - 1];
      return day + ' de ' + month + ' de ' + match[1];
    }

    var ymMatch = dateStr.match(/^(\d{4})-(\d{2})$/);
    if (ymMatch) {
      var m = months[parseInt(ymMatch[2], 10) - 1];
      return m + ' de ' + ymMatch[1];
    }

    return dateStr;
  }

  // -----------------------------------------------------------------------
  // HTML escape helper
  // -----------------------------------------------------------------------

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // -----------------------------------------------------------------------
  // Expand document — load entity connections
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.expandDocument = async function (node) {
    this.dismissTooltip();

    // Lazy lookup via Pagefind descriptions index — no upfront 5.7 MB fetch
    var entityCodes = await this.lookupDocEntities(node.reference_code);
    // Filter out entities already in the graph
    var self0 = this;
    var newCodes = entityCodes.filter(function (c) { return !self0.graphNodes.has(c); });

    if (newCodes.length === 0) {
      // Mark as expanded even if no new entities — all connections already loaded
      node.expanded = true;
      this._redraw();
      return;
    }

    // No cap — expand all connected entities (the explorer is infinite by name)

    // Batch-fetch entity metadata via Promise.all (pattern from entity.js lines 669-684)
    var self = this;
    var metaResults = await Promise.all(newCodes.map(function (code) {
      return self.fetchEntityMeta(code);
    }));

    var newEntityNodes = newCodes.map(function (code, i) {
      var meta = metaResults[i];
      return {
        id: code,
        type: 'entity',
        label: meta.label,
        entity_type: meta.entity_type,
        linked_count: meta.linked_count
      };
    });

    var newEdges = newCodes.map(function (code) {
      return { source: node.reference_code, target: code, role: '' };
    });

    // Mark document as expanded
    node.expanded = true;

    this.addNodesToGraph(newEntityNodes, newEdges, node.id);
    this.computeHopDistances();

    if (this.onEntityFocused) {
      this.onEntityFocused(
        this.focalEntityCode,
        this.entityMeta.get(this.focalEntityCode) || null,
        this.shardCache.get(this.focalEntityCode) || []
      );
    }
  };

  // -----------------------------------------------------------------------
  // Refocus on a new entity
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.refocusOn = async function (entityCode) {
    this.dismissTooltip();
    this.focalEntityCode = entityCode;

    // Prune distant nodes first
    this.pruneDistantNodes(entityCode);

    // Fetch shard (cache-first)
    if (!this.shardCache.has(entityCode)) {
      try {
        var res = await fetch('/data/entity-links/' + entityCode + '.json');
        if (res.ok) {
          this.shardCache.set(entityCode, await res.json());
        } else {
          this.shardCache.set(entityCode, []);
        }
      } catch (e) {
        this.shardCache.set(entityCode, []);
      }
    }

    var shard = this.shardCache.get(entityCode) || [];
    // Focal entity: render all linked documents (matches entity detail page)
    var capped = shard.slice().sort(function (a, b) {
      var da = a.date_expression || '';
      var db = b.date_expression || '';
      return db.localeCompare(da);
    });

    // Ensure entity node exists (may not if it was pruned as too distant)
    if (!this.graphNodes.has(entityCode)) {
      var meta = await this.fetchEntityMeta(entityCode);
      var entityNodeForRefocus = {
        id: entityCode,
        type: 'entity',
        label: meta.label,
        entity_type: meta.entity_type,
        linked_count: shard.length
      };
      this.addNodesToGraph([entityNodeForRefocus], [], entityCode);
    } else {
      // Update linked_count on existing node
      var existingNode = this.graphNodes.get(entityCode);
      existingNode.linked_count = shard.length;
    }

    var self = this;
    var docNodes = capped.map(function (entry) {
      return {
        id: entry.reference_code,
        type: 'document',
        title: entry.title,
        date_expression: entry.date_expression,
        role: entry.role,
        reference_code: entry.reference_code,
        repository_code: entry.repository_code,
        expandable: undefined,  // resolved lazily on hover
        expanded: false
      };
    });

    var docEdges = capped.map(function (entry) {
      return { source: entityCode, target: entry.reference_code, role: entry.role };
    });

    this.addNodesToGraph(docNodes, docEdges, entityCode);
    this.computeHopDistances();

    // Update URL
    history.pushState({ entidad: entityCode }, '', '?entidad=' + entityCode);

    // Pan to entity node
    var node = this.graphNodes.get(entityCode);
    if (node && node.x !== undefined && this.graphInstance) {
      this.graphInstance.centerAt(node.x, node.y, 400);
    }

    // Reset focal-card role filter on focal change
    this.focalRoleFilter = new Set();

    // Fire callback for sidebar sync
    if (this.onEntityFocused) {
      var entityMeta = this.entityMeta.get(entityCode) || { label: entityCode, entity_type: 'person', linked_count: shard.length };
      this.onEntityFocused(entityCode, entityMeta, shard);
    }
  };

  // -----------------------------------------------------------------------
  // Prune nodes > MAX_HOPS from new focal
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.pruneDistantNodes = function (focalId) {
    this.computeHopDistances(focalId);

    var self = this;
    var toRemove = new Set();

    this.graphNodes.forEach(function (node, id) {
      var hop = self.hopDistance.get(id);
      if (hop === undefined || hop > MAX_HOPS) {
        toRemove.add(id);
      }
    });

    // Also remove overflow nodes whose parent entity is pruned
    this.graphNodes.forEach(function (node, id) {
      if (node.type === 'overflow' && toRemove.has(node.parentEntityCode)) {
        toRemove.add(id);
      }
    });

    if (toRemove.size === 0) return;

    // Reset the `expanded` flag on any surviving doc nodes whose connected
    // entities are about to be removed — otherwise, if the user navigates
    // back to such a doc later, the tooltip thinks it's already fully
    // expanded and won't offer to re-fetch its entities.
    this.graphNodes.forEach(function (node) {
      if (node.type !== 'document' || !node.expanded) return;
      var neighbours = self.nodeNeighbours.get(node.id) || new Set();
      var lostAnEntity = false;
      neighbours.forEach(function (nid) {
        if (toRemove.has(nid)) {
          var n = self.graphNodes.get(nid);
          if (n && n.type === 'entity') lostAnEntity = true;
        }
      });
      if (lostAnEntity) {
        node.expanded = false;
        node.expandable = undefined; // force re-resolve on next hover
      }
    });

    // Remove from internal maps
    toRemove.forEach(function (id) { self.graphNodes.delete(id); });
    this.graphEdges = this.graphEdges.filter(function (e) {
      return !toRemove.has(e.source) && !toRemove.has(e.target);
    });

    // Remove from graphInstance
    var current = this.graphInstance.graphData();
    this.graphInstance.graphData({
      nodes: current.nodes.filter(function (n) { return !toRemove.has(n.id); }),
      links: current.links.filter(function (l) {
        var s = typeof l.source === 'object' ? l.source.id : l.source;
        var t = typeof l.target === 'object' ? l.target.id : l.target;
        return !toRemove.has(s) && !toRemove.has(t);
      })
    });

    this.graphInstance.d3ReheatSimulation();
    this.rebuildAdjacency();
  };

  // -----------------------------------------------------------------------
  // BFS hop-distance computation
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.computeHopDistances = function (focalId) {
    var startId = focalId || this.focalEntityCode;
    if (!startId) return;

    var hopMap = new Map();
    hopMap.set(startId, 0);
    var queue = [startId];

    while (queue.length) {
      var curr = queue.shift();
      var currHop = hopMap.get(curr);
      var neighbours = this.nodeNeighbours.get(curr) || new Set();
      neighbours.forEach(function (nb) {
        if (!hopMap.has(nb)) {
          hopMap.set(nb, currHop + 1);
          queue.push(nb);
        }
      });
    }

    this.hopDistance = hopMap;
  };

  // -----------------------------------------------------------------------
  // Load more docs from overflow
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.loadMoreDocs = function (overflowNode) {
    var shard = this.shardCache.get(overflowNode.parentEntityCode) || [];
    var sorted = shard.slice().sort(function (a, b) {
      var da = a.date_expression || '';
      var db = b.date_expression || '';
      return db.localeCompare(da);
    });

    var batch = sorted.slice(overflowNode.nextBatchOffset, overflowNode.nextBatchOffset + MAX_INITIAL_DOCS);
    if (batch.length === 0) return;

    var self = this;
    var entityCode = overflowNode.parentEntityCode;

    var newDocNodes = batch.map(function (entry) {
      return {
        id: entry.reference_code,
        type: 'document',
        title: entry.title,
        date_expression: entry.date_expression,
        role: entry.role,
        reference_code: entry.reference_code,
        repository_code: entry.repository_code,
        expandable: undefined,  // resolved lazily on hover
        expanded: false
      };
    });

    var newDocEdges = batch.map(function (entry) {
      return { source: entityCode, target: entry.reference_code, role: entry.role };
    });

    // Update overflow node state
    overflowNode.nextBatchOffset += batch.length;
    overflowNode.hiddenCount -= batch.length;

    if (overflowNode.hiddenCount <= 0) {
      // Remove the overflow node from the graph
      this.graphNodes.delete(overflowNode.id);
      this.graphEdges = this.graphEdges.filter(function (e) {
        return e.source !== overflowNode.id && e.target !== overflowNode.id;
      });
      var current = this.graphInstance.graphData();
      this.graphInstance.graphData({
        nodes: current.nodes.filter(function (n) { return n.id !== overflowNode.id; }),
        links: current.links.filter(function (l) {
          var s = typeof l.source === 'object' ? l.source.id : l.source;
          var t = typeof l.target === 'object' ? l.target.id : l.target;
          return s !== overflowNode.id && t !== overflowNode.id;
        })
      });
    } else {
      overflowNode.label = '+' + overflowNode.hiddenCount + ' documentos';
      this._redraw();
    }

    this.addNodesToGraph(newDocNodes, newDocEdges, entityCode);
    this.computeHopDistances();
  };

  // -----------------------------------------------------------------------
  // Filter application
  // -----------------------------------------------------------------------

  // Sidebar filters: entity-type / search-query (no longer roles — role
  // is per-document and lives on the focal-card filter instead).
  InfiniteBipartiteExplorer.prototype.applyFilters = function (filters) {
    this._lastSidebarFilters = filters || null;
    this._recomputeVisibility();
  };

  // Focal-card filter: which roles (relative to the focal entity) should
  // restrict visible focal docs. Empty set = no restriction.
  InfiniteBipartiteExplorer.prototype.setFocalRoleFilter = function (rolesSet) {
    this.focalRoleFilter = rolesSet instanceof Set ? rolesSet : new Set();
    this._recomputeVisibility();
  };

  InfiniteBipartiteExplorer.prototype._recomputeVisibility = function () {
    var filters = this._lastSidebarFilters || {};
    var hasTypes = filters.entityTypes && filters.entityTypes.size > 0;
    var hasQuery = filters.searchQuery && filters.searchQuery.trim().length > 0;
    var query = hasQuery ? filters.searchQuery.trim().toLowerCase() : '';
    var focalRoles = this.focalRoleFilter || new Set();
    var hasFocalRoles = focalRoles.size > 0;
    var focalCode = this.focalEntityCode;

    var self = this;

    // First pass: entity nodes
    this.graphNodes.forEach(function (node) {
      if (node.type === 'overflow') {
        node._visible = true;
        return;
      }
      if (node.type === 'entity') {
        var visible = true;

        if (hasTypes && !filters.entityTypes.has(node.entity_type)) {
          visible = false;
        }

        if (visible && hasQuery) {
          var label = (node.label || '').toLowerCase();
          if (label.indexOf(query) === -1 && node.id.indexOf(query) === -1) {
            visible = false;
          }
        }

        node._visible = visible;
      }
    });

    // Build a quick lookup for focal-edge roles per doc
    // (only if focal-role filter active)
    var focalDocRoles = null;
    if (hasFocalRoles && focalCode && this.graphInstance) {
      focalDocRoles = new Map(); // docId -> Set<role>
      var data = this.graphInstance.graphData();
      data.links.forEach(function (l) {
        var s = typeof l.source === 'object' ? l.source.id : l.source;
        var t = typeof l.target === 'object' ? l.target.id : l.target;
        var docId = null;
        if (s === focalCode) docId = t;
        else if (t === focalCode) docId = s;
        if (!docId) return;
        var n = self.graphNodes.get(docId);
        if (!n || n.type !== 'document') return;
        if (!focalDocRoles.has(docId)) focalDocRoles.set(docId, new Set());
        focalDocRoles.get(docId).add(l.role);
      });
    }

    // Second pass: document nodes
    this.graphNodes.forEach(function (node) {
      if (node.type !== 'document') return;

      // Focal-role filter: doc connected to focal must have at least one
      // matching role on its focal edges. Docs not connected to focal are
      // unaffected by this filter.
      if (hasFocalRoles && focalDocRoles && focalDocRoles.has(node.id)) {
        var roles = focalDocRoles.get(node.id);
        var anyMatch = false;
        roles.forEach(function (r) { if (focalRoles.has(r)) anyMatch = true; });
        if (!anyMatch) {
          node._visible = false;
          return;
        }
      }

      // Standard rule: doc visible if at least one connected entity is visible
      var neighbours = self.nodeNeighbours.get(node.id) || new Set();
      var anyVisible = false;
      neighbours.forEach(function (nid) {
        var n = self.graphNodes.get(nid);
        if (n && n.type === 'entity' && n._visible !== false) anyVisible = true;
      });
      node._visible = anyVisible;
    });

    this._redraw();
    if (this.graphInstance) this.graphInstance.d3ReheatSimulation();

    // Notify observers whether the focal entity is currently included
    // in the filtered set so the right-column card can shade itself.
    if (typeof this.onFocalVisibilityChanged === 'function' && this.focalEntityCode) {
      var focal = this.graphNodes.get(this.focalEntityCode);
      this.onFocalVisibilityChanged(focal ? focal._visible !== false : true);
    }
  };

  // -----------------------------------------------------------------------
  // Clear all filters
  // -----------------------------------------------------------------------

  InfiniteBipartiteExplorer.prototype.clearFilters = function () {
    this.graphNodes.forEach(function (node) {
      node._visible = true;
    });
    this._redraw();
    if (this.graphInstance) this.graphInstance.d3ReheatSimulation();
    if (typeof this.onFocalVisibilityChanged === 'function') {
      this.onFocalVisibilityChanged(true);
    }
  };

  // -----------------------------------------------------------------------
  // Expose globally
  // -----------------------------------------------------------------------

  window.InfiniteBipartiteExplorer = InfiniteBipartiteExplorer;

})();
