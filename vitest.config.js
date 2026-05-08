/**
 * Vitest Configuration
 *
 * Configures Vitest — the test runner uses to encode the
 * Eleventy → Hugo migration's invariants as
 * automated checks. Vitest runs in Node (not a browser) because every
 * assertion in this project either checks a JavaScript enrichment
 * function or reads a file produced by the build pipeline.
 *
 * Tests live under `tests/` in two sub-folders: `tests/enrichment/`
 * (pure-function and JSON-shape tests, runnable without a full build)
 * and `tests/build/` (assertions against the built `public/` output,
 * gated by the SKIP_BUILD_TESTS env var for local iteration).
 *
 * @version v1.0.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    testTimeout: 10000,
  },
});
