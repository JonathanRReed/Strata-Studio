# Strata Studio — Agent Notes

## Repository layout

The repository intentionally has three independent Bun package boundaries and is not a workspace monorepo:

- root: launch verification, Playwright, and CI orchestration;
- `web/`: Vite + React static app deployed to Cloudflare Pages;
- `workers/proxy/`: hardened Cloudflare Worker for terrain, canonical bbox-only Overpass, and health; social metadata uses static `web/public/og.png`.

Use Bun 1.3.14. The `--cwd` flag belongs after the Bun subcommand, for example `bun run --cwd web test` and `bun install --cwd web --frozen-lockfile`.

## Primary commands

```bash
bun run install:frozen
bun run lint
bun run typecheck
bun run test:unit
bun run build:fixture
bun run check:wrangler
bun run test:launch
bun run verify:launch
```

For local development, use two terminals:

```bash
bun run dev:proxy
bun run dev:web
```

Do not replace the independent package manifests/locks with Bun workspaces.

## Build contract

Production builds require explicit values for:

- `VITE_APP_ORIGIN` — Pages/custom-domain origin;
- `VITE_TERRAIN_TILE_URL` — deployed proxy `/terrain` route;
- `VITE_OVERPASS_URL` — deployed proxy `/overpass` route.

They must be absolute HTTPS URLs. Explicit `http://localhost` or loopback values are permitted only outside production. `web/vite.config.ts` emits safe public metadata to `web/dist/build-info.json`; never add secrets or arbitrary environment dumps to it.

`web/scripts/assert-proxy-first.ts` is part of `web`'s build script. It validates the emitted `build-info.json` so shell variables and Vite mode files follow the same contract. Do not bypass it for production. CI and local verification use reserved `.example` fixture origins explicitly.

## Verification

Preserve all existing unit tests. Before completing runtime or launch work, run the highest-value supported subset of:

```bash
bun run lint
bun run typecheck
bun run test:unit
bun run build:fixture
bun run check:wrangler
bun run test:launch:built
```

Playwright launch tests use roles and stable accessible names, not pixel snapshots. Network fixtures must keep terrain and Overpass proxy-first and must not silently allow direct AWS/Overpass traffic.

## Deployment

The static site is the existing **Cloudflare Pages** project (`strata-studio`), not `web/wrangler.jsonc` or a static-assets Worker. The proxy remains a separate Worker with `cache.enabled`.

Deployment order:

1. verify the repository;
2. deploy and health-check `workers/proxy/`;
3. build `web/` with the deployed proxy routes and final app origin;
4. publish `web/dist` to Cloudflare Pages;
5. check the app root, `/build-info.json`, proxy `/health`, and the evaluator journey.

Do not commit, push, deploy, or modify Cloudflare resources unless the user explicitly asks.

## Data sources

- Basemap: OpenFreeMap vector styles through MapLibre.
- Terrain: Mapzen/Tilezen Terrarium tiles on AWS Open Data, reached through the proxy in production.
- OSM features: Overpass, proxy-first with direct mirrors retained only as runtime fallback.
- Geocoding: policy-compliant one-shot Nominatim requests.
