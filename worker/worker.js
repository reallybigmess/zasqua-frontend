/**
 * @file worker/worker.js
 * @description Cloudflare Worker serving zasqua.org (prod) and
 *   staging.zasqua.org (staging) from R2. Handles pretty-URL resolution,
 *   edge caching, PMTiles range requests on /tiles/*, and — on the
 *   staging deployment only (STAGING=true in wrangler.toml
 *   [env.staging].vars) — two crawler-deterrent mitigations:
 *     1. /robots.txt returns a blanket Disallow: / .
 *     2. Every response carries X-Robots-Tag: noindex, nofollow.
 *
 *   Mitigation 2 was added in v0.3.0 after the first staging deploy
 *   showed that Cloudflare's zone-level Managed Robots.txt feature
 *   prepends its own content-signal block (including User-agent: *
 *   Allow: /) before the Worker's Disallow. First-match REP parsers
 *   (Googlebot, per RFC 9309) would see the Allow and ignore the
 *   later Disallow. X-Robots-Tag on every response is the reliable
 *   belt-and-braces signal.
 *
 *   Prod and staging share this one source file; behaviour diverges
 *   only on env.STAGING. No build step.
 *
 * @version v1.0.1
 */

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return stagingHeaders(new Response('Method Not Allowed', { status: 405 }), env);
    }

    const url = new URL(request.url);

    // R2 stores keys as raw UTF-8 bytes (e.g. `co-cihjml-acc-09474-
    // eclesiástico-i-cap/index.html`). Cloudflare Workers expose
    // `url.pathname` in its percent-encoded form
    // (`…eclesi%C3%A1stico…`), so a literal R2 lookup against
    // pathname would miss for every non-ASCII slug. Decode once up
    // front so subsequent logic runs against the true key. A
    // malformed %-escape (rare, usually a misbehaving client) falls
    // back to the raw pathname — the R2 lookup then misses and the
    // normal 404 path handles it, rather than the Worker throwing.
    let decodedPathname;
    try {
      decodedPathname = decodeURIComponent(url.pathname);
    } catch (_) {
      decodedPathname = url.pathname;
    }

    // On the staging deployment (STAGING=true in wrangler.toml
    // [env.staging].vars), intercept /robots.txt and serve a blanket
    // Disallow so crawlers don't index staging.zasqua.org. Prod Worker
    // passes /robots.txt through to R2 (STAGING is undefined there).
    // Paired with the X-Robots-Tag injection (see stagingHeaders) for
    // resilience against Cloudflare's Managed Robots.txt prepending an
    // Allow: / block ahead of our Disallow (v0.3.0).
    if (env.STAGING === 'true' && decodedPathname === '/robots.txt') {
      return stagingHeaders(new Response('User-agent: *\nDisallow: /\n', {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
      }), env);
    }

    // Serve PMTiles from /tiles/ path — same-origin, no CORS needed
    if (decodedPathname.startsWith('/tiles/')) {
      return stagingHeaders(await handleTiles(request, env, url), env);
    }

    let path = decodedPathname;

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
    if (response) return stagingHeaders(response, env);

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
        return stagingHeaders(response, env);
      }
      return stagingHeaders(new Response('Not Found', { status: 404 }), env);
    }

    const headers = new Headers();
    headers.set('content-type', contentType(key));
    headers.set('cache-control', cacheControl(key));
    headers.set('etag', object.httpEtag);

    response = new Response(object.body, { headers });

    // Store in edge cache (non-blocking)
    request.method === 'GET' && cache.put(cacheKey, response.clone());

    return stagingHeaders(response, env);
  },
};

// Inject X-Robots-Tag: noindex, nofollow on every staging response so
// crawlers that ignore or misparse robots.txt (or land before our
// Disallow in Cloudflare's managed robots.txt block) still skip the
// content. Prod responses pass through untouched (v0.3.0).
function stagingHeaders(response, env) {
  if (env.STAGING !== 'true') return response;
  const headers = new Headers(response.headers);
  headers.set('x-robots-tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, headers });
}

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

async function handleTiles(request, env, url) {
  const name = url.pathname.slice('/tiles/'.length);
  if (!name) return new Response('Not Found', { status: 404 });

  // PMTiles library requests /tiles/zasqua-places — append .pmtiles extension
  const key = name.endsWith('.pmtiles') ? name : name + '.pmtiles';

  const rangeHeader = request.headers.get('Range');
  const opts = {};

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const offset = parseInt(match[1]);
      const end = match[2] ? parseInt(match[2]) : undefined;
      opts.range = end !== undefined
        ? { offset, length: end - offset + 1 }
        : { offset };
    }
  }

  const object = await env.TILES.get(key, opts);
  if (!object) return new Response('Not Found', { status: 404 });

  const headers = new Headers();
  headers.set('content-type', 'application/octet-stream');
  headers.set('cache-control', 'public, max-age=86400');
  headers.set('accept-ranges', 'bytes');
  headers.set('etag', object.httpEtag);

  if (rangeHeader && object.range) {
    const { offset, length } = object.range;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', length);
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('content-length', object.size);
  return new Response(object.body, { status: 200, headers });
}

// Version: v1.0.1
