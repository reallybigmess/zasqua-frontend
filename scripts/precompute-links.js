/**
 * Precompute Entity and Place Link Shards
 *
 * Build-time step that turns the flat entity/place link exports from the
 * backend into the shape the static site needs at runtime. Entity detail
 * pages and place detail pages only want the handful of links that point
 * at them, not the full 290k+ entity links or 190k+ place links. Loading
 * the full exports into every page would balloon page size and hurt load
 * times; instead this script shards the links per entity and per place
 * so each detail page fetches a single small JSON file on demand.
 *
 * Inputs (downloaded from Backblaze B2 into `data/`):
 *   entity_links.json   — every entity-to-description link
 *   place_links.json    — every place-to-description link
 *   entities.json       — entity authority records
 *   places.json         — place authority records
 *
 * Outputs:
 *   data/entity-links/{entity_code}.json   — per-entity link shards
 *   data/place-links/{place_id}.json       — per-place link shards
 *   data/entity-index.json                 — trimmed entity list for the explorer
 *   data/place-index.json                  — trimmed place list for the explorer
 *   data/desc-entity-lookup.json           — reverse map used by description pages
 *   data/desc-place-lookup.json            — reverse map used by description pages
 *
 * The entity-index and place-index carry only the fields the explorers need
 * — display name, type, coordinates, linked description count, and a few
 * presence flags — so the JSON loaded by explorer pages stays small even
 * with tens of thousands of records.
 *
 * Set `DEV_MODE=true` (optionally with `DEV_LIMIT=N`) to limit the number
 * of shards written, for faster local builds.
 *
 * @version v0.5.0
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DEV_MODE = process.env.DEV_MODE === 'true';
const DEV_LIMIT = parseInt(process.env.DEV_LIMIT || '500', 10);

async function main() {
  console.log(`[precompute-links] DATA_DIR: ${DATA_DIR}`);
  if (DEV_MODE) {
    console.log(`[precompute-links] DEV_MODE enabled — limiting to ${DEV_LIMIT} shards per type`);
  }

  // -------------------------------------------------------------------------
  // 1. Entity links: read, group by entity_code, write shards
  // -------------------------------------------------------------------------

  const entityLinksPath = path.join(DATA_DIR, 'entity_links.json');
  console.log(`[precompute-links] Reading ${entityLinksPath}`);
  const entityLinksRaw = fs.readFileSync(entityLinksPath, 'utf8');
  const entityLinks = JSON.parse(entityLinksRaw);
  console.log(`[precompute-links] entity_links.json: ${entityLinks.length} records`);

  // Group by entity_code
  const byEntity = new Map();
  for (const link of entityLinks) {
    const code = link.entity_code;
    if (!byEntity.has(code)) {
      byEntity.set(code, []);
    }
    byEntity.get(code).push({
      reference_code: link.reference_code,
      title: link.title,
      date_expression: link.date_expression,
      repository_code: link.repository_code,
      role: link.role,
    });
  }

  // Write per-entity shards
  const entityShardsDir = path.join(DATA_DIR, 'entity-links');
  fs.mkdirSync(entityShardsDir, { recursive: true });

  let entityShardCount = 0;
  const entityCodes = Array.from(byEntity.keys());
  const entityCodesToWrite = DEV_MODE ? entityCodes.slice(0, DEV_LIMIT) : entityCodes;

  for (const code of entityCodesToWrite) {
    const shardPath = path.join(entityShardsDir, `${code}.json`);
    fs.writeFileSync(shardPath, JSON.stringify(byEntity.get(code)));
    entityShardCount++;
    if (entityShardCount % 10000 === 0) {
      console.log(`[precompute-links] Wrote ${entityShardCount} entity-links shards...`);
    }
  }
  console.log(`[precompute-links] Wrote ${entityShardCount} entity-links shards to ${entityShardsDir}`);

  // -------------------------------------------------------------------------
  // 2. Build entity-index.json for the entity explorer
  // -------------------------------------------------------------------------

  // Compute per-entity roles from entity-link shards
  const entityRoles = new Map();
  for (const link of entityLinks) {
    const code = link.entity_code;
    if (!entityRoles.has(code)) {
      entityRoles.set(code, new Set());
    }
    if (link.role) {
      entityRoles.get(code).add(link.role);
    }
  }
  console.log(`[precompute-links] Computed roles for ${entityRoles.size} entities`);

  const entitiesPath = path.join(DATA_DIR, 'entities.json');
  console.log(`[precompute-links] Reading ${entitiesPath}`);
  const entitiesRaw = fs.readFileSync(entitiesPath, 'utf8');
  const entities = JSON.parse(entitiesRaw);
  console.log(`[precompute-links] entities.json: ${entities.length} records`);

  const entityIndex = entities.map(e => ({
    entity_code: e.entity_code,
    display_name: e.display_name,
    sort_name: e.sort_name,
    entity_type: e.entity_type,
    date_earliest: e.date_earliest,
    date_latest: e.date_latest,
    primary_function: e.primary_function,
    linked_description_count: (byEntity.get(e.entity_code) || []).length,
    roles: Array.from(entityRoles.get(e.entity_code) || []),
  }));

  const entityIndexPath = path.join(DATA_DIR, 'entity-index.json');
  fs.writeFileSync(entityIndexPath, JSON.stringify(entityIndex));
  console.log(`[precompute-links] Wrote entity-index.json with ${entityIndex.length} records`);

  // -------------------------------------------------------------------------
  // 3. Place links: read, group by place_code, write shards
  // -------------------------------------------------------------------------

  const placeLinksPath = path.join(DATA_DIR, 'place_links.json');
  console.log(`[precompute-links] Reading ${placeLinksPath}`);
  const placeLinksRaw = fs.readFileSync(placeLinksPath, 'utf8');
  const placeLinks = JSON.parse(placeLinksRaw);
  console.log(`[precompute-links] place_links.json: ${placeLinks.length} records`);

  // Group by place_code
  const byPlace = new Map();
  let nullPlaceCount = 0;
  for (const link of placeLinks) {
    const code = link.place_code;
    if (code === null || code === undefined) {
      nullPlaceCount++;
      console.warn(`[precompute-links] WARNING: link with null/undefined place_code skipped (reference_code: ${link.reference_code})`);
      continue;
    }
    if (!byPlace.has(code)) {
      byPlace.set(code, []);
    }
    byPlace.get(code).push({
      reference_code: link.reference_code,
      title: link.title,
      date_expression: link.date_expression,
      repository_code: link.repository_code,
      role: link.role,
    });
  }
  if (nullPlaceCount > 0) {
    console.warn(`[precompute-links] WARNING: Skipped ${nullPlaceCount} place_links records with null/undefined place_code`);
  }

  // Write per-place shards
  const placeShardsDir = path.join(DATA_DIR, 'place-links');
  fs.mkdirSync(placeShardsDir, { recursive: true });

  let placeShardCount = 0;
  const placeCodes = Array.from(byPlace.keys());
  const placeCodesToWrite = DEV_MODE ? placeCodes.slice(0, DEV_LIMIT) : placeCodes;

  for (const code of placeCodesToWrite) {
    const shardPath = path.join(placeShardsDir, `${code}.json`);
    fs.writeFileSync(shardPath, JSON.stringify(byPlace.get(code)));
    placeShardCount++;
    if (placeShardCount % 5000 === 0) {
      console.log(`[precompute-links] Wrote ${placeShardCount} place-links shards...`);
    }
  }
  console.log(`[precompute-links] Wrote ${placeShardCount} place-links shards to ${placeShardsDir}`);

  // -------------------------------------------------------------------------
  // 4. Build place-index.json for the place explorer
  // -------------------------------------------------------------------------

  const placesPath = path.join(DATA_DIR, 'places.json');
  console.log(`[precompute-links] Reading ${placesPath}`);
  const placesRaw = fs.readFileSync(placesPath, 'utf8');
  const places = JSON.parse(placesRaw);
  console.log(`[precompute-links] places.json: ${places.length} records`);

  const placeIndexAll = places.map(p => ({
    id: p.id,
    display_name: p.display_name,
    place_type: p.place_type,
    latitude: p.latitude,
    longitude: p.longitude,
    place_code: p.place_code,
    has_wikidata: !!p.wikidata_id,
    has_tgn: !!p.tgn_id,
    has_whg: !!p.whg_id,
    has_hgis: !!p.hgis_id,
    linked_description_count: (byPlace.get(p.place_code) || []).length,
  }));

  // Exclude coordinate-less singletons from the explorer index —
  // places without coordinates and with at most 1 linked document
  // add noise to the explorer without providing useful discovery.
  // The place pages still exist for direct linking.
  const placeIndex = placeIndexAll.filter(p =>
    (p.latitude != null && p.longitude != null) || p.linked_description_count > 1
  );
  const excluded = placeIndexAll.length - placeIndex.length;
  if (excluded > 0) {
    console.log(`[precompute-links] Excluded ${excluded} coordinate-less singletons from place-index.json`);
  }

  const placeIndexPath = path.join(DATA_DIR, 'place-index.json');
  fs.writeFileSync(placeIndexPath, JSON.stringify(placeIndex));
  console.log(`[precompute-links] Wrote place-index.json with ${placeIndex.length} records`);

  // -------------------------------------------------------------------------
  // 5. Enriched reverse-lookup files
  // Build description-keyed maps so description pages can render entity
  // and place links without a runtime fetch.
  // -------------------------------------------------------------------------

  // 5a. Entity enriched reverse lookup
  const entityByCode = new Map(entities.map(e => [e.entity_code, e]));
  const descToEntities = new Map();

  for (const link of entityLinks) {
    const refCode = link.reference_code;
    const code = link.entity_code;
    if (!descToEntities.has(refCode)) descToEntities.set(refCode, new Map());
    const entMap = descToEntities.get(refCode);
    if (!entMap.has(code)) {
      const ent = entityByCode.get(code);
      entMap.set(code, {
        code,
        display_name: ent ? ent.display_name : code,
        entity_type: ent ? ent.entity_type : 'person',
        roles: [],
      });
    }
    if (link.role) {
      const entry = entMap.get(code);
      if (!entry.roles.includes(link.role)) {
        entry.roles.push(link.role);
      }
    }
  }

  const descEntityLookup = {};
  for (const [refCode, entMap] of descToEntities) {
    descEntityLookup[refCode] = Array.from(entMap.values());
  }

  const descEntityLookupPath = path.join(DATA_DIR, 'desc-entity-lookup.json');
  fs.writeFileSync(descEntityLookupPath, JSON.stringify(descEntityLookup));
  console.log(`[precompute-links] Wrote enriched desc-entity-lookup.json with ${descToEntities.size} keys`);

  // 5b. Place enriched reverse lookup
  const placeByCode = new Map(places.map(p => [p.place_code, p]));
  const descToPlaces = new Map();

  for (const link of placeLinks) {
    const code = link.place_code;
    if (code === null || code === undefined) continue;
    const refCode = link.reference_code;
    if (!descToPlaces.has(refCode)) descToPlaces.set(refCode, new Map());
    const placeMap = descToPlaces.get(refCode);
    if (!placeMap.has(code)) {
      const pl = placeByCode.get(code);
      placeMap.set(code, {
        place_code: code,
        display_name: pl ? pl.display_name : code,
      });
    }
  }

  const descPlaceLookup = {};
  for (const [refCode, placeMap] of descToPlaces) {
    descPlaceLookup[refCode] = Array.from(placeMap.values());
  }

  const descPlaceLookupPath = path.join(DATA_DIR, 'desc-place-lookup.json');
  fs.writeFileSync(descPlaceLookupPath, JSON.stringify(descPlaceLookup));
  console.log(`[precompute-links] Wrote enriched desc-place-lookup.json with ${descToPlaces.size} keys`);

  // -------------------------------------------------------------------------
  // 6. Summary
  // -------------------------------------------------------------------------

  console.log(`[precompute-links] Done.`);
  console.log(`  Entity shards written      : ${entityShardCount}`);
  console.log(`  Place shards written       : ${placeShardCount}`);
  console.log(`  entity-index records       : ${entityIndex.length}`);
  console.log(`  place-index records        : ${placeIndex.length}`);
  console.log(`  desc-entity-lookup keys    : ${descToEntities.size}`);
  console.log(`  desc-place-lookup keys     : ${descToPlaces.size}`);
}

main().catch(err => {
  console.error('[precompute-links] Fatal error:', err);
  process.exit(1);
});
