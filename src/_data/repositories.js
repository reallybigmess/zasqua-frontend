/**
 * Repositories Data Module
 *
 * Eleventy data module that feeds the repository pages — one per
 * custodial institution such as the Archivo Histórico Regional de Boyacá
 * or the Antiguo Archivo Central del Cauca. At build time it reads
 * `data/repositories.json`, produced by the Zasqua backend and downloaded
 * from Backblaze B2 during the build.
 *
 * Returns the repositories array as-is for pagination in
 * `src/repository.njk` (which renders `/{code}/` pages) and for
 * consumption by the homepage grid and the description page's repository
 * lookup. `DATA_DIR` lets the build override the default data directory
 * when running in CI or under tests.
 *
 * @version v0.1.0
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

module.exports = async function() {
  const filePath = path.join(DATA_DIR, 'repositories.json');
  console.log(`[repositories] Reading ${filePath}`);

  const raw = fs.readFileSync(filePath, 'utf8');
  const repos = JSON.parse(raw);

  console.log(`[repositories] Loaded ${repos.length} repositories`);
  return repos;
};
