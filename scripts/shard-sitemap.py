#!/usr/bin/env python3
"""
Shard sitemap.xml into sub-50K-URL pieces

Google's sitemap protocol caps a single sitemap file at 50,000 URLs
or 50 MiB uncompressed. Zasqua's Hugo build currently emits a
monolithic `public/sitemap.xml` with ~191,500 URLs — nearly four
times the URL ceiling — so crawlers truncate the file, ingest the
first 50K entries, and quietly skip the rest. The effect is that
most of the archive never makes it into a search index, even though
every page builds and serves correctly.

This script runs as a post-Hugo, pre-upload stage in the build
pipeline. It reads `public/sitemap.xml`, splits its `<url>` entries
into chunks of at most CHUNK_SIZE URLs, writes each chunk as a
shard file (`public/sitemap-001.xml`, `sitemap-002.xml`, …), and
overwrites `public/sitemap.xml` with a sitemap *index* that points
at the shards. Crawlers follow the index transparently.

CHUNK_SIZE is a constant, not a CLI flag. 45,000 leaves 10% headroom
under the 50K ceiling so a modest archive growth between builds does
not trip the limit unnoticed. Lowering the constant is always safe;
raising it near 50K invites silent truncation the next time the
archive grows.

The script is idempotent: given the same `public/sitemap.xml`, it
produces byte-identical shards (modulo the index's <lastmod>, which
tracks build time). Hugo's sitemap entry order is deterministic, so
shards stay stable between builds except where actual content
changed — which keeps the diff-based R2 upload honest.

Inputs:  public/sitemap.xml (written by Hugo).
Outputs: public/sitemap-NNN.xml shards, public/sitemap.xml
         (overwritten as a sitemap index).

Version: v1.0.1
"""

import math
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

CHUNK_SIZE = 45_000
PUBLIC_DIR = Path("public")
SITEMAP_NS = "http://www.sitemaps.org/schemas/sitemap/0.9"


def main() -> int:
    src = PUBLIC_DIR / "sitemap.xml"
    if not src.exists():
        print(f"shard-sitemap: {src} not found — run Hugo first", file=sys.stderr)
        return 1

    # Register the default namespace with an empty prefix so ElementTree
    # emits `xmlns="..."` at the root rather than `<ns0:...>` on every
    # element.
    ET.register_namespace("", SITEMAP_NS)

    tree = ET.parse(src)
    root = tree.getroot()
    urls = root.findall(f"{{{SITEMAP_NS}}}url")
    total = len(urls)

    if total <= CHUNK_SIZE:
        print(
            f"shard-sitemap urls={total} chunk={CHUNK_SIZE} "
            f"under_threshold=true action=skip"
        )
        return 0

    # Infer baseURL from the first <loc> so the sitemap index points at
    # absolute URLs on the correct host without needing a CLI arg.
    first_loc_el = urls[0].find(f"{{{SITEMAP_NS}}}loc")
    if first_loc_el is None or not first_loc_el.text:
        print("shard-sitemap: first <url> has no <loc> — cannot infer baseURL", file=sys.stderr)
        return 1
    parsed = urlparse(first_loc_el.text)
    base_url = f"{parsed.scheme}://{parsed.netloc}/"

    shard_count = math.ceil(total / CHUNK_SIZE)
    pad_width = max(3, len(str(shard_count)))
    shard_names: list[str] = []

    for i in range(shard_count):
        chunk = urls[i * CHUNK_SIZE : (i + 1) * CHUNK_SIZE]
        shard_root = ET.Element(f"{{{SITEMAP_NS}}}urlset")
        for url_el in chunk:
            shard_root.append(url_el)
        shard_name = f"sitemap-{str(i + 1).zfill(pad_width)}.xml"
        shard_path = PUBLIC_DIR / shard_name
        ET.ElementTree(shard_root).write(
            shard_path, encoding="utf-8", xml_declaration=True
        )
        shard_names.append(shard_name)

    # Rewrite sitemap.xml as a sitemap index.
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    index_root = ET.Element(f"{{{SITEMAP_NS}}}sitemapindex")
    for name in shard_names:
        sitemap_el = ET.SubElement(index_root, f"{{{SITEMAP_NS}}}sitemap")
        loc_el = ET.SubElement(sitemap_el, f"{{{SITEMAP_NS}}}loc")
        loc_el.text = base_url + name
        lastmod_el = ET.SubElement(sitemap_el, f"{{{SITEMAP_NS}}}lastmod")
        lastmod_el.text = now_iso
    ET.ElementTree(index_root).write(src, encoding="utf-8", xml_declaration=True)

    print(
        f"shard-sitemap urls={total} shards={shard_count} "
        f"chunk={CHUNK_SIZE} index={src.name}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
