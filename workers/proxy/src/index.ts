/**
 * strata-proxy — caching proxy Worker for Strata Studio.
 *
 * Sits in front of third-party APIs (AWS terrain tiles, Overpass) and renders
 * OG share cards. Edge caching is provided by Workers Cache (`cache.enabled`
 * in wrangler.jsonc) and is driven ENTIRELY by the Cache-Control headers set
 * on the responses below — no caches.default, no cache API calls.
 *
 * Free-plan constraints shape this file: bodies are STREAMED through
 * untouched (never parsed/transformed), and all pure logic lives in logic.ts
 * so it stays unit-testable without the Workers runtime.
 */

import {
  CACHE_NONE,
  CACHE_OG_OK,
  CORS_HEADERS,
  OVERPASS_MIRROR,
  OVERPASS_PRIMARY,
  decodeOverpassQuery,
  overpassCacheControl,
  parseOgParams,
  parseTerrainPath,
  shouldRetryOverpass,
  terrainCacheControl,
  terrainUpstreamUrl,
} from "./logic";

export interface Env {}

export default {
  async fetch(request, _env, _ctx): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return json(
        { error: "method not allowed" },
        405,
        { Allow: "GET, OPTIONS" },
      );
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true }, 200);
    }
    if (url.pathname.startsWith("/terrain/")) {
      return handleTerrain(url);
    }
    if (url.pathname === "/overpass") {
      return handleOverpass(url);
    }
    if (url.pathname === "/og") {
      return handleOg(url);
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// GET /terrain/{z}/{x}/{y}.png  →  AWS Terrain Tiles (Terrarium encoding)
// ---------------------------------------------------------------------------

async function handleTerrain(url: URL): Promise<Response> {
  const tile = parseTerrainPath(url.pathname);
  if (!tile) {
    return json({ error: "invalid tile coordinates" }, 400);
  }

  let upstream: Response;
  try {
    upstream = await fetch(terrainUpstreamUrl(tile));
  } catch {
    return json({ error: "terrain upstream unreachable" }, 502);
  }

  return passThrough(upstream, terrainCacheControl(upstream.status));
}

// ---------------------------------------------------------------------------
// GET /overpass?q={base64url}  →  POST data= to Overpass API
//
// GET-normalized so the edge cache can key the query via the URL (HTTP
// caches don't cache POSTs); the Worker re-POSTs the decoded query upstream.
// On 429/504 (or a network failure) it tries the mirror ONCE, then gives up.
// ---------------------------------------------------------------------------

async function handleOverpass(url: URL): Promise<Response> {
  const decoded = decodeOverpassQuery(url.searchParams.get("q"));
  if (!decoded.ok) {
    return json({ error: decoded.error }, 400);
  }

  let upstream: Response | undefined;
  try {
    upstream = await postOverpass(OVERPASS_PRIMARY, decoded.query);
  } catch {
    // network failure counts as retryable; fall through to the mirror
  }

  if (!upstream || shouldRetryOverpass(upstream.status)) {
    // One retry total, ever.
    try {
      upstream = await postOverpass(OVERPASS_MIRROR, decoded.query);
    } catch {
      // keep the primary's error response if we have one
    }
  }

  if (!upstream) {
    return json({ error: "overpass upstream unreachable" }, 502, {
      "Retry-After": "30",
    });
  }

  const response = passThrough(upstream, overpassCacheControl(upstream.status));
  if (upstream.status === 429 || upstream.status >= 500) {
    // Preserve the upstream's Retry-After; supply 30s if none present.
    response.headers.set(
      "Retry-After",
      upstream.headers.get("Retry-After") ?? "30",
    );
  }
  return response;
}

function postOverpass(endpoint: string, query: string): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }).toString(),
  });
}

// ---------------------------------------------------------------------------
// GET /og?place=&style=&palette=&coords=  →  1200x630 PNG share card
//
// workers-og (Satori + resvg WASM) is imported lazily so the rest of the
// Worker — and the unit tests — never pay for or depend on the WASM modules.
// ---------------------------------------------------------------------------

async function handleOg(url: URL): Promise<Response> {
  const params = parseOgParams(url.searchParams);
  try {
    const { renderOgCard } = await import("./og");
    const image = await renderOgCard(params);
    const headers = corsHeaders();
    headers.set("Cache-Control", CACHE_OG_OK);
    headers.set("Content-Type", "image/png");
    return new Response(image.body, { status: 200, headers });
  } catch {
    return json({ error: "og render failed" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function corsHeaders(): Headers {
  return new Headers(CORS_HEADERS);
}

/**
 * Stream an upstream body through untouched, with our own cache policy and
 * CORS headers. Content-Type is preserved; upstream cache headers are NOT
 * (the Workers Cache must only ever see the policy we choose).
 */
function passThrough(upstream: Response, cacheControl: string): Response {
  const headers = corsHeaders();
  headers.set("Cache-Control", cacheControl);
  const contentType = upstream.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);

  const body =
    upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
  return new Response(body, { status: upstream.status, headers });
}

function json(
  data: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = corsHeaders();
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", CACHE_NONE);
  for (const [k, v] of Object.entries(extraHeaders ?? {})) {
    headers.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers });
}
