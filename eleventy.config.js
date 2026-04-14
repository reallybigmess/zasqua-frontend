/**
 * Eleventy Configuration
 *
 * Eleventy (stylised "11ty") is the static site generator that turns the
 * archival data in `data/` and the Nunjucks templates in `src/` into the
 * finished HTML site under `_site/`. This file is Eleventy's main
 * configuration hook — it tells the generator where to find templates,
 * which folders to copy over untouched, and adds the custom filters and
 * transforms that the templates rely on.
 *
 * What this file sets up:
 *
 *   - Passthrough copies for the CSS, JS, image, and vendor asset
 *     folders, plus the per-description children shards, the per-entity
 *     and per-place link shards fetched on demand by detail pages and
 *     explorers, the explorer index files, and the curated entity graph
 *     read by the entity explorer. These are copied verbatim into
 *     `_site/` rather than being processed by Eleventy.
 *   - Watch targets for CSS and JS so `eleventy --serve` rebuilds when
 *     those folders change during development.
 *   - A set of template filters used throughout the Nunjucks views:
 *     `limit`, `splitPipe`, `safeSlug`, `formatDate`, `numberFormat`
 *     (which groups thousands with dots in the Colombian convention),
 *     `sortByOrder`, `filterByRepo`, `filterByLevel`, `findByRef`,
 *     `siblingsOf`, `extractYear`, `yearRange`, `centuryRange`,
 *     `decadeRange`, `countryName`, `escapeTemplate`, and `truncate`.
 *   - A `progress` transform that logs every five thousandth page and a
 *     post-build summary — useful because full builds render tens of
 *     thousands of description pages and can otherwise feel silent.
 *   - A `year` shortcode for the footer.
 *
 * The `escapeTemplate` filter is worth calling out: description pages
 * surface OCR text inside a hidden Pagefind body, and that OCR can
 * contain literal `{{` sequences that would otherwise trip Eleventy's
 * layout pass. The filter replaces template syntax with HTML entities
 * before the content reaches the layout engine.
 *
 * Directory layout returned at the bottom: input from `src/`, output to
 * `_site/`, includes under `src/_includes/`, layouts under
 * `src/_layouts/`, and global data under `src/_data/`. Templates are
 * Nunjucks by default, with HTML and Markdown also accepted.
 *
 * @version v0.5.0
 */

module.exports = function(eleventyConfig) {
  // Pass through static assets
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/js");
  eleventyConfig.addPassthroughCopy("src/img");
  eleventyConfig.addPassthroughCopy("src/vendor");

  // Tree children JSON (produced by the backend's export command)
  eleventyConfig.addPassthroughCopy({ "data/children": "data/children" });

  // Entity and place link shards, fetched on demand by detail pages and explorers
  eleventyConfig.addPassthroughCopy({ "data/entity-links": "data/entity-links" });
  eleventyConfig.addPassthroughCopy({ "data/place-links": "data/place-links" });

  // Explorer search index files loaded once by explorer pages.
  // Entity pages are indexed via Pagefind rather than a separate index file.
  eleventyConfig.addPassthroughCopy({ "data/place-index.json": "data/place-index.json" });

  // Curated entity graph loaded by the entity explorer's graph panel
  eleventyConfig.addPassthroughCopy({ "data/curated-entity-graph.json": "data/curated-entity-graph.json" });

  // Watch for changes in CSS/JS during dev
  eleventyConfig.addWatchTarget("src/css/");
  eleventyConfig.addWatchTarget("src/js/");

  // Custom filters
  eleventyConfig.addFilter("limit", function(arr, limit) {
    return arr.slice(0, limit);
  });

  eleventyConfig.addFilter("splitPipe", function(str) {
    if (!str) return [str];
    return str.split("|").map(function(s) { return s.trim(); });
  });

  eleventyConfig.addFilter("safeSlug", function(str) {
    if (!str) return "";
    return str.replace(/[?#]/g, "");
  });

  function formatDateNarrative(dateStr) {
    if (!dateStr) return "";

    var months = [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
    ];

    if (dateStr.indexOf(' .. ') !== -1) {
      var parts = dateStr.split(' .. ');
      return formatDateNarrative(parts[0]) + ' – ' + formatDateNarrative(parts[1]);
    }

    var match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      var day = parseInt(match[3], 10);
      var month = months[parseInt(match[2], 10) - 1];
      return day + ' de ' + month + ' de ' + match[1];
    }

    var ymMatch = dateStr.match(/^(\d{4})-(\d{2})$/);
    if (ymMatch) {
      var m = months[parseInt(ymMatch[2], 10) - 1];
      return m + ' de ' + ymMatch[1];
    }

    return dateStr;
  }

  eleventyConfig.addFilter("formatDate", formatDateNarrative);

  eleventyConfig.addFilter("numberFormat", function(num) {
    if (num === null || num === undefined) return "0";
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  });

  eleventyConfig.addFilter("sortByOrder", function(arr, orderArray) {
    if (!arr || !orderArray) return arr;
    return orderArray
      .map(code => arr.find(item => item.code === code))
      .filter(item => item !== undefined);
  });

  eleventyConfig.addFilter("filterByRepo", function(arr, repoCode) {
    if (!arr || !repoCode) return [];
    return arr.filter(item => item.repository_code === repoCode);
  });

  eleventyConfig.addFilter("filterByLevel", function(arr, level) {
    if (!arr || !level) return [];
    return arr.filter(item => item.description_level === level);
  });

  // Filter to find description by reference_code
  eleventyConfig.addFilter("findByRef", function(arr, refCode) {
    if (!arr || !refCode) return null;
    return arr.find(item => item.reference_code === refCode);
  });

  // Get siblings (other children of same parent)
  eleventyConfig.addFilter("siblingsOf", function(arr, desc) {
    if (!arr || !desc) return [];
    return arr.filter(item =>
      item.parent_id === desc.parent_id &&
      item.id !== desc.id
    );
  });

  // Extract year from a date string ("YYYY-MM-DD" → "YYYY")
  eleventyConfig.addFilter("extractYear", function(dateStr) {
    if (!dateStr) return null;
    const year = String(dateStr).substring(0, 4);
    return /^\d{4}$/.test(year) ? year : null;
  });

  // Generate an array of integers from start year to end year, capped at 500 years.
  // Used by entity Pagefind metadata to create one filter span per year in range.
  eleventyConfig.addFilter("yearRange", function(start, end) {
    if (!start) return [];
    const s = parseInt(start, 10);
    if (isNaN(s)) return [];
    const e = end ? parseInt(end, 10) : s;
    const cap = Math.min(e, s + 500);
    const years = [];
    for (let y = s; y <= cap; y++) years.push(y);
    return years;
  });

  // Distinct centuries spanned by a date range, as integer century numbers
  // (e.g. 1820..1880 → [19], 1580..1610 → [16, 17]). Used to emit one
  // Pagefind century facet tag per century an entity touches, so century-level
  // counts represent unique entities rather than year-occurrence sums.
  eleventyConfig.addFilter("centuryRange", function(start, end) {
    if (!start) return [];
    const s = parseInt(start, 10);
    if (isNaN(s)) return [];
    const e = end ? parseInt(end, 10) : s;
    const capEnd = Math.min(e, s + 500);
    const startCentury = Math.floor((s - 1) / 100) + 1;
    const endCentury = Math.floor((capEnd - 1) / 100) + 1;
    const out = [];
    for (let c = startCentury; c <= endCentury; c++) out.push(c);
    return out;
  });

  // Distinct decade base years spanned by a date range
  // (e.g. 1823..1841 → [1820, 1830, 1840]).
  eleventyConfig.addFilter("decadeRange", function(start, end) {
    if (!start) return [];
    const s = parseInt(start, 10);
    if (isNaN(s)) return [];
    const e = end ? parseInt(end, 10) : s;
    const capEnd = Math.min(e, s + 500);
    const startDecade = Math.floor(s / 10) * 10;
    const endDecade = Math.floor(capEnd / 10) * 10;
    const out = [];
    for (let d = startDecade; d <= endDecade; d += 10) out.push(d);
    return out;
  });

  // Country code to localised country name
  var countryNames = new Intl.DisplayNames(['es'], { type: 'region' });
  eleventyConfig.addFilter("countryName", function(code) {
    if (!code) return "";
    try { return countryNames.of(code); } catch (e) { return code; }
  });

  // Escape template syntax in free-text content (OCR) before it reaches
  // the layout engine, which would otherwise parse `{{` or `{%` as
  // template expressions and crash the build.
  eleventyConfig.addFilter("escapeTemplate", function(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/\{\{/g, "&#123;&#123;")
      .replace(/\}\}/g, "&#125;&#125;")
      .replace(/\{%/g, "&#123;%")
      .replace(/%\}/g, "%&#125;");
  });

  eleventyConfig.addFilter("truncate", function(str, length) {
    if (!str) return "";
    if (str.length <= length) return str;
    return str.substring(0, length) + "...";
  });

  // Build progress logging
  let pageCount = 0;
  const buildStart = Date.now();
  eleventyConfig.addTransform("progress", function(content) {
    pageCount++;
    if (pageCount % 5000 === 0) {
      const elapsed = ((Date.now() - buildStart) / 1000).toFixed(0);
      console.log(`[build] ${pageCount.toLocaleString()} pages generated (${elapsed}s)`);
    }
    return content;
  });

  eleventyConfig.on("eleventy.after", function() {
    const elapsed = ((Date.now() - buildStart) / 1000).toFixed(1);
    console.log(`[build] Complete: ${pageCount.toLocaleString()} pages in ${elapsed}s`);
  });

  // Shortcodes for common patterns
  eleventyConfig.addShortcode("year", () => `${new Date().getFullYear()}`);

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      layouts: "_layouts",
      data: "_data"
    },
    templateFormats: ["njk", "html", "md"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk"
  };
};
