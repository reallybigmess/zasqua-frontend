/**
 * Link Enrichment Invariant Test
 *
 * Descriptions reference entities (people, organisations) and places via
 * compact codes. For the frontend to render those references as readable
 * chips ("Simón Bolívar — autor") instead of raw codes, the enrichment
 * step denormalises display names and role labels onto each link record.
 * This test pins the contract: every `entity_links[*]` record on an
 * enriched description must include `entity_code`, `display_name`, and
 * `role_label`; every `place_links[*]` must include `place_code` and
 * `display_name`.
 *
 * Descriptions are sharded by repository_code — the test walks every
 * shard and asserts link shape on every record that carries links. It
 * additionally requires at least one non-empty `entity_links` and one
 * non-empty `place_links` somewhere in the corpus, which catches a
 * pipeline that silently produced empty arrays everywhere. Individual
 * records without links (legitimately) pass through unremarked.
 *
 * @version v1.0.0
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SHARDS_DIR = path.resolve(process.cwd(), 'assets/hugo-data/descriptions');

function iterAllRecords() {
  const out = [];
  for (const file of fs.readdirSync(SHARDS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const records = JSON.parse(fs.readFileSync(path.join(SHARDS_DIR, file), 'utf8'));
    out.push(...records);
  }
  return out;
}

describe('link enrichment invariant (I2)', () => {
  it('descriptions shard directory exists', () => {
    expect(fs.existsSync(SHARDS_DIR)).toBe(true);
  });

  it('every entity_links[*] carries entity_code, display_name, role_label', () => {
    const descs = iterAllRecords();
    let checked = 0;
    for (const d of descs) {
      const links = d.entity_links || [];
      for (const link of links) {
        expect(typeof link.entity_code).toBe('string');
        expect(typeof link.display_name).toBe('string');
        expect(typeof link.role_label).toBe('string');
        checked++;
      }
    }
    // The corpus-wide "at least one" invariant only makes sense on the
    // full dataset — DEV_LIMIT slices can legitimately pick records with
    // no entity_links.
    if (!process.env.DEV_LIMIT) {
      expect(checked).toBeGreaterThan(0);
    }
  });

  it('every place_links[*] carries place_code, display_name', () => {
    const descs = iterAllRecords();
    let checked = 0;
    for (const d of descs) {
      const links = d.place_links || [];
      for (const link of links) {
        expect(typeof link.place_code).toBe('string');
        expect(typeof link.display_name).toBe('string');
        checked++;
      }
    }
    if (!process.env.DEV_LIMIT) {
      expect(checked).toBeGreaterThan(0);
    }
  });
});
