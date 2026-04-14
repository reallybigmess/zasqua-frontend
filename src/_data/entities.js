/**
 * Entities Data Module
 *
 * Eleventy data module that feeds the entity authority pages — one per
 * person or institution referenced by the archival material. The source
 * file `data/entities.json` is produced by the backend's
 * `export_frontend_data` management command and downloaded from Backblaze
 * B2 during the build.
 *
 * Returns a plain array so pagination in `src/entity.njk` can generate
 * one static page per authority record at `/entidad/{entity_code}/`.
 * Individual pages do not embed their linked descriptions at build time —
 * the entity detail page fetches them lazily at runtime from
 * `/api/entities/{entity_code}/descriptions/` so the list stays fresh
 * between site rebuilds.
 *
 * If `data/entities.json` is missing the module returns an empty array,
 * which lets builds succeed even when entity exports are disabled. When
 * `DEV_MODE=true`, the list is capped at 50 records to speed up local
 * builds; `DATA_DIR` overrides the data directory for CI and tests.
 *
 * @version v0.4.0
 */
const fs = require('fs');
const path = require('path');

const DEV_MODE = process.env.DEV_MODE === 'true';
const DEV_LIMIT = 50;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

module.exports = async function() {
  const filePath = path.join(DATA_DIR, 'entities.json');

  if (!fs.existsSync(filePath)) {
    console.log(`[entities] ${filePath} not found — skipping entity pages`);
    return [];
  }

  console.log(`[entities] Reading ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf8');
  let entities = JSON.parse(raw);

  if (DEV_MODE && entities.length > DEV_LIMIT) {
    console.log(`[entities] DEV_MODE: Limiting to ${DEV_LIMIT} of ${entities.length}`);
    entities = entities.slice(0, DEV_LIMIT);
  }

  console.log(`[entities] Loaded ${entities.length} entities`);
  return entities;
};
