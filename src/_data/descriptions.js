/**
 * Descriptions Data Module
 *
 * Eleventy data module that feeds the archival description pages. At build
 * time it reads `data/descriptions.json` — the full export produced by the
 * Zasqua backend and downloaded from Backblaze B2 during the build — and
 * returns an array that pagination in `src/description.njk` iterates over
 * to generate one static page per description.
 *
 * Before returning, the module enriches each entry with two precomputed
 * fields so templates can stay simple: `_ancestors` is the full breadcrumb
 * chain of parent descriptions walked by reference code, and `_repo` is
 * the full repository object resolved from `data/repositories.json`.
 *
 * When the `DEV_MODE` environment variable is set to `true`, the list is
 * capped at the first 100 descriptions to keep local development builds
 * fast. The `DATA_DIR` variable lets the build override the default data
 * directory — useful in CI and when running tests.
 *
 * @version v0.3.0
 */
const fs = require('fs');
const path = require('path');

const DEV_MODE = process.env.DEV_MODE === 'true';
const DEV_LIMIT = 100;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

module.exports = async function() {
  const filePath = path.join(DATA_DIR, 'descriptions.json');
  console.log(`[descriptions] Reading ${filePath}`);

  const raw = fs.readFileSync(filePath, 'utf8');
  let descriptions = JSON.parse(raw);

  if (DEV_MODE && descriptions.length > DEV_LIMIT) {
    console.log(`[descriptions] DEV_MODE: Limiting to ${DEV_LIMIT} of ${descriptions.length}`);
    descriptions = descriptions.slice(0, DEV_LIMIT);
  }

  console.log(`[descriptions] Loaded ${descriptions.length} descriptions`);

  // Load repositories and build lookup map
  const reposPath = path.join(DATA_DIR, 'repositories.json');
  const reposRaw = fs.readFileSync(reposPath, 'utf8');
  const repos = JSON.parse(reposRaw);
  const reposByCode = new Map();
  for (const repo of repos) {
    reposByCode.set(repo.code, repo);
  }

  // Build lookup map
  const byRefCode = new Map();
  for (const desc of descriptions) {
    byRefCode.set(desc.reference_code, desc);
  }

  // Attach precomputed data to each description
  for (const desc of descriptions) {
    // Ancestors (breadcrumb chain)
    const ancestors = [];
    let current = desc;
    while (current && current.parent_reference_code) {
      const parent = byRefCode.get(current.parent_reference_code);
      if (parent) {
        ancestors.unshift(parent);
        current = parent;
      } else {
        break;
      }
    }
    desc._ancestors = ancestors;

    // Repository object
    desc._repo = reposByCode.get(desc.repository_code) || null;
  }

  console.log(`[descriptions] Precomputed ancestors and repos`);
  return descriptions;
};
