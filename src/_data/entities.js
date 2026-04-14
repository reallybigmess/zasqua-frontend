/**
 * Entities Data Module
 *
 * Eleventy data module that feeds the entity detail pages and the entity
 * explorer. At build time it reads `data/entities.json` — the full entity
 * authority export produced by the backend and downloaded from Backblaze
 * B2 — and returns an array that pagination in `src/entidad.njk` iterates
 * over to generate one static page per entity (a historical person,
 * corporate body, or family).
 *
 * Before returning, the module enriches each entry with two precomputed
 * fields so templates don't have to read separate files. `_linked_count`
 * comes from `entity-index.json` and is the number of descriptions the
 * entity appears in — used on the detail page and in explorer counts.
 * `roles` is the distinct set of roles the entity has played across
 * those descriptions, aggregated from `entity_links.json`; the backend
 * currently leaves this field empty, so it is computed at build time to
 * enable role-based facets in the explorer.
 *
 * When the `DEV_MODE` environment variable is set to `true`, the list is
 * capped at the first 100 entities to keep local development builds
 * fast. The `DATA_DIR` variable lets the build override the default data
 * directory — useful in CI and when running tests.
 *
 * @version v0.5.0
 */

const fs = require('fs');
const path = require('path');

const DEV_MODE = process.env.DEV_MODE === 'true';
const DEV_LIMIT = 100;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

module.exports = async function() {
  const filePath = path.join(DATA_DIR, 'entities.json');
  console.log(`[entities] Reading ${filePath}`);
  let entities;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    entities = JSON.parse(raw);
  } catch (e) {
    console.warn('[entities] entities.json not found — returning empty array');
    return [];
  }
  if (DEV_MODE && entities.length > DEV_LIMIT) {
    console.log(`[entities] DEV_MODE: Limiting to ${DEV_LIMIT} of ${entities.length}`);
    entities = entities.slice(0, DEV_LIMIT);
  }
  console.log(`[entities] Loaded ${entities.length} entities`);

  // Attach _linked_count from entity-index.json
  const countByCode = new Map();
  try {
    const indexPath = path.join(DATA_DIR, 'entity-index.json');
    const indexRaw = fs.readFileSync(indexPath, 'utf8');
    const index = JSON.parse(indexRaw);
    for (const entry of index) {
      countByCode.set(entry.entity_code, entry.linked_description_count);
    }
    console.log(`[entities] Loaded entity-index.json with ${index.length} records`);
  } catch (e) {
    console.warn('[entities] entity-index.json not found — _linked_count will be 0 for all entities');
  }

  for (const entity of entities) {
    entity._linked_count = countByCode.get(entity.entity_code) || 0;
  }

  // Aggregate distinct roles per entity from the master entity_links file.
  // The backend export currently leaves entity.roles empty, so we compute it
  // here at build time to enable role-based facets in the entity explorer.
  // Each link in entity_links.json carries the role the entity played in
  // that document, so the aggregated set is the entity's repertoire of roles.
  const rolesByCode = new Map();
  try {
    const linksPath = path.join(DATA_DIR, 'entity_links.json');
    const linksRaw = fs.readFileSync(linksPath, 'utf8');
    const links = JSON.parse(linksRaw);
    for (const link of links) {
      if (!link.entity_code || !link.role) continue;
      let set = rolesByCode.get(link.entity_code);
      if (!set) {
        set = new Set();
        rolesByCode.set(link.entity_code, set);
      }
      set.add(link.role);
    }
    console.log(`[entities] Aggregated roles for ${rolesByCode.size} entities from entity_links.json`);
  } catch (e) {
    console.warn('[entities] entity_links.json not found — entity.roles will remain empty');
  }

  for (const entity of entities) {
    const set = rolesByCode.get(entity.entity_code);
    entity.roles = set ? Array.from(set).sort() : [];
  }

  return entities;
};
