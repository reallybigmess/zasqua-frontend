# Test Fixtures

These three files — `descriptions.sample.json`, `entities.sample.json`, `places.sample.json` — are verbatim samples of real records taken from the canonical B2 archival exports (`exports/descriptions.json`, etc.). They are used by the enrichment tests under `tests/enrichment/` so those tests don't need to read the full 900 MB export on every run.

The samples are not fabricated. Every field is copied as-is from the live data, so if a test changes its assertions to match a sample, those assertions will also hold against the real export. If the upstream shape changes (new fields, renamed columns), refresh these fixtures with the same extraction approach — first 3 descriptions with a `parent_reference_code`, first 5 entities, first 5 places.
