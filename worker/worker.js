/**
 * Edge Worker — Serves the Site from R2
 *
 * This Cloudflare Worker is the code that answers every HTTP request
 * for zasqua.org. Cloudflare runs it in their edge network — close to
 * the visitor, not in a traditional datacentre — and gives it a direct
 * binding to the `zasqua-site` R2 bucket that holds the built site.
 *
 * The worker's job is deliberately small:
 *
 *   1. Accept only `GET` and `HEAD` requests. Anything else gets a 405.
 *   2. Normalise the URL path so it maps to a file key in R2. Paths
 *      ending in `/` become `/index.html`, and any path without a file
 *      extension is treated as a directory and rewritten the same way.
 *      This lets the static site use clean URLs like `/repositorios/`
 *      without needing an `.html` suffix.
 *   3. Check Cloudflare's edge cache first. If the response is already
 *      cached at this edge, return it immediately.
 *   4. Otherwise fetch the object from R2. If nothing is found, try to
 *      serve the custom `404.html` page; if even that is missing, fall
 *      back to a plain text 404.
 *   5. Attach the right `Content-Type`, `Cache-Control`, and `ETag`
 *      headers. The helpers at the bottom of the file map file
 *      extensions to MIME types and to cache lifetimes that mirror the
 *      ones applied at upload time by `scripts/upload-to-r2.py` — short
 *      for HTML and JSON, week-long for CSS and JS, and a year with the
 *      `immutable` flag for fonts and images.
 *   6. Store a clone of the response in the edge cache so the next
 *      visitor at this edge is served without touching R2.
 *
 * Pipeline context: the deploy workflow uploads `_site/` to the
 * `zasqua-site` R2 bucket, and this worker is what turns those objects
 * into a live site. It is configured in `wrangler.toml` and deployed
 * with `wrangler deploy`.
 *
 * @version v0.3.2
 */
export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    let path = url.pathname;

    // Resolve directory paths to index.html
    if (path.endsWith('/')) {
      path += 'index.html';
    } else if (!path.includes('.', path.lastIndexOf('/'))) {
      // No file extension — try as directory
      path += '/index.html';
    }

    // Strip leading slash for R2 key
    const key = path.slice(1);

    // Check edge cache first
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    let response = await cache.match(cacheKey);
    if (response) return response;

    // Fetch from R2
    const object = await env.SITE.get(key);

    if (!object) {
      // Try 404 page
      const notFound = await env.SITE.get('404.html');
      if (notFound) {
        response = new Response(notFound.body, {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
        return response;
      }
      return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers();
    headers.set('content-type', contentType(key));
    headers.set('cache-control', cacheControl(key));
    headers.set('etag', object.httpEtag);

    response = new Response(object.body, { headers });

    // Store in edge cache (non-blocking)
    request.method === 'GET' && cache.put(cacheKey, response.clone());

    return response;
  },
};

function contentType(key) {
  const ext = key.split('.').pop().toLowerCase();
  const types = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    ico: 'image/x-icon',
    webp: 'image/webp',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    txt: 'text/plain; charset=utf-8',
    webmanifest: 'application/manifest+json',
  };
  return types[ext] || 'application/octet-stream';
}

function cacheControl(key) {
  const ext = key.split('.').pop().toLowerCase();
  if (['html', 'xml'].includes(ext)) return 'public, max-age=3600';
  if (['css', 'js'].includes(ext)) return 'public, max-age=604800';
  if (['json'].includes(ext)) return 'public, max-age=86400';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg', 'woff', 'woff2', 'ttf'].includes(ext)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}
