/**
 * Flat-Code URL Scheme Invariant Test
 *
 * The public URL scheme pins every description to the bare
 * reference code: a description lives at `/{reference_code}/`,
 * never under a section prefix like `/descripcion/{code}/`. This
 * keeps printed URLs stable across future information-architecture
 * changes. The test looks for
 * `public/{smoke-test-reference-code}/index.html` after a build
 * and simultaneously asserts the section-prefixed path does NOT
 * exist. Gated by SKIP_BUILD_TESTS=1 so enrichment-only runs can
 * skip the build dependency.
 *
 * @version v1.0.0
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SKIP = process.env.SKIP_BUILD_TESTS === '1';
const PUBLIC = path.resolve(process.cwd(), 'public');
const SMOKE_REF = 'pe-bn-cdip-01';

describe.skipIf(SKIP)('flat-code URL scheme', () => {
  it(`public/${SMOKE_REF}/index.html exists after build`, () => {
    const target = path.join(PUBLIC, SMOKE_REF, 'index.html');
    if (!fs.existsSync(target)) {
      throw new Error(`expected ${target} to exist after the build`);
    }
    expect(fs.statSync(target).size).toBeGreaterThan(0);
  });

  it('does NOT render under /descripcion/ prefix (flat-code scheme, not section-prefixed)', () => {
    const sectioned = path.join(PUBLIC, 'descripcion', SMOKE_REF, 'index.html');
    expect(fs.existsSync(sectioned)).toBe(false);
  });
});
