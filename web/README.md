# Strata Studio web app

Vite + React client for Strata Studio. Production output is static and is published from `web/dist` to the existing Cloudflare Pages project. API/data traffic is handled by the separate `workers/proxy/` Worker.

## Install and develop

From the repository root:

```bash
bun run install:frozen
bun run dev:proxy # terminal 1
bun run dev:web   # terminal 2
```

The root development command supplies explicit localhost values:

- `VITE_APP_ORIGIN=http://localhost:5173`
- `VITE_TERRAIN_TILE_URL=http://localhost:8787/terrain`
- `VITE_OVERPASS_URL=http://localhost:8787/overpass`

Local HTTP is accepted only for localhost/loopback. Production requires HTTPS.

## Checks

```bash
bun run --cwd web lint
bun run --cwd web typecheck
bun run --cwd web test
bun run build:fixture       # repository-root command
bun run test:launch         # repository-root fixture build + Chromium smoke
```

The existing Bun unit suite remains under `src/**/*.test.ts`. Root Playwright tests live under `tests/launch/` and drive a built app through Vite preview.

## Production build

All production builds require explicit public origins:

```bash
VITE_APP_ORIGIN=https://<pages-or-custom-domain> \
VITE_TERRAIN_TILE_URL=https://<proxy-origin>/terrain \
VITE_OVERPASS_URL=https://<proxy-origin>/overpass \
VITE_BUILD_CONTEXT=production \
bun run --cwd web build
```

`vite.config.ts` validates those URLs from the shell or Vite mode files, pins canonical and Open Graph/Twitter metadata to `https://stratastudio.jonathanrreed.com/`, and emits `dist/build-info.json`. The build then runs `scripts/assert-proxy-first.ts`, which validates the emitted configuration and rejects direct upstream endpoints or a bundle that does not contain the configured proxy routes.

`build-info.json` contains only safe public deployment metadata: app/version, timestamp, sanitized commit/branch/context/provider, the validated deployment or preview app origin, the branded canonical origin, data policy, and data routes. Do not add secrets.

## Cloudflare Pages

- Project: `strata-studio`
- Repository working directory: root
- Build command: `bun run install:frozen && bun run build`
- Output directory: `web/dist`
- Required production/preview variables: the three `VITE_*` URLs above

The obsolete `web/wrangler.jsonc` assets-only Worker configuration has been removed. Pages serves the app; `workers/proxy/` is deployed separately and first.

## Runtime and browser expectations

The app uses Canvas 2D for artwork, WebGL through MapLibre, IndexedDB for map caches, and modern ES modules. Current Chrome/Edge, Firefox, and Safari are supported. CI runs Chromium smoke on every change and Firefox/WebKit plus serious axe accessibility coverage on `main`; color contrast has no selector or token deferrals.

## Evaluator journey

1. Load the app and wait for the daily place to render automatically.
2. Expand the map and choose a curated place such as Manhattan.
3. Switch studios, select a style/preset, and adjust terrain or feature controls.
4. Open Composition, add a label, and generate.
5. Export a 1024 PNG and verify the download.
6. Copy/share the URL and confirm the composition restores in a new session.

Health surfaces are the Pages root, `/build-info.json`, and the proxy `/health` route.
