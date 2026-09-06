# Strata Studio

Turn terrain and OpenStreetMap features into poster art in the browser. Cloudflare Pages serves the Vite app; a separate `strata-proxy` Worker handles terrain, bounded Overpass queries, and health checks.

Root tooling, `web/`, and `workers/proxy/` are three independent Bun packages, not a workspace.

## Run locally

Requires Bun 1.3.14 and Playwright Chromium for launch tests.

```bash
bun run install:frozen
bunx playwright install chromium
bun run verify:launch
```

For development, run these in separate terminals:

```bash
bun run dev:proxy
bun run dev:web
```

The web command points terrain and Overpass requests to `http://localhost:8787`. HTTP is allowed only for explicit localhost URLs outside production.

## Data requests

The browser loads app assets and `/og.png` from Pages, terrain and Overpass data through the proxy, its basemap from OpenFreeMap, and one-shot geocoding from Nominatim. The proxy fetches AWS Terrain Tiles and builds a fixed Overpass query from validated bounds.

Production builds require explicit HTTPS app, terrain, and Overpass URLs. `web/scripts/assert-proxy-first.ts` checks that both proxy routes share one origin, appear in compiled JavaScript and `build-info.json`, and use the branded canonical origin `https://stratastudio.jonathanrreed.com/` in metadata.

## Build configuration

| Required variable | Value |
| --- | --- |
| `VITE_APP_ORIGIN` | Deployment origin without path, query, credentials, or hash. Canonical metadata still uses the branded origin. |
| `VITE_TERRAIN_TILE_URL` | Full proxy `/terrain` route; the client appends `/{z}/{x}/{y}.png` |
| `VITE_OVERPASS_URL` | Full proxy `/overpass` route; the client appends snapped bounds |

Supply values through the shell or Vite mode files such as `web/.env.production.local`. An empty shell value overrides the file and fails validation.

```bash
VITE_APP_ORIGIN=https://<pages-or-custom-domain> \
VITE_TERRAIN_TILE_URL=https://<proxy-origin>/terrain \
VITE_OVERPASS_URL=https://<proxy-origin>/overpass \
VITE_BUILD_CONTEXT=production \
bun run build
```

Optional metadata includes `VITE_BUILD_CONTEXT`, `VITE_BUILD_COMMIT`, `VITE_BUILD_BRANCH`, and `SOURCE_DATE_EPOCH`. Cloudflare and GitHub commit and branch variables are read when available. Only allowlisted, sanitized public fields are emitted. Never put secrets in these values.

## Keep Overpass disabled until protection is verified

The Worker requires exact `ALLOWED_ORIGINS` and separate `TERRAIN_ENABLED` and `OVERPASS_ENABLED` switches. Committed settings keep `OVERPASS_ENABLED=false` and `OVERPASS_PROTECTION_STAGED=false`.

Both Overpass flags must be true to enable the route. Do not enable them before a route-specific Cloudflare rate-limit or WAF rule is configured, staged, and verified. Account capability remains unverified. The Worker does not pretend that an isolate-local counter provides a global rate limit.

`/overpass` accepts only `south`, `west`, `north`, and `east` in canonical four-decimal form. It checks Mercator ranges, ordering, a 25 km² area cap, and 25 km edge caps, then constructs the fixed query server-side.

The browser tries the proxy once. The Worker can try two upstreams; the browser retains one bounded attempt against a distinct direct provider within the same deadline. See [the proxy README](workers/proxy/README.md) for this fallback and the CORS, cache, error, log, and staging rules.

## Verify

```bash
bun run verify:launch
```

The gate runs frozen installs for all packages, lint, web and proxy type checks and tests, a production fixture build, proxy assertions, a Wrangler dry-run bundle, and Chromium smoke tests.

| Command | Focus |
| --- | --- |
| `bun run lint`, `bun run typecheck`, `bun run test:unit` | Static checks and unit tests |
| `bun run build:fixture` | Deterministic build configuration |
| `bun run check:wrangler` | Bundle validation, no upload |
| `bun run test:launch` | Fixture build and Chromium smoke |
| `bun run test:launch:a11y` | Axe checks against an existing build |
| `bun run test:launch:browsers` | Firefox and WebKit checks against an existing build |

Playwright starts `vite preview` and intercepts proxy, OpenFreeMap, and Nominatim requests. These fixtures do not verify public API availability. Tests reject unexpected direct AWS terrain or public Overpass requests.

Chromium runs on each change. Main-branch checks also cover Firefox, WebKit, serious WCAG A/AA findings, and contrast without token or selector deferrals. The app requires JavaScript, Canvas 2D, WebGL, IndexedDB, and modern modules; legacy embedded browsers are out of scope.

## Deploy

Use the existing Cloudflare Pages project `strata-studio`, not an assets-only Worker.

After verification, deploy the proxy first. Confirm `/health` reports the expected build and terrain state, with Overpass disabled unless its protection was separately verified. Build the web app against the final origins, then publish `web/dist` from the same reviewed commit.

Authorized manual deployment commands:

```bash
bun run --cwd workers/proxy deploy
bunx wrangler pages deploy web/dist --project-name strata-studio --branch main
```

For Git-integrated Pages builds, use the repository root, build with `bun run install:frozen && bun run build`, and publish `web/dist`. Configure all three required `VITE_*` values for production and preview.

## Check the deployed app

```bash
curl -fsS https://<proxy-origin>/health
curl -fsS https://<app-origin>/build-info.json
curl -fsSI https://<app-origin>/
```

Build information must report `dataPolicy: "proxy-first"`, the deployment `appOrigin`, branded `canonicalOrigin`, correct proxy routes, and expected commit and branch. It must contain no credentials.

Open the site and check that the daily artwork renders. Choose Manhattan and confirm proxy-backed loading. Switch from Classic Studio to Experimental Lab, change a preset, add a Composition label, and verify the caption and canvas accessible name.

Export a 1024 PNG and inspect its filename and image. Open a shared composition URL in a private window and confirm that place, style, seed, palette, and parameters restore. Check both health endpoints before signing off.
