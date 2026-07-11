# Strata Studio — Agent Notes

Project layout: the Vite + React app lives inside `web/`. The repo root keeps `Design-idea.md` and build artifacts.

## Commands

The `--cwd` flag belongs **after** the `bun` subcommand, not before it:

```bash
bun install --cwd web
bun run --cwd web dev
bun run --cwd web build
bun run --cwd web test
bun run --cwd web lint
bun run --cwd web typecheck
bun run --cwd web format
```

`bun --cwd web <cmd>` is not valid for these commands.

## Verification

Run the full check before finishing work:

```bash
bun run --cwd web lint && bun run --cwd web typecheck && bun run --cwd web test
```

## Deployment

Two Cloudflare Workers, deliberately separate:

- **Site** (`web/wrangler.jsonc`, assets-only — free & unlimited requests):
  `bun run --cwd web build && bunx wrangler deploy --cwd web`
- **API proxy** (`workers/proxy/` — terrain/Overpass caching + OG cards, Workers
  Cache enabled): `cd workers/proxy && bunx wrangler deploy`. After deploying,
  point the app at it via `VITE_TERRAIN_TILE_URL=https://<proxy>/terrain` at
  build time (direct-to-source defaults work without it).

First deploy on a machine needs `bunx wrangler login`.

## Data sources

- Basemap: OpenFreeMap vector tiles via MapLibre (keyless, unlimited)
- Terrain tiles: Mapzen Terrain Tiles on AWS S3 (`s3://elevation-tiles-prod/terrarium`),
  endpoint swappable via `VITE_TERRAIN_TILE_URL`
- OSM features: Overpass API (overpass-api.de with mirror failover)
- Geocoding: Nominatim (search + reverse), policy-compliant single requests
