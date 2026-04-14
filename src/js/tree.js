/**
 * Miller Columns Tree Navigation
 *
 * Renders the archival hierarchy — fonds, series, files, items — as a chain of
 * side-by-side columns in the Miller style familiar from the macOS Finder.
 * Clicking an entry in one column opens its children in the next column to the
 * right, so visitors can drill from a fonds down to an individual document
 * without ever leaving the page.
 *
 * The tree is used in two places: repository landing pages (where the root
 * descriptions are embedded directly in the HTML under
 * `#root-descriptions-data`) and description pages (where the first column is
 * fetched via the `data-parent-id` attribute). Child levels are loaded lazily
 * from static JSON shards under `/data/children/<id>.json` — the catalogue is
 * too large to ship in one file, so shards are fetched on demand and cached in
 * memory for the session.
 *
 * Each item shows a filter input, an inline metadata drawer (reference code,
 * dates, scope and content excerpt, and a count of child units labelled as
 * unidad / unidad compuesta / unidad simple depending on the children's level),
 * and a link to the full record at a flat URL built from the reference code.
 * For leaf items, a small helper extracts the document number from the
 * reference code — preferring explicit `dNNN` or `nNNN` segments and falling
 * back to the last purely numeric segment — so titles read like "005 - Carta
 * del gobernador".
 *
 * @version v0.5.0
 */

class MillerColumnsTree {
  constructor(container, options = {}) {
    this.container = container;
    this.repoCode = options.repoCode || '';
    this.levelLabels = options.levelLabels || {};
    this.columns = [];
    this.cache = new Map(); // Cache fetched children

    this.init();
  }

  init() {
    this.container.classList.add('miller-columns');
    this.container.innerHTML = '<div class="miller-columns-wrapper"></div>';
    this.wrapper = this.container.querySelector('.miller-columns-wrapper');
  }

  /**
   * Load initial data (root items)
   */
  async loadRoot(rootDescriptions) {
    this.clearColumns();
    const column = this.createColumn(rootDescriptions, 0, 'Contenido');
    this.wrapper.appendChild(column);
    this.columns.push(column);
  }

  /**
   * Create a column with items
   */
  createColumn(items, depth, title = '') {
    const column = document.createElement('div');
    column.className = 'miller-column';
    column.dataset.depth = depth;

    // Column header with title and filter
    const header = document.createElement('div');
    header.className = 'miller-column-header';

    if (title) {
      const titleSpan = document.createElement('span');
      titleSpan.className = 'miller-column-title';
      titleSpan.textContent = title;
      header.appendChild(titleSpan);
    }

    // Filter input (shown in rightmost/active column)
    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = 'Filtrar...';
    filterInput.className = 'column-filter';
    filterInput.addEventListener('input', (e) => this.filterColumn(column, e.target.value));
    filterInput.addEventListener('click', (e) => e.stopPropagation());
    header.appendChild(filterInput);

    column.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'miller-column-list';

    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'miller-item';
      li.dataset.id = item.id;
      li.dataset.refCode = item.reference_code;
      li.dataset.hasChildren = item.child_count > 0;

      // Item content
      const content = document.createElement('div');
      content.className = 'miller-item-content';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'miller-item-title';

      // Container words - skip number prefix if title contains these
      const containerWords = /\b(legajo|caja|tomo|carpeta|vol\.|volumen|expediente|sección|seccion|subsección|subseccion|serie|subserie|fondo|subfondo|unidad|protocolo|capítulo|capitulo)\b/i;

      if (item.child_count > 0) {
        // Container: show just title in main row
        titleSpan.textContent = item.title;
        content.appendChild(titleSpan);
      } else if (containerWords.test(item.title)) {
        // Leaf item but title suggests it's a container (e.g., empty Legajo)
        titleSpan.textContent = item.title;
        content.appendChild(titleSpan);
      } else {
        // Leaf item: show "### - Title" format if we can extract a number
        const docNum = this.extractDocNumber(item.reference_code);
        if (docNum) {
          titleSpan.textContent = `${docNum} - ${item.title}`;
        } else {
          titleSpan.textContent = item.title;
        }
        content.appendChild(titleSpan);
      }

      // Main row with content and arrow
      const main = document.createElement('div');
      main.className = 'miller-item-main';
      main.appendChild(content);

      // Arrow indicator for items with children
      if (item.child_count > 0) {
        const arrow = document.createElement('span');
        arrow.className = 'miller-item-arrow';
        arrow.textContent = '›';
        main.appendChild(arrow);
      }

      li.appendChild(main);

      // Metadata row (shown when selected)
      const metadata = this.createMetadataRow(item);
      li.appendChild(metadata);

      // Click handler
      li.addEventListener('click', (e) => this.handleItemClick(li, item, depth, e));

      list.appendChild(li);
    }

    column.appendChild(list);
    return column;
  }

  /**
   * Handle clicking on an item
   */
  async handleItemClick(element, item, depth, event) {
    // Check if click was on the metadata link
    if (event && event.target.closest('.miller-item-metadata a')) {
      return; // Let the link handle navigation
    }

    // Remove selection from siblings and collapse their metadata
    const column = element.closest('.miller-column');
    column.querySelectorAll('.miller-item').forEach(el => {
      el.classList.remove('selected', 'selected-ancestor');
      const meta = el.querySelector('.miller-item-metadata');
      if (meta) meta.classList.remove('expanded');
    });

    // Change previous column selections to ancestor style
    this.wrapper.querySelectorAll('.miller-item.selected').forEach(el => {
      el.classList.remove('selected');
      el.classList.add('selected-ancestor');
    });

    // Select this item and show its metadata
    element.classList.add('selected');
    const metadata = element.querySelector('.miller-item-metadata');
    if (metadata) {
      metadata.classList.add('expanded');
    }

    // Remove columns to the right
    this.removeColumnsAfter(depth);

    // If item has children, load them
    if (item.child_count > 0) {
      element.classList.add('loading');

      try {
        const children = await this.fetchChildren(item.id);
        const newColumn = this.createColumn(children, depth + 1, item.title);
        this.wrapper.appendChild(newColumn);
        this.columns.push(newColumn);

        // Scroll to show new column
        this.scrollToColumn(newColumn);
      } catch (error) {
        console.error('Error fetching children:', error);
      } finally {
        element.classList.remove('loading');
      }
    }
  }

  /**
   * Fetch children from static JSON
   */
  async fetchChildren(parentId) {
    // Check cache first
    if (this.cache.has(parentId)) {
      return this.cache.get(parentId);
    }

    const response = await fetch(`/data/children/${parentId}.json`);
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const children = data.results || data;

    // Cache the result
    this.cache.set(parentId, children);

    return children;
  }

  /**
   * Remove all columns after a given depth
   */
  removeColumnsAfter(depth) {
    while (this.columns.length > depth + 1) {
      const column = this.columns.pop();
      column.remove();
    }
    // Clear filter input in the now-last column and restore ancestor selections
    if (this.columns.length > 0) {
      const lastColumn = this.columns[this.columns.length - 1];
      const filter = lastColumn.querySelector('.column-filter');
      if (filter) {
        filter.value = '';
        this.filterColumn(lastColumn, '');
      }
      // Restore selected-ancestor to selected in the now-last column
      const ancestorItem = lastColumn.querySelector('.miller-item.selected-ancestor');
      if (ancestorItem) {
        ancestorItem.classList.remove('selected-ancestor');
        ancestorItem.classList.add('selected');
      }
    }
  }

  /**
   * Clear all columns
   */
  clearColumns() {
    this.columns = [];
    this.wrapper.innerHTML = '';
  }

  /**
   * Scroll to show a column
   */
  scrollToColumn(column) {
    setTimeout(() => {
      column.scrollIntoView({ behavior: 'smooth', inline: 'end', block: 'nearest' });
    }, 100);
  }

  /**
   * Filter items in a column by search text
   */
  filterColumn(column, searchText) {
    const items = column.querySelectorAll('.miller-item');
    const search = searchText.toLowerCase().trim();

    items.forEach(item => {
      if (!search) {
        item.style.display = '';
        return;
      }

      const title = item.querySelector('.miller-item-title')?.textContent?.toLowerCase() || '';
      const subtitle = item.querySelector('.miller-item-subtitle')?.textContent?.toLowerCase() || '';
      const refCode = item.dataset.refCode?.toLowerCase() || '';

      const matches = title.includes(search) || subtitle.includes(search) || refCode.includes(search);
      item.style.display = matches ? '' : 'none';
    });
  }

  /**
   * Create expandable metadata row for an item
   */
  createMetadataRow(item) {
    const metadata = document.createElement('div');
    metadata.className = 'miller-item-metadata';

    // Reference code
    const refCode = document.createElement('p');
    refCode.className = 'metadata-refcode';
    refCode.textContent = item.reference_code;
    metadata.appendChild(refCode);

    // Divider line
    const divider = document.createElement('hr');
    divider.className = 'metadata-divider';
    metadata.appendChild(divider);

    // Date range (if available)
    if (item.date_expression) {
      const date = document.createElement('p');
      date.className = 'metadata-date';
      date.textContent = item.date_expression;
      metadata.appendChild(date);
    }

    // Scope/content (truncated)
    if (item.scope_content) {
      const scope = document.createElement('p');
      scope.className = 'metadata-scope';
      // Truncate to ~150 chars
      const text = item.scope_content.length > 150
        ? item.scope_content.substring(0, 150) + '...'
        : item.scope_content;
      scope.textContent = text;
      metadata.appendChild(scope);
    }

    // Child count (for containers)
    if (item.child_count > 0) {
      const count = document.createElement('p');
      count.className = 'metadata-count';

      // Container types that indicate children are "unidades compuestas"
      const containerTypes = ['caja', 'carpeta', 'tomo', 'legajo', 'volume', 'serie', 'subserie', 'section', 'fonds', 'subfonds', 'file'];

      let label;
      if (!item.children_level) {
        // Mixed or unknown → generic "unidades"
        label = item.child_count === 1 ? 'unidad' : 'unidades';
      } else if (containerTypes.includes(item.children_level)) {
        // Children are containers
        label = item.child_count === 1 ? 'unidad compuesta' : 'unidades compuestas';
      } else {
        // Children are items/documents
        label = item.child_count === 1 ? 'unidad simple' : 'unidades simples';
      }

      count.textContent = `(${item.child_count.toLocaleString('es-ES')} ${label})`;
      metadata.appendChild(count);
    }

    // Link to full record (flat URL structure)
    const link = document.createElement('a');
    link.href = `/${item.reference_code.replace(/[?#]/g, '')}/`;
    link.className = 'metadata-link';
    link.textContent = 'Ver registro →';
    metadata.appendChild(link);

    return metadata;
  }

  /**
   * Extract document number from reference code for leaf items.
   * Scans backwards to find a document-number segment:
   *   1. "dNNN" or "nNNN" prefix (e.g., d005, n003) — strip the letter, return "005"/"003"
   *   2. Pure numeric (e.g., 001) — return as-is
   * e.g., "co-ahrb-aht-009-d005" -> "005"
   * e.g., "co-ahr-gob-caj001-car001-001" -> "001"
   */
  extractDocNumber(refCode) {
    if (!refCode) return null;

    const parts = refCode.split('-');

    // First pass: look for dNNN or nNNN segments (document identifiers)
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^[dn]\d+$/.test(parts[i])) {
        return parts[i].substring(1);
      }
    }

    // Second pass: last purely numeric segment
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(parts[i])) {
        return parts[i];
      }
    }

    return null;
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const treeContainer = document.getElementById('collection-tree');
  if (!treeContainer) return;

  let levelLabels = {};
  try {
    levelLabels = JSON.parse(treeContainer.dataset.levelLabels || '{}');
  } catch (e) {
    console.warn('Could not parse level labels');
  }

  const tree = new MillerColumnsTree(treeContainer, {
    repoCode: treeContainer.dataset.repoCode || '',
    levelLabels
  });

  // Case 1: Repository page — root data embedded in page
  const rootDataEl = document.getElementById('root-descriptions-data');
  if (rootDataEl) {
    try {
      tree.loadRoot(JSON.parse(rootDataEl.textContent));
    } catch (e) {
      console.error('Could not parse root descriptions:', e);
    }
    return;
  }

  // Case 2: Description page — fetch children from static JSON
  const parentId = treeContainer.dataset.parentId;
  if (parentId) {
    tree.fetchChildren(parentId).then(children => {
      tree.loadRoot(children);
    }).catch(e => {
      console.error('Could not load children:', e);
    });
  }
});
