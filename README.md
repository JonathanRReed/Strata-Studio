# Strata Studio

Strata Studio turns real terrain and OpenStreetMap features into generative poster art in the browser. The launch architecture has two deliberately separate Cloudflare deployments:

- **Cloudflare Pages** serves the static Vite app from `web/dist`.
- **`strata-proxy` Worker** serves hardened `/terrain`, canonical bbox-only `/overpass`, and `/health` routes, with edge caching for validated third-party data.

The repository keeps three independent Bun package boundaries—root launch tooling, `web/`, and `workers/proxy/`. It is intentionally not a workspace monorepo.

## Evaluator setup

Requirements:

- Bun **1.3.14** (pinned by the root `packageManager` and `engines` fields)
- A Chromium browser installed through Playwright for launch tests

```bash
bun run install:frozen
bunx playwright install chromium
bun run verify:launch
```

`verify:launch` runs frozen installs for all package boundaries, web lint, web and proxy typechecks, both unit suites, a production fixture build, the proxy-first post-build assertion, a Wrangler dry-run bundle, and Chromium launch smoke tests.

For a quick local product session, run these in separate terminals:

```bash
bun run dev:proxy
bun run dev:web
```

`dev:web` explicitly points the app at `http://localhost:8787/terrain` and `/overpass`. HTTP is accepted only for explicit localhost URLs outside production.

## Architecture

```text
Browser
  ├─ app shell and assets ───────── Cloudflare Pages (`web/dist`)
  ├─ terrain `/terrain/...` ───────────── `strata-proxy` ── AWS Terrain Tiles
  ├─ OSM bbox `/overpass?south=…&…` ──── `strata-proxy` ── fixed Overpass query
  ├─ static social image `/og.png` ────── Cloudflare Pages
  ├─ basemap ──────────────────────────── OpenFreeMap
  └─ one-shot geocoding ─────────── Nominatim
```

The production build is proxy-first. It refuses to build without explicit HTTPS app, terrain, and Overpass URLs. After Vite emits the app, `web/scripts/assert-proxy-first.ts` confirms that:

- terrain and Overpass target the two `strata-proxy` routes on one HTTPS origin;
- those values are embedded in the compiled JavaScript;
- `build-info.json` reports the same public configuration; and
- canonical HTML and social metadata use the branded public origin
  `https://stratastudio.jonathanrreed.com/`.

No secrets are included in the client bundle or `build-info.json`.

## Commands

```bash
# Clean, lockfile-enforced install across root, web, and proxy
bun run install:frozen

# Static checks and unit tests
bun run lint
bun run typecheck
bun run test:unit

# Deterministic production fixture build used by local verification
bun run build:fixture

# Proxy Worker bundle validation; does not upload
bun run check:wrangler

# Launch checks
bun run test:launch          # fixture build + Chromium smoke
bun run test:launch:a11y     # Chromium axe gate against an existing build
bun run test:launch:browsers # Firefox and WebKit smoke against an existing build
bun run verify:launch        # primary per-change Wave 1 gate
```

Playwright starts `vite preview` through `webServer`. Its fixtures intercept the configured proxy, OpenFreeMap style, and Nominatim requests, so the launch journey is deterministic and does not depend on public API availability. The smoke tests also fail if the app calls AWS terrain or public Overpass hosts directly.

## Production environment variables

All three variables are required for `vite build` / `bun run build`. They may be supplied by the shell or by Vite's standard mode files such as `web/.env.production.local`; an explicitly empty shell variable overrides a mode-file value and is rejected.

| Variable                | Example                                             | Contract                                                                      |
| ----------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `VITE_APP_ORIGIN`       | `https://studio.example.com`                        | Public Pages/custom-domain origin used to validate the build; no path, query, credentials, or hash. Canonical metadata is always the branded origin. |
| `VITE_TERRAIN_TILE_URL` | `https://strata-proxy.example.workers.dev/terrain`  | Full proxy terrain route; the app appends `/{z}/{x}/{y}.png`.                 |
| `VITE_OVERPASS_URL`     | `https://strata-proxy.example.workers.dev/overpass` | Full proxy Overpass route; the app appends canonical snapped bbox parameters. |

Optional safe build metadata:

| Variable                                 | Purpose                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `VITE_BUILD_CONTEXT`                     | Public label such as `ci`, `preview`, or `production`.                   |
| `VITE_BUILD_COMMIT`, `VITE_BUILD_BRANCH` | Local equivalents when Cloudflare/GitHub commit metadata is unavailable. |
| `SOURCE_DATE_EPOCH`                      | Reproducible public `builtAt` timestamp.                                 |

Cloudflare Pages and GitHub Actions metadata (`CF_PAGES_COMMIT_SHA`, `CF_PAGES_BRANCH`, `GITHUB_SHA`, and `GITHUB_REF_NAME`) is read automatically when present. Only allowlisted, sanitized fields are emitted.

Example real production build:

```bash
VITE_APP_ORIGIN=https://<pages-or-custom-domain> \
VITE_TERRAIN_TILE_URL=https://<proxy-origin>/terrain \
VITE_OVERPASS_URL=https://<proxy-origin>/overpass \
VITE_BUILD_CONTEXT=production \
bun run build
```

## Proxy safety configuration

The Worker requires an exact `ALLOWED_ORIGINS` list and has independent `TERRAIN_ENABLED` and `OVERPASS_ENABLED` emergency switches. Committed configuration keeps `OVERPASS_ENABLED=false` and `OVERPASS_PROTECTION_STAGED=false`. The Overpass route remains disabled unless both are explicitly set to `true`; do not enable them until a Cloudflare route-specific rate-limit/WAF rule for `/overpass` has been configured, staged, and verified. The account capability is currently unverified, and the Worker intentionally has no unreliable isolate-local "global" rate limiter.

`/overpass` accepts only `south`, `west`, `north`, and `east` in canonical four-decimal form, validates Web Mercator ranges, ordering, the 25 km² cap, and a 25 km per-edge span cap, then builds Strata Studio's fixed query server-side. The browser tries that proxy contract once; the Worker can try two upstreams, and the browser retains one bounded attempt against a distinct direct provider under the same total deadline. See `workers/proxy/README.md` for CORS, health, error, cache, log, and staging details.

## Cloudflare deployment order

The site deployment is the existing **Cloudflare Pages** project, not an assets-only Worker.

1. Run `bun run verify:launch`.
2. Deploy `workers/proxy/` first and confirm `GET /health` reports the expected build, terrain state, and Overpass disabled unless staged edge protection has been separately verified.
3. Build the web app with the final Pages/custom-domain origin and the deployed proxy routes.
4. Publish `web/dist` to the existing Pages project (project name `strata-studio`) or let its Git integration build the same commit.
5. Run the health checks and the five-minute journey below.

Manual commands, when deployment is intentionally authorized:

```bash
bun run --cwd workers/proxy deploy
bunx wrangler pages deploy web/dist --project-name strata-studio --branch main
```

For Pages Git builds, use repository root as the working directory, `bun run install:frozen && bun run build` as the build command, and `web/dist` as the output directory. Configure the three required `VITE_*` values in Pages for production and preview environments.

## Health checks

```bash
curl -fsS https://<proxy-origin>/health
curl -fsS https://<app-origin>/build-info.json
curl -fsSI https://<app-origin>/
```

A healthy `build-info.json` has `dataPolicy: "proxy-first"`, the branded `appOrigin` and `canonicalOrigin`, the deployed `/terrain` and `/overpass` routes, and the expected commit/branch. It must not contain credentials or private environment values.

## Supported browsers

The launch gate covers current Playwright Chromium on every change, plus current Firefox, WebKit, and serious WCAG A/AA checks on pushes to `main`. Color contrast runs without token or selector deferrals. The product requires JavaScript, Canvas 2D, WebGL for MapLibre, IndexedDB, and modern module support. Current Chrome/Edge, Firefox, and Safari are supported; embedded legacy browsers are not.

## Five-minute product journey

1. Open the Pages URL and confirm the daily place automatically renders an artwork without an error banner.
2. Expand the map, choose **Manhattan**, and confirm the poster regenerates and feature loading uses the proxy.
3. Switch from **Classic Studio** to **Experimental Lab** and select a style or preset.
4. Open **Composition**, enter a label, and generate again; confirm the canvas accessible name and caption reflect it.
5. Open **Export…**, choose 1024 PNG, export it, then verify the downloaded filename and image.
6. Copy or share the composition URL, open it in a private window, and confirm place, style, seed, palette, and parameters restore.
7. Check `/build-info.json` and the proxy `/health` endpoint before signing off.
