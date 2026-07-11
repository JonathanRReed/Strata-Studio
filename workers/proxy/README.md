# strata-proxy

Caching proxy Worker for Strata Studio. It fronts the third-party APIs the map
app depends on — AWS terrain tiles and the Overpass API — and renders Open
Graph share cards. Designed for the **free Workers plan**: bodies stream
through untouched (no JSON parsing in the Worker), and repeat requests are
served by **Workers Cache** without invoking the Worker at all.

## Why caching lives here (billing rationale)

Workers Cache (`cache.enabled` in `wrangler.jsonc`, GA July 2026, Wrangler
>= 4.69.0) meters **every** request that flows through a cache-enabled Worker —
including cache hits. That is exactly what we want for third-party API traffic
(a cache hit costs a request but zero CPU and zero upstream load), but it would
be a terrible deal for the static site, where every JS/CSS/image asset would
start counting against the 100k requests/day free quota. So:

- **strata-proxy (this Worker)**: `cache.enabled = true`. API responses cached
  at the edge, keyed by URL, driven purely by the `Cache-Control` headers set
  in `src/index.ts`. Request collapsing is automatic. Works on `workers.dev`.
- **The static-assets Worker (separate)**: caching off; assets are served from
  the assets pipeline and stay unmetered.

## Routes

| Route | Upstream | Cache-Control (200) |
| --- | --- | --- |
| `GET /terrain/{z}/{x}/{y}.png` | `s3.amazonaws.com/elevation-tiles-prod/terrarium/…` | `public, s-maxage=2592000, max-age=86400, immutable` (404s: `s-maxage=3600`; 5xx: uncached) |
| `GET /overpass?q={base64url}` | POST `data=` to `overpass-api.de`, one retry on 429/504 via `overpass.private.coffee`, then error passes through uncached with `Retry-After: 30` | `public, s-maxage=86400, stale-while-revalidate=86400` |
| `GET /og?place=&style=&palette=&coords=` | rendered in-Worker with `workers-og` (1200x630 PNG) | `public, s-maxage=604800` |
| `GET /health` | — | `no-store`, returns `{"ok":true}` |

All routes send `Access-Control-Allow-Origin: *` and allow `GET, OPTIONS` only.

## Integration points for the web app

Two env vars wire the app to this Worker:

```sh
# Terrain tiles: the app appends /{z}/{x}/{y}.png
VITE_TERRAIN_TILE_URL=https://strata-proxy.<your-subdomain>.workers.dev/terrain

# Overpass: the app base64url-encodes the Overpass QL query and GETs it
VITE_OVERPASS_URL=https://strata-proxy.<your-subdomain>.workers.dev/overpass
```

**The /overpass contract**: encode the raw Overpass QL query as **base64url**
(RFC 4648 §5, `-`/`_` alphabet, padding optional), pass it as `?q=`. Max query
size 8 KB decoded. Example:

```js
const q = btoa(query).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const res = await fetch(`${OVERPASS_URL}?q=${q}`);
```

GET-normalizing the query is what lets the edge cache key it — HTTP caches
don't cache POSTs. Identical queries from all users worldwide share one cached
response for a day.

**OG cards**: `GET /og?place=Kyoto&style=contour-noir&palette=1a1a2e,e94560,f5f5f5&coords=35.0116,135.7681`.
All params optional and sanitized (place capped at 80 chars, coords
pattern-checked, palette validated hex).

## Develop, test, deploy

```sh
cd workers/proxy
bun install
bun run typecheck   # tsc --noEmit
bun test            # pure logic + handler tests, no Workers runtime needed
bun run dev         # wrangler dev (local)

bunx wrangler login # first time only
bunx wrangler deploy
```

Notes:

- `limits.cpu_ms` is intentionally absent from `wrangler.jsonc` — per the
  Wrangler docs, runtime limits are only supported on the Standard (paid)
  usage model; the free plan is already hard-capped at 10 ms CPU.
- `/og` is the one CPU-heavy route (Satori + resvg WASM). Renders may exceed
  the free plan's 10 ms CPU budget on a cold render; the week-long edge cache
  means each unique card should only render once. If renders get killed,
  either accept broken cold OG images or move just this Worker to paid.
- `workers-og` fetches its default font (Bitter, from Google Fonts) at runtime
  on cold renders; that is a normal subrequest.
