/**
 * Place Detail Page Behaviours
 *
 * Powers the interactive surfaces on a single place authority page.
 * The template (`lugar.njk`) lays out the metadata column and an
 * aside that holds a MapLibre GL map (when coordinates are available)
 * and a scrollable list of the documents the place appears in. This
 * module fetches the place's link shard from `/data/place-links/` and
 * renders the list, syncs role-filter pills with the list contents,
 * and boots the map with a Protomaps terrain basemap and a single
 * burgundy marker pinned at the place's coordinates.
 *
 * The description list supports two sort modes. Chronological (the
 * default) groups dated appearances oldest-first, then undated items
 * under a "Sin fecha" heading; each entry shows the document title,
 * a timeline-style dot and connecting line, the date, and a role
 * badge drawn from the place role vocabulary. Alphabetical sorts all
 * entries by title across the Spanish locale and hides the timeline
 * dots so the list reads as a plain index.
 *
 * Roles for places are narrower than for entities — a place is
 * "mentioned", "produced at", "origin", "destination", "jurisdiction"
 * — and duplicate labels (subject / mentioned both map to "Lugar
 * mencionado") are merged into a single pill so the filter row stays
 * clean.
 *
 * @version v0.5.0
 */

// Role labels in Spanish (place roles)
var placeRoleLabels = {
  subject: 'Lugar mencionado',
  mentioned: 'Lugar mencionado',
  production: 'Lugar de producción',
  origin: 'Origen',
  destination: 'Destino',
  jurisdiction: 'Jurisdicción',
  venue: 'Lugar de producción',
  unknown: 'Sin rol'
};

// Main page logic — shard loading, role filters, description list with sort
(async function() {
  var timelineEl = document.getElementById('place-timeline');
  if (!timelineEl) return;

  var placeId = timelineEl.dataset.placeId;
  if (!placeId) return;

  var links;
  try {
    var res = await fetch('/data/place-links/' + placeId + '.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    links = await res.json();
  } catch (err) {
    console.error('[place] Failed to load shard:', err);
    timelineEl.innerHTML = '<p class="text-stone-500 text-sm">No se pudieron cargar las descripciones vinculadas.</p>';
    return;
  }

  // State
  var activeRoles = new Set();
  var sortMode = 'chronological';

  // Set description count
  var countEl = document.getElementById('place-desc-count');
  if (countEl) {
    countEl.textContent = links.length + ' ' + (links.length === 1 ? 'descripci\u00f3n vinculada' : 'descripciones vinculadas');
  }

  // Wire sort buttons
  var sortBtns = document.querySelectorAll('#place-description-sort .sort-btn');
  sortBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      sortMode = btn.getAttribute('data-sort');
      sortBtns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      renderDescriptionList(timelineEl, links, activeRoles, sortMode);
    });
  });

  buildRoleFilters(links);
  renderDescriptionList(timelineEl, links, activeRoles, sortMode);

  // --- Role filters (pills) ---

  function buildRoleFilters(allLinks) {
    var filtersEl = document.getElementById('place-role-filters');
    if (!filtersEl) return;

    // Group roles by display label so duplicates (e.g. subject/mentioned) merge into one pill
    var labelGroups = {};
    for (var i = 0; i < allLinks.length; i++) {
      var r = allLinks[i].role || 'unknown';
      var label = placeRoleLabels[r] || r;
      if (!labelGroups[label]) labelGroups[label] = { roles: [], count: 0 };
      if (labelGroups[label].roles.indexOf(r) === -1) labelGroups[label].roles.push(r);
      labelGroups[label].count++;
    }

    var labels = Object.keys(labelGroups).sort(function(a, b) {
      return labelGroups[b].count - labelGroups[a].count;
    });

    filtersEl.innerHTML = '';
    for (var j = 0; j < labels.length; j++) {
      var group = labelGroups[labels[j]];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'entity-role-btn';
      btn.dataset.roles = group.roles.join(',');
      btn.textContent = labels[j] + ' (' + group.count + ')';
      btn.addEventListener('click', function() {
        var rs = this.dataset.roles.split(',');
        var allActive = rs.every(function(r) { return activeRoles.has(r); });
        if (allActive) {
          rs.forEach(function(r) { activeRoles.delete(r); });
          this.classList.remove('active');
        } else {
          rs.forEach(function(r) { activeRoles.add(r); });
          this.classList.add('active');
        }
        renderDescriptionList(timelineEl, links, activeRoles, sortMode);
      });
      filtersEl.appendChild(btn);
    }

  }

  // --- Description list rendering ---

function renderDescriptionList(container, links, activeRoles, sortMode) {
  var filtered = activeRoles && activeRoles.size > 0
    ? links.filter(function(l) { return activeRoles.has(l.role || 'unknown'); })
    : links;

  if (!filtered || filtered.length === 0) {
    container.innerHTML = '<p class="text-stone-500 text-sm" style="padding:16px 0">No se encontraron descripciones vinculadas con estos filtros.</p>';
    return;
  }

  var html = '';

  if (sortMode === 'alphabetical') {
    // Alphabetical: sort all entries by title, no date grouping
    var sorted = filtered.slice().sort(function(a, b) {
      return (a.title || '').localeCompare(b.title || '', 'es');
    });
    for (var i = 0; i < sorted.length; i++) {
      html += renderTimelineEntry(sorted[i], i === sorted.length - 1, true);
    }
  } else {
    // Chronological (default): dated first sorted ascending, undated at bottom
    var dated = [];
    var undated = [];
    for (var j = 0; j < filtered.length; j++) {
      if (filtered[j].date_expression) {
        dated.push(filtered[j]);
      } else {
        undated.push(filtered[j]);
      }
    }

    dated.sort(function(a, b) {
      return a.date_expression.localeCompare(b.date_expression);
    });

    var all = dated.concat(undated.length > 0 ? [null] : [], undated);
    for (var k = 0; k < all.length; k++) {
      if (all[k] === null) {
        html += '<div class="timeline-no-date">Sin fecha</div>';
        continue;
      }
      html += renderTimelineEntry(all[k], k === all.length - 1);
    }
  }

  container.innerHTML = html;
}

function renderTimelineEntry(link, isLast, hideTrack) {
  var slug = link.reference_code.replace(/[?#]/g, '');
  var html = '<div class="timeline-entry' + (isLast ? ' timeline-entry-last' : '') + '">';

  if (!hideTrack) {
    html += '<div class="timeline-track">';
    html += '<div class="timeline-dot"><div class="timeline-dot-inner"></div></div>';
    if (!isLast) html += '<div class="timeline-line"></div>';
    html += '</div>';
  }

  html += '<div class="timeline-card">';
  if (link.date_expression) {
    html += '<div class="timeline-date">' + escapeHtml(formatDate(link.date_expression)) + '</div>';
  }
  if (link.role) {
    var roleLabel = (typeof placeRoleLabels !== 'undefined' ? placeRoleLabels[link.role] : null) || link.role;
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

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
}

})();

// Map initialisation — Protomaps terrain-only basemap + click tooltip
(function() {
  var mapEl = document.getElementById('place-map');
  if (!mapEl || typeof maplibregl === 'undefined' || typeof basemaps === 'undefined') return;
  try {
    var lat = parseFloat(mapEl.dataset.lat);
    var lon = parseFloat(mapEl.dataset.lon);
    if (isNaN(lat) || isNaN(lon)) return;

    var apiKey = mapEl.dataset.protomapsKey || '';
    var placeName = mapEl.dataset.placeName || '';
    var placeType = mapEl.dataset.placeType || '';

    // Build terrain-only style
    var REMOVE = new Set(['roads', 'transit', 'buildings', 'pois', 'landuse', 'landcover']);
    var allLayers = basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'es' });
    var terrainLayers = allLayers.filter(function(l) { return !REMOVE.has(l['source-layer']); });
    var style = {
      version: 8,
      glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
      sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
      sources: {
        protomaps: {
          type: 'vector',
          url: 'https://api.protomaps.com/tiles/v4.json?key=' + apiKey,
          attribution: '<a href="https://protomaps.com">Protomaps</a> \u00a9 <a href="https://openstreetmap.org">OpenStreetMap</a>'
        }
      },
      layers: terrainLayers
    };

    var map = new maplibregl.Map({
      container: 'place-map',
      style: style,
      center: [lon, lat],
      zoom: 7,
      renderWorldCopies: false
    });

    // Burgundy dot marker
    var markerEl = document.createElement('div');
    markerEl.style.width = '12px';
    markerEl.style.height = '12px';
    markerEl.style.borderRadius = '50%';
    markerEl.style.backgroundColor = '#8B2942';
    markerEl.style.border = '2px solid #FFFFFF';
    markerEl.style.cursor = 'pointer';

    new maplibregl.Marker({ element: markerEl })
      .setLngLat([lon, lat])
      .addTo(map);

    // Click-to-pin tooltip
    var activeTooltip = null;
    var mapContainer = mapEl;

    function dismissTooltip() {
      if (activeTooltip) { activeTooltip.remove(); activeTooltip = null; }
    }

    markerEl.addEventListener('click', function(e) {
      e.stopPropagation();
      dismissTooltip();

      var tooltip = document.createElement('div');
      tooltip.className = 'graph-tooltip map-tooltip';

      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'map-tooltip-close';
      closeBtn.setAttribute('aria-label', 'Cerrar');
      closeBtn.textContent = '\u00D7';
      closeBtn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        dismissTooltip();
      });

      var content = document.createElement('div');
      content.innerHTML =
        '<strong style="font-size:0.95rem">' + escapeHtml(placeName) + '</strong>' +
        '<br><span style="font-size:0.8rem;color:#57534e">' + escapeHtml(placeType) + '</span>';

      tooltip.appendChild(closeBtn);
      tooltip.appendChild(content);

      // Position tooltip above marker
      var pt = map.project([lon, lat]);
      tooltip.style.position = 'absolute';
      tooltip.style.left = pt.x + 'px';
      tooltip.style.top = (pt.y - 10) + 'px';
      tooltip.style.transform = 'translate(-50%, -100%)';
      tooltip.style.zIndex = '10';
      mapContainer.style.position = 'relative';
      mapContainer.appendChild(tooltip);
      activeTooltip = tooltip;

      // Dismiss on map pan
      map.once('movestart', dismissTooltip);
    });

  } catch (e) {
    console.error('[place] Map init failed:', e);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();
