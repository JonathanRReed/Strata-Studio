# Strata Studio deployment audit — October 22, 2026

## Verified live observations

The custom domain's public `/build-info.json` identifies production commit
`c4fd3ebbfd2d09a858fe070aa99a6e286918f481`, built October 14. It points terrain and
Overpass requests at `https://strata-proxy.jonathanrayreed.workers.dev`.

- Proxy `/health` with Origin `https://stratastudio.jonathanrreed.com` returned
  HTTP 403 with `origin_forbidden` and no matching CORS response header.
- The same endpoint with Origin `https://strata-studio.pages.dev` returned 200,
  allowed that exact origin, and reported terrain enabled, Overpass disabled,
  and proxy build `0ac115e`.

These are deployment failures, not proof that the public Overpass upstreams are
experiencing an outage. The deployed origin allowlist and route state must be
reconciled. This audit did not change Cloudflare settings or bypass safeguards.

## Repair requirements

1. Add the exact production custom-domain origin to the proxy allowlist while
   preserving the intended Pages origin. Do not replace the list with a wildcard.
2. Establish and verify the route-specific protection required by the existing
   proxy design before attesting protection is staged and enabling Overpass.
3. Deploy and verify proxy health from both intended application origins, then
   verify a small canonical Overpass request, the live browser journey, and export.
4. Run `bun run check:deployment https://stratastudio.jonathanrreed.com` after
   deployment. An HTTP 200 alone is insufficient: this read-only check also
   requires matching CORS and both terrain and Overpass enabled.

The check deliberately does not enable routes or edit edge/security settings.
Passing it is a readiness preflight, not proof of upstream availability, map
accuracy, rendering correctness, or successful export.

## Code correction

A synthetic regression demonstrated that untagged recursive OSM member ways
were emitted as standalone buildings. Such ways are now retained as relation
geometry inputs but excluded from independent feature emission unless they have
an actual supported building, highway, or water tag. This prevents invented
buildings without discarding supported tagged features.

## Verification

Deployment checker regressions cover exact-origin CORS, disabled OSM despite a
200 health response, malformed health objects, and forbidden origins. The live
check reproduced the custom-domain failure. Full local and CI checks are recorded
separately; no live deployment or rendered-browser completion is claimed here.

Local lint, web/proxy type checks, all unit tests (4 deployment checks,
381 web tests, 35 proxy tests), production fixture build, and Worker bundle
validation passed. Wrangler's dry run required its log/config paths to point
at writable temporary directories; no deployment was performed. The first
browser run could not launch because its required Chromium binary was missing;
browser verification remains pending installation and rerun.
The supported Playwright Chromium installer subsequently failed because its
repeated CDN downloads were empty/truncated ZIPs. No browser assertions were
successfully exercised locally; use CI's browser job before merging.
