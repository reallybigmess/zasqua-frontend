/**
 * Entity Detail Page Behaviours
 *
 * Powers the interactive surfaces on a single entity authority page.
 * The template (`entidad.njk`) lays out the metadata column and an
 * aside with a segmented Timeline/Network-graph toggle; this module
 * fetches the entity's link shard from `/data/entity-links/` and
 * renders both views from it.
 *
 * Timeline view groups the entity's document appearances into a
 * chronological stack, with undated items grouped under "Sin fecha"
 * at the bottom. Each entry shows the document title, date, role
 * badges, and a link to the description page. A role-filter pill row
 * above the list narrows the stack to the roles the visitor cares
 * about — producer, scribe, witness, defendant, and so on. Roles are
 * bucketed into seven high-level groups (production, correspondence,
 * notarial, legal, family, transactions, visual) so the filter row
 * stays legible even for entities with dozens of roles.
 *
 * Graph view renders a small force-directed graph of the documents
 * the entity touches and the other entities those documents connect
 * to, so the visitor can see the entity's local network at a glance.
 * Graph rendering uses force-graph (loaded from a CDN as a global),
 * sharing the same visual vocabulary as the infinite bipartite
 * explorer on `/entidades/`.
 *
 * A copy-to-clipboard helper handles the EAC-CPF reuse block at the
 * bottom of the metadata column.
 *
 * @version v0.5.0
 */

// Role labels in Spanish
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

// Entity colours by type (shared with graph)
var entityColors = {
  person: '#8B2942',
  corporate_body: '#6666BB',
  corporate: '#6666BB',
  family: '#6666BB'
};

// Role groups for accordion filter (7-group taxonomy)
var roleGroups = [
  { id: 'production', label_es: 'Producción y menciones', members: ['creator', 'author', 'editor', 'publisher', 'mentioned', 'subject', 'official'] },
  { id: 'correspondence', label_es: 'Correspondencia', members: ['sender', 'recipient'] },
  { id: 'notarial', label_es: 'Atestación notarial', members: ['scribe', 'witness', 'notary'] },
  { id: 'legal', label_es: 'Procesos judiciales', members: ['plaintiff', 'defendant', 'petitioner', 'judge', 'appellant', 'fiador', 'apoderado', 'victim'] },
  { id: 'family', label_es: 'Familia y sucesión', members: ['heir', 'albacea', 'spouse'] },
  { id: 'transactions', label_es: 'Transacciones', members: ['grantor', 'donor', 'seller', 'buyer', 'mortgagor', 'mortgagee', 'creditor', 'debtor'] },
  { id: 'visual', label_es: 'Materiales visuales', members: ['photographer', 'artist'] }
];

// All known grouped role values (for detecting ungrouped/legacy roles)
var groupedRoles = new Set();
for (var _gi = 0; _gi < roleGroups.length; _gi++) {
  for (var _mi = 0; _mi < roleGroups[_gi].members.length; _mi++) {
    groupedRoles.add(roleGroups[_gi].members[_mi]);
  }
}

document.addEventListener('DOMContentLoaded', async function() {
  var timelineEl = document.getElementById('entity-timeline');
  if (!timelineEl) return;

  var entityCode = timelineEl.dataset.entityCode;
  if (!entityCode) return;

  var links;
  try {
    var res = await fetch('/data/entity-links/' + entityCode + '.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    links = await res.json();
  } catch (err) {
    console.error('[entity] Failed to load shard:', err);
    timelineEl.innerHTML = '<p class="text-stone-500 text-sm">No se pudieron cargar las descripciones vinculadas. Intente recargar la página.</p>';
    return;
  }

  // State
  var activeRoles = new Set();
  var currentView = 'timeline';
  var graphInstance = null;

  // Initial render
  renderTimeline(timelineEl, links, activeRoles);
  buildIntro(links);
  buildRoleFilters(links);
  wireToggleButtons();

  // Auto-switch to graph if ?vista=red
  if (new URLSearchParams(window.location.search).get('vista') === 'red') {
    setTimeout(function() { switchView('graph'); }, 0);
  }

  // --- Intro sentence with view links ---

  function buildIntro(allLinks) {
    var introEl = document.getElementById('entity-intro');
    if (!introEl) return;

    var entityType = (introEl.dataset.entityType || 'entidad').toLowerCase();
    var code = introEl.dataset.entityCode;
    var count = allLinks.length;

    var text = 'Esta ' + escapeHtml(entityType) + ' aparece vinculada a <strong>' +
      count.toLocaleString('es-CO') + ' descripciones</strong> en el archivo.<br>Ver como ';

    introEl.innerHTML = text;

    // "una línea de tiempo" link
    var tlLink = document.createElement('button');
    tlLink.type = 'button';
    tlLink.className = 'entity-view-link active';
    tlLink.textContent = 'una línea de tiempo';
    tlLink.dataset.view = 'timeline';
    tlLink.addEventListener('click', function() { switchView('timeline'); });
    introEl.appendChild(tlLink);

    introEl.appendChild(document.createTextNode(', '));

    // "una red" link
    var graphLink = document.createElement('button');
    graphLink.type = 'button';
    graphLink.className = 'entity-view-link';
    graphLink.textContent = 'una red';
    graphLink.dataset.view = 'graph';
    graphLink.addEventListener('click', function() { switchView('graph'); });
    introEl.appendChild(graphLink);

    introEl.appendChild(document.createTextNode(' o '));

    // "un filtro en el sistema de búsquedas" link
    var searchLink = document.createElement('a');
    searchLink.className = 'entity-view-link';
    searchLink.href = '/buscar/?entidad=' + encodeURIComponent(code);
    searchLink.textContent = 'un filtro en el sistema de búsquedas';
    introEl.appendChild(searchLink);

    introEl.appendChild(document.createTextNode(' de Zasqua.'));
  }

  // --- Segmented control ---

  function wireToggleButtons() {
    var toggleEl = document.getElementById('entity-view-toggle');
    if (!toggleEl) return;
    var btns = toggleEl.querySelectorAll('.entity-toggle-btn');
    btns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        switchView(btn.dataset.view);
      });
    });
  }

  function switchView(view) {
    if (view === currentView) return;
    currentView = view;

    // Update prose link styles
    var viewLinks = document.querySelectorAll('.entity-view-link[data-view]');
    viewLinks.forEach(function(link) {
      link.classList.toggle('active', link.dataset.view === view);
    });

    // Update segmented control styles
    var toggleBtns = document.querySelectorAll('.entity-toggle-btn[data-view]');
    toggleBtns.forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    var timelineFrame = document.getElementById('entity-timeline-frame');
    var graphFrame = document.getElementById('entity-graph-frame');

    if (view === 'timeline') {
      timelineFrame.style.display = '';
      graphFrame.style.display = 'none';
      renderTimeline(timelineEl, links, activeRoles);
    } else {
      timelineFrame.style.display = 'none';
      graphFrame.style.display = '';
      renderGraph(links, activeRoles);
    }
  }

  // --- Role filters (collapsible 7-group accordion) ---

  function buildRoleFilters(allLinks) {
    var filtersEl = document.getElementById('entity-role-filters');
    if (!filtersEl) return;

    // Count roles from all links
    var roleCounts = {};
    for (var i = 0; i < allLinks.length; i++) {
      var r = (allLinks[i].role || '').toLowerCase();
      if (!r) continue;
      roleCounts[r] = (roleCounts[r] || 0) + 1;
    }

    // Build visible groups (only those with at least one role present in data)
    var visibleGroups = [];
    for (var gi = 0; gi < roleGroups.length; gi++) {
      var group = roleGroups[gi];
      var members = [];
      for (var mi = 0; mi < group.members.length; mi++) {
        var role = group.members[mi];
        if (roleCounts[role] > 0) {
          members.push({ role: role, count: roleCounts[role] });
        }
      }
      if (members.length === 0) continue;
      members.sort(function(a, b) { return b.count - a.count; });
      var total = 0;
      for (var ti = 0; ti < members.length; ti++) total += members[ti].count;
      visibleGroups.push({ id: group.id, label_es: group.label_es, members: members, total: total });
    }

    // Collect ungrouped roles (present in data but not in any group)
    var otrosMembers = [];
    var allRoles = Object.keys(roleCounts);
    for (var oi = 0; oi < allRoles.length; oi++) {
      var or_ = allRoles[oi];
      if (!groupedRoles.has(or_) && roleCounts[or_] > 0) {
        otrosMembers.push({ role: or_, count: roleCounts[or_] });
      }
    }
    if (otrosMembers.length > 0) {
      otrosMembers.sort(function(a, b) { return b.count - a.count; });
      var otrosTotal = 0;
      for (var oti = 0; oti < otrosMembers.length; oti++) otrosTotal += otrosMembers[oti].count;
      visibleGroups.push({ id: 'otros', label_es: 'Otros', members: otrosMembers, total: otrosTotal });
    }

    if (visibleGroups.length === 0) { filtersEl.innerHTML = ''; return; }

    var wrap = document.createElement('div');
    wrap.className = 'focal-role-facet';

    // Header with title and clear button
    var header = document.createElement('div');
    header.className = 'focal-role-facet-header';

    var title = document.createElement('span');
    title.className = 'focal-role-facet-title';
    title.textContent = 'Filtrar por rol';
    header.appendChild(title);

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'focal-role-facet-clear';
    clearBtn.textContent = 'Limpiar';
    clearBtn.style.display = activeRoles.size > 0 ? '' : 'none';
    clearBtn.addEventListener('click', function() {
      activeRoles = new Set();
      applyFilters();
      buildRoleFilters(allLinks);
    });
    header.appendChild(clearBtn);
    wrap.appendChild(header);

    // Build each group
    for (var vgi = 0; vgi < visibleGroups.length; vgi++) {
      (function(grp) {
        var groupEl = document.createElement('div');
        groupEl.className = 'focal-role-group';

        var groupHeader = document.createElement('div');
        groupHeader.className = 'focal-role-group-header';

        // Group-level checkbox: tri-state (all/some/none)
        var allChecked = grp.members.every(function(m) { return activeRoles.has(m.role); });
        var someChecked = grp.members.some(function(m) { return activeRoles.has(m.role); });

        var groupCheckbox = document.createElement('input');
        groupCheckbox.type = 'checkbox';
        groupCheckbox.className = 'focal-role-group-checkbox';
        groupCheckbox.checked = allChecked;
        groupCheckbox.indeterminate = someChecked && !allChecked;
        groupCheckbox.addEventListener('click', function(e) { e.stopPropagation(); });
        groupCheckbox.addEventListener('change', function() {
          if (groupCheckbox.checked) {
            for (var ci = 0; ci < grp.members.length; ci++) activeRoles.add(grp.members[ci].role);
          } else {
            for (var ci = 0; ci < grp.members.length; ci++) activeRoles.delete(grp.members[ci].role);
          }
          applyFilters();
          buildRoleFilters(allLinks);
        });
        groupHeader.appendChild(groupCheckbox);

        var groupLabel = document.createElement('span');
        groupLabel.className = 'focal-role-group-label';
        groupLabel.textContent = grp.label_es;
        groupHeader.appendChild(groupLabel);

        var groupCount = document.createElement('span');
        groupCount.className = 'focal-role-group-count';
        groupCount.textContent = '(' + grp.total.toLocaleString('es-CO') + ')';
        groupHeader.appendChild(groupCount);

        var chevron = document.createElement('span');
        chevron.className = 'focal-role-group-chevron';
        // Expand group if any of its members are active
        var expanded = someChecked;
        chevron.textContent = expanded ? '\u2212' : '+';
        groupHeader.appendChild(chevron);

        // Toggle expand/collapse on header click
        groupHeader.addEventListener('click', function() {
          var isExpanded = groupEl.classList.toggle('is-expanded');
          chevron.textContent = isExpanded ? '\u2212' : '+';
        });

        // All groups collapsed on load, unless a member is active
        if (expanded) groupEl.classList.add('is-expanded');

        groupEl.appendChild(groupHeader);

        // Member checkboxes
        var memberList = document.createElement('div');
        memberList.className = 'focal-role-group-members';
        for (var mbi = 0; mbi < grp.members.length; mbi++) {
          (function(m) {
            var optLabel = document.createElement('label');
            optLabel.className = 'focal-role-option';

            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = m.role;
            cb.checked = activeRoles.has(m.role);
            cb.addEventListener('change', function() {
              if (cb.checked) {
                activeRoles.add(m.role);
              } else {
                activeRoles.delete(m.role);
              }
              applyFilters();
              buildRoleFilters(allLinks);
            });
            optLabel.appendChild(cb);

            var text = document.createElement('span');
            text.className = 'focal-role-option-label';
            text.textContent = roleLabels[m.role] || m.role;
            optLabel.appendChild(text);

            var cnt = document.createElement('span');
            cnt.className = 'focal-role-option-count';
            cnt.textContent = '(' + m.count.toLocaleString('es-CO') + ')';
            optLabel.appendChild(cnt);

            memberList.appendChild(optLabel);
          })(grp.members[mbi]);
        }
        groupEl.appendChild(memberList);

        wrap.appendChild(groupEl);
      })(visibleGroups[vgi]);
    }

    filtersEl.innerHTML = '';
    filtersEl.appendChild(wrap);
  }

  function applyFilters() {
    if (currentView === 'timeline') {
      renderTimeline(timelineEl, links, activeRoles);
    } else {
      renderGraph(links, activeRoles);
    }
  }

  // --- Graph view ---

  // Graph state persists across re-renders
  var graphNodes = new Map();  // id → node object
  var graphEdges = [];         // { source, target, role }
  var nodeNeighbours = new Map();  // id → Set of neighbour ids
  var nodeLinks = new Map();       // id → Set of link objects
  var pagefindDesc = null;     // Pagefind descriptions instance (loaded once)
  var pagefindEntity = null;   // Pagefind entities instance (loaded once)
  var shardCache = new Map();  // entity_code → links array
  var activeTooltip = null;    // current tooltip element
  var tooltipNode = null;      // node the tooltip is attached to

  function renderGraph(allLinks, activeFilters) {
    var canvas = document.getElementById('entity-graph-canvas');
    if (!canvas) return;

    var filtered = filterLinks(allLinks, activeFilters);

    if (filtered.length === 0) {
      canvas.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#78716c;font-size:0.875rem">Sin descripciones para mostrar</div>';
      if (graphInstance) { graphInstance._destructor && graphInstance._destructor(); graphInstance = null; }
      return;
    }

    // Reset graph data
    graphNodes.clear();
    graphEdges = [];

    // Central entity node
    var entityTypeEl = document.querySelector('.level-badge');
    var eType = entityTypeEl ? entityTypeEl.textContent.trim().toLowerCase() : 'person';
    var entityNameEl = document.querySelector('.detail-title');
    var TYPE_MAP = { 'persona': 'person', 'institución': 'corporate_body', 'entidad corporativa': 'corporate_body', 'familia': 'family' };
    var mappedType = TYPE_MAP[eType] || 'person';

    graphNodes.set(entityCode, {
      id: entityCode,
      type: 'entity',
      label: entityNameEl ? entityNameEl.textContent.trim() : entityCode,
      entityType: mappedType,
      color: entityColors[mappedType] || entityColors.person
    });

    // Document nodes from this entity's links
    for (var i = 0; i < filtered.length; i++) {
      var link = filtered[i];
      if (!graphNodes.has(link.reference_code)) {
        graphNodes.set(link.reference_code, {
          id: link.reference_code,
          type: 'document',
          label: link.title,
          date: link.date_expression || '',
          role: link.role || '',
          expandable: null,  // null = unchecked, true/false after lookup
          color: '#A09888'
        });
      }
      graphEdges.push({ source: entityCode, target: link.reference_code, role: link.role });
    }

    rebuildForceGraph(canvas);
  }

  function rebuildAdjacency() {
    nodeNeighbours.clear();
    nodeLinks.clear();
    for (var i = 0; i < graphEdges.length; i++) {
      var edge = graphEdges[i];
      for (var nid of [edge.source, edge.target]) {
        if (!nodeNeighbours.has(nid)) nodeNeighbours.set(nid, new Set());
        if (!nodeLinks.has(nid)) nodeLinks.set(nid, new Set());
      }
      nodeNeighbours.get(edge.source).add(edge.target);
      nodeNeighbours.get(edge.target).add(edge.source);
      nodeLinks.get(edge.source).add(edge);
      nodeLinks.get(edge.target).add(edge);
    }
  }

  function rebuildForceGraph(canvas) {
    canvas.innerHTML = '';

    var nodes = Array.from(graphNodes.values());
    var edges = graphEdges.map(function(e) { return Object.assign({}, e); });

    rebuildAdjacency();

    var highlightedNodes = new Set();
    var highlightedLinks = new Set();

    if (graphInstance) { graphInstance._destructor && graphInstance._destructor(); }

    var width = canvas.clientWidth || 600;
    var height = canvas.clientHeight || 480;

    graphInstance = new ForceGraph(canvas)
      .width(width)
      .height(height)
      .graphData({ nodes: nodes, links: edges })
      .nodeId('id')
      .nodeLabel(function(node) {
        if (node.type === 'entity') {
          return '<strong>' + escapeHtml(node.label) + '</strong>';
        }
        var label = '<strong>' + escapeHtml(node.label) + '</strong>';
        if (node.date) label = formatDate(node.date) + '<br>' + label;
        return label;
      })
      .nodeVal(function(node) { return node.type === 'entity' ? 2 : 0.3; })
      .nodeRelSize(2.5)
      .nodeCanvasObjectMode(function() { return 'replace'; })
      .nodeCanvasObject(function(node, ctx, globalScale) {
        var r = Math.sqrt(node.type === 'entity' ? 2 : 0.3) * 2.5;

        if (node.type === 'document') {
          // Filled = has connections to other entities (pre-checked or already expanded)
          var neighbours = nodeNeighbours.get(node.id);
          var entityNeighbourCount = 0;
          if (neighbours) neighbours.forEach(function(nid) {
            var n = graphNodes.get(nid);
            if (n && n.type === 'entity') entityNeighbourCount++;
          });
          var filled = entityNeighbourCount > 1 || node.expandable === true;

          var dimmed = highlightedNodes.size > 0 && !highlightedNodes.has(node.id);
          var hovered = highlightedNodes.has(node.id);

          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          if (filled) {
            ctx.fillStyle = dimmed ? '#E8E4E0' : hovered ? '#807060' : node.color;
            ctx.fill();
          } else {
            ctx.fillStyle = '#FAFAF9';
            ctx.fill();
            ctx.strokeStyle = dimmed ? '#E8E4E0' : hovered ? '#807060' : node.color;
            ctx.lineWidth = 1.2 / globalScale;
            ctx.stroke();
          }
        } else {
          // Entity node: filled circle + label
          var dimmedE = highlightedNodes.size > 0 && !highlightedNodes.has(node.id);
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = dimmedE ? '#DDD8E0' : node.color;
          ctx.fill();

          var show = globalScale > 1.2 || highlightedNodes.has(node.id);
          if (show) {
            var fontSize = 10 / globalScale;
            ctx.font = 'bold ' + fontSize + 'px DM Sans, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = highlightedNodes.has(node.id) ? '#333' : '#777';
            ctx.fillText(node.label, node.x, node.y + r + 1);
          }
        }
      })
      .linkColor(function(link) {
        if (highlightedLinks.has(link)) return '#888';
        if (highlightedNodes.size > 0) return 'rgba(0,0,0,0.03)';
        return '#E0DDD8';
      })
      .linkWidth(function(link) { return highlightedLinks.has(link) ? 2 : 0.8; })
      .enableNodeDrag(true)
      .enableZoomInteraction(true)
      .cooldownTime(5000)
      .d3AlphaDecay(0.02)
      .d3VelocityDecay(0.3)
      .onNodeHover(function(node) {
        canvas.style.cursor = node ? 'pointer' : '';
        highlightedNodes.clear();
        highlightedLinks.clear();
        if (node) {
          highlightedNodes.add(node.id);
          var neighbours = nodeNeighbours.get(node.id);
          if (neighbours) neighbours.forEach(function(n) { highlightedNodes.add(n); });
          var nLinks = nodeLinks.get(node.id);
          if (nLinks) nLinks.forEach(function(l) { highlightedLinks.add(l); });
        }
      })
      .onNodeClick(function(node) {
        if (!node) return;
        dismissTooltip();
        if (node.type === 'entity') {
          graphInstance.centerAt(node.x, node.y, 400);
          showEntityTooltip(node, canvas);
        } else if (node.type === 'document') {
          graphInstance.centerAt(node.x, node.y, 400);
          showDocTooltip(node, canvas);
        }
      })
      .onBackgroundClick(function() { dismissTooltip(); })
      .onNodeDragEnd(function(node) { node.fx = node.x; node.fy = node.y; })
      .onZoom(function() { updateTooltipPosition(); });

    graphInstance.d3Force('charge').strength(-20);
    graphInstance.d3Force('link').distance(20).strength(0.5);

    // Zoom to fit early so the graph doesn't start as a distant speck
    setTimeout(function() {
      if (graphInstance) graphInstance.zoomToFit(0, 30);
    }, 300);

    // Resize
    new ResizeObserver(function() {
      if (graphInstance && canvas.clientWidth > 0) {
        graphInstance.width(canvas.clientWidth).height(canvas.clientHeight);
      }
    }).observe(canvas);

    // Pre-check which documents have expandable connections
    preCheckExpandable();
  }

  async function preCheckExpandable() {
    var docNodes = [];
    graphNodes.forEach(function(node) {
      if (node.type === 'document' && node.expandable === null) docNodes.push(node);
    });
    if (docNodes.length === 0) return;

    // Load Pagefind descriptions index (once)
    if (!pagefindDesc) {
      try {
        pagefindDesc = await import('/pagefind/pagefind.js');
        await pagefindDesc.options({ basePath: '/pagefind/' });
        await pagefindDesc.init();
      } catch (e) { return; }
    }

    for (var i = 0; i < docNodes.length; i++) {
      var node = docNodes[i];
      try {
        var search = await pagefindDesc.search(node.id);
        for (var si = 0; si < search.results.length; si++) {
          var hit = await search.results[si].data();
          if (hit.meta && hit.meta.reference_code === node.id) {
            var codes = (hit.filters && hit.filters.entidad) || [];
            node.expandable = false;
            for (var j = 0; j < codes.length; j++) {
              if (!graphNodes.has(codes[j])) { node.expandable = true; break; }
            }
            break;
          }
        }
        if (node.expandable === null) node.expandable = false;
      } catch (e) { node.expandable = false; }
    }
  }

  // --- Entity tooltip ---

  function showEntityTooltip(node, canvas) {
    dismissTooltip();

    var tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';

    var typeLabel = {
      person: 'Persona',
      corporate_body: 'Entidad corporativa',
      corporate: 'Entidad corporativa',
      family: 'Familia'
    };

    // Count shared documents in the graph
    var neighbours = nodeNeighbours.get(node.id);
    var sharedDocs = 0;
    if (neighbours) neighbours.forEach(function(nid) {
      var n = graphNodes.get(nid);
      if (n && n.type === 'document') sharedDocs++;
    });

    // Central entity name
    var centralNode = graphNodes.get(entityCode);
    var centralName = centralNode ? centralNode.label : entityCode;

    var html = '';
    html += '<div class="graph-tooltip-role">' + escapeHtml(typeLabel[node.entityType] || node.entityType) + '</div>';
    html += '<div class="graph-tooltip-name"><a href="/' + escapeHtml(node.id) + '/">' + escapeHtml(node.label) + '</a></div>';
    html += '<div class="graph-tooltip-ref">' + escapeHtml(node.id) + '</div>';
    if (sharedDocs > 0 && node.id !== entityCode) {
      html += '<div class="graph-tooltip-actions">';
      html += 'Conectado con ' + escapeHtml(centralName) + ' por ' + sharedDocs + ' documento' + (sharedDocs !== 1 ? 's' : '') + '.';
      html += '</div>';
    }
    var totalLinked = node.linkedCount || 0;
    var otherDocs = totalLinked - sharedDocs;
    if (otherDocs > 0 && node.id !== entityCode) {
      var typeWord = (node.entityType === 'person') ? 'persona' : 'entidad';
      html += '<div class="graph-tooltip-actions">';
      html += 'Esta ' + typeWord + ' está conectada a otros ' + otherDocs + ' documento' + (otherDocs !== 1 ? 's' : '') + ' en Zasqua. ';
      html += '<a href="/' + escapeHtml(node.id) + '/?vista=red" class="graph-tooltip-btn">Abrir en el explorador de relaciones</a>';
      html += '</div>';
    }

    tooltip.innerHTML = html;
    positionTooltip(tooltip, node);

    canvas.appendChild(tooltip);
    activeTooltip = tooltip;
    tooltipNode = node;
  }

  // --- Document tooltip ---

  function showDocTooltip(node, canvas) {
    dismissTooltip();

    var tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';

    var html = '';
    if (node.date) {
      html += '<div class="graph-tooltip-date">' + formatDate(node.date) + '</div>';
    }
    if (node.role) {
      html += '<div class="graph-tooltip-role">' + escapeHtml(roleLabels[node.role] || node.role) + '</div>';
    }
    html += '<div class="graph-tooltip-name"><a href="/' + escapeHtml(node.id) + '/">' + escapeHtml(node.label) + '</a></div>';
    html += '<div class="graph-tooltip-ref">' + escapeHtml(node.id) + '</div>';

    tooltip.innerHTML = html;
    positionTooltip(tooltip, node);

    canvas.appendChild(tooltip);
    activeTooltip = tooltip;
    tooltipNode = node;

    // Check how many connections can be expanded
    checkExpandable(node.id).then(function(count) {
      if (!count || activeTooltip !== tooltip) return;
      var actions = document.createElement('div');
      actions.className = 'graph-tooltip-actions';
      var text = 'Conectado a ' + count + ' entidad' + (count !== 1 ? 'es' : '') + ' más en Zasqua. ';
      var span = document.createElement('span');
      span.textContent = text;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'graph-tooltip-btn';
      btn.textContent = 'Desplegar';
      btn.addEventListener('click', async function() {
        btn.textContent = 'Cargando\u2026';
        btn.disabled = true;
        node.fx = node.x;
        node.fy = node.y;
        await expandDocument(node.id, canvas);
        graphInstance.centerAt(node.x, node.y, 400);
        dismissTooltip();
      });
      actions.appendChild(span);
      actions.appendChild(btn);
      tooltip.appendChild(actions);
    });
  }

  // Returns the count of new entity connections (0 = nothing to expand)
  async function checkExpandable(refCode) {
    // Load Pagefind descriptions index (once)
    if (!pagefindDesc) {
      try {
        pagefindDesc = await import('/pagefind/pagefind.js');
        await pagefindDesc.options({ basePath: '/pagefind/' });
        await pagefindDesc.init();
      } catch (e) { return 0; }
    }
    try {
      var search = await pagefindDesc.search(refCode);
      for (var si = 0; si < search.results.length; si++) {
        var hit = await search.results[si].data();
        if (hit.meta && hit.meta.reference_code === refCode) {
          var codes = (hit.filters && hit.filters.entidad) || [];
          var count = 0;
          for (var i = 0; i < codes.length; i++) {
            if (!graphNodes.has(codes[i])) count++;
          }
          return count;
        }
      }
    } catch (e) { /* fall through */ }
    return 0;
  }

  function positionTooltip(tooltip, node) {
    var coords = graphInstance.graph2ScreenCoords(node.x, node.y);
    tooltip.style.left = coords.x + 'px';
    tooltip.style.top = (coords.y - 8) + 'px';
    tooltip.style.transform = 'translate(-50%, -100%)';
  }

  function updateTooltipPosition() {
    if (activeTooltip && tooltipNode && graphInstance) {
      positionTooltip(activeTooltip, tooltipNode);
    }
  }

  function dismissTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
      tooltipNode = null;
    }
  }

  // --- Expand document: load connected entities ---

  async function expandDocument(refCode, canvas) {
    // Load Pagefind descriptions index (once)
    if (!pagefindDesc) {
      try {
        pagefindDesc = await import('/pagefind/pagefind.js');
        await pagefindDesc.options({ basePath: '/pagefind/' });
        await pagefindDesc.init();
      } catch (e) { console.error('[entity] Failed to load Pagefind descriptions:', e); return; }
    }

    // Search for this document and read its entidad filter values
    var entityCodes = [];
    try {
      var search = await pagefindDesc.search(refCode);
      for (var si = 0; si < search.results.length; si++) {
        var hit = await search.results[si].data();
        if (hit.meta && hit.meta.reference_code === refCode) {
          entityCodes = (hit.filters && hit.filters.entidad) || [];
          break;
        }
      }
    } catch (e) { console.error('[entity] Pagefind description search failed:', e); return; }

    if (entityCodes.length === 0) return;

    var newEntities = entityCodes.filter(function(c) { return !graphNodes.has(c); });
    if (newEntities.length === 0) return;

    // Load Pagefind entities index (once)
    if (!pagefindEntity) {
      try {
        pagefindEntity = await import('/pagefind-entities/pagefind.js');
        await pagefindEntity.options({ basePath: '/pagefind-entities/' });
        await pagefindEntity.init();
      } catch (e) { console.error('[entity] Failed to load Pagefind entities:', e); return; }
    }

    // Fetch entity page to get name + type for each new entity
    for (var i = 0; i < newEntities.length; i++) {
      var code = newEntities[i];
      try {
        var resp = await fetch('/' + code + '/');
        if (!resp.ok) continue;
        var html = await resp.text();
        var titleMatch = html.match(/<title>(.*?)\s*\|/);
        var typeMatch = html.match(/data-pagefind-meta="entity_type">([^<]+)/);
        var countMatch = html.match(/data-pagefind-meta="linked_count">([^<]+)/);
        var label = titleMatch ? titleMatch[1].trim() : code;
        var eType = typeMatch ? typeMatch[1].trim() : 'person';
        var linkedCount = countMatch ? parseInt(countMatch[1], 10) : 0;
        graphNodes.set(code, {
          id: code,
          type: 'entity',
          label: label,
          entityType: eType,
          linkedCount: linkedCount,
          color: entityColors[eType] || entityColors.person
        });
        graphEdges.push({ source: code, target: refCode, role: '' });
      } catch (e) { /* skip failed lookups */ }
    }

    // Also fetch shard for each new entity to find shared documents with existing nodes
    for (var j = 0; j < newEntities.length; j++) {
      var c = newEntities[j];
      if (!graphNodes.has(c)) continue; // Pagefind lookup failed
      if (!shardCache.has(c)) {
        try {
          var r = await fetch('/data/entity-links/' + c + '.json');
          if (r.ok) shardCache.set(c, await r.json());
          else shardCache.set(c, []);
        } catch (e) { shardCache.set(c, []); }
      }
      // Add edges to existing document nodes
      var shard = shardCache.get(c) || [];
      for (var k = 0; k < shard.length; k++) {
        var s = shard[k];
        if (graphNodes.has(s.reference_code) && s.reference_code !== refCode) {
          // This entity is also linked to another document already in the graph
          graphEdges.push({ source: c, target: s.reference_code, role: s.role });
        }
      }
    }

    // Incrementally add new nodes/links without rebuilding
    if (graphInstance) {
      var currentData = graphInstance.graphData();
      var nodeIds = new Set(currentData.nodes.map(function(n) { return n.id; }));
      var edgeKeys = new Set(currentData.links.map(function(l) {
        var s = typeof l.source === 'object' ? l.source.id : l.source;
        var t = typeof l.target === 'object' ? l.target.id : l.target;
        return s + '→' + t;
      }));

      var newNodes = [];
      var newLinks = [];

      graphNodes.forEach(function(node) {
        if (!nodeIds.has(node.id)) newNodes.push(node);
      });

      graphEdges.forEach(function(edge) {
        var key = edge.source + '→' + edge.target;
        if (!edgeKeys.has(key)) newLinks.push(Object.assign({}, edge));
      });

      if (newNodes.length > 0 || newLinks.length > 0) {
        // Position new nodes near the clicked document node
        var anchor = currentData.nodes.find(function(n) { return n.id === refCode; });
        if (anchor) {
          for (var ni = 0; ni < newNodes.length; ni++) {
            var angle = (2 * Math.PI * ni) / newNodes.length;
            newNodes[ni].x = anchor.x + 30 * Math.cos(angle);
            newNodes[ni].y = anchor.y + 30 * Math.sin(angle);
          }
        }

        rebuildAdjacency();
        graphInstance.graphData({
          nodes: currentData.nodes.concat(newNodes),
          links: currentData.links.concat(newLinks)
        });
        graphInstance.d3ReheatSimulation();

        // Keep centred on the clicked document
        if (anchor) {
          graphInstance.centerAt(anchor.x, anchor.y, 400);
        }
      }
    }
  }

  // --- Helpers ---

  function filterLinks(allLinks, active) {
    if (active.size === 0) return allLinks;
    return allLinks.filter(function(link) {
      return active.has(link.role || 'unknown');
    });
  }

});

// --- Timeline rendering ---

function renderTimeline(container, links, activeRoles) {
  var filtered = activeRoles && activeRoles.size > 0
    ? links.filter(function(l) { return activeRoles.has(l.role || 'unknown'); })
    : links;

  if (!filtered || filtered.length === 0) {
    container.innerHTML = '<p class="text-stone-500 text-sm" style="padding:16px 0">No se encontraron descripciones vinculadas con estos filtros.</p>';
    return;
  }

  // Separate dated and undated entries
  var dated = [];
  var undated = [];
  for (var i = 0; i < filtered.length; i++) {
    if (filtered[i].date_expression) {
      dated.push(filtered[i]);
    } else {
      undated.push(filtered[i]);
    }
  }

  dated.sort(function(a, b) {
    return a.date_expression.localeCompare(b.date_expression);
  });

  var all = dated.concat(undated.length > 0 ? [null] : [], undated);
  var html = '';
  for (var j = 0; j < all.length; j++) {
    if (all[j] === null) {
      html += '<div class="timeline-no-date">Sin fecha</div>';
      continue;
    }
    var isLast = (j === all.length - 1);
    html += renderTimelineEntry(all[j], isLast);
  }

  container.innerHTML = html;
}

function renderTimelineEntry(link, isLast) {
  var slug = link.reference_code.replace(/[?#]/g, '');
  var html = '<div class="timeline-entry' + (isLast ? ' timeline-entry-last' : '') + '">';

  // Left dot + vertical line
  html += '<div class="timeline-track">';
  html += '<div class="timeline-dot"><div class="timeline-dot-inner"></div></div>';
  if (!isLast) html += '<div class="timeline-line"></div>';
  html += '</div>';

  // Card with date, role badge, title, ref
  html += '<div class="timeline-card">';
  if (link.date_expression) {
    html += '<div class="timeline-date">' + escapeHtml(formatDate(link.date_expression)) + '</div>';
  }
  if (link.role) {
    var roleLabel = roleLabels[link.role] || link.role;
    html += '<span class="timeline-role-badge">' + escapeHtml(roleLabel) + '</span>';
  }
  html += '<a href="/' + slug + '/" class="timeline-title">' + escapeHtml(link.title) + '</a>';
  html += '<div class="timeline-ref">' + escapeHtml(link.reference_code) + '</div>';
  html += '</div>';

  html += '</div>';
  return html;
}

function formatDate(dateStr) {
  if (!dateStr) return '';

  var months = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
  ];

  if (dateStr.indexOf(' .. ') !== -1) {
    var parts = dateStr.split(' .. ');
    return formatDate(parts[0]) + ' – ' + formatDate(parts[1]);
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

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
}
