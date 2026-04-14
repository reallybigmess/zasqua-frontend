/**
 * Places Data Module
 *
 * Eleventy data module that feeds the place authority pages — one per
 * geographic entity referenced by the archival material (cities, towns,
 * regions, parishes, rivers, and so on). The source file
 * `data/places.json` is produced by the backend's `export_frontend_data`
 * management command and downloaded from Backblaze B2 during the build.
 *
 * Returns a plain array so pagination in `src/place.njk` can generate
 * one static page per place at `/lugar/{label}/`. As with entities, the
 * list of linked documents is not baked into the static page — it is
 * fetched lazily at runtime from `/api/places/{label}/descriptions/` so
 * editorial changes in the backend surface immediately.
 *
 * If `data/places.json` is missing the module returns an empty array so
 * builds still succeed. When `DEV_MODE=true`, the list is capped at 50
 * records to speed up local builds; `DATA_DIR` overrides the data
 * directory for CI and tests.
 *
 * @version v0.4.0
 */
const fs = require('fs');
const path = require('path');

const DEV_MODE = process.env.DEV_MODE === 'true';
const DEV_LIMIT = 50;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

module.exports = async function() {
  const filePath = path.join(DATA_DIR, 'places.json');

  if (!fs.existsSync(filePath)) {
    console.log(`[places] ${filePath} not found — skipping place pages`);
    return [];
  }

  console.log(`[places] Reading ${filePath}`);
  const raw = fs.readFileSync(filePath, 'utf8');
  let places = JSON.parse(raw);

  if (DEV_MODE && places.length > DEV_LIMIT) {
    console.log(`[places] DEV_MODE: Limiting to ${DEV_LIMIT} of ${places.length}`);
    places = places.slice(0, DEV_LIMIT);
  }

  console.log(`[places] Loaded ${places.length} places`);
  return places;
};
