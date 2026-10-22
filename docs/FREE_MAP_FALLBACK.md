# Free map-feature fallback

Strata is a non-commercial art project. Its feature path must not require a paid provider, account, API key, or subscription.

The browser first requests raw OSM geometry through `/overpass`. If that route is unavailable, `/map-features` can provide a small OpenFreeMap vector-tile snapshot through the same protected Worker. The existing distinct direct Overpass fallback remains last. A proxy `503` with `Retry-After` opens a client-side cooldown so subsequent areas do not repeatedly spend the shared request budget on a disabled route. A proxy `429` skips the tile route, which shares that budget.

## Data fidelity

The fallback uses OpenMapTiles-schema geometry at zoom 14, not a raw OSM object export. It can be generalized, split into tile fragments, and omit source tags. The client labels the source and dated dataset, describes counts as shapes/segments, and never presents tile feature IDs as OSM object IDs. Multi-geometries are split before area filtering; clipped fragments are filled separately to avoid artificial XOR holes at tile seams. Whole response coverage is checked before caching. Invalid or incomplete snapshots are rejected, not rendered as complete data.

OpenMapTiles and OpenStreetMap attribution is included in the app's data section and static/animated exports. Terrain attribution remains intact.

## Bounded, disabled-by-default deployment

- `MAP_TILES_ENABLED=false` is the committed default. Enable only after staging and live verification.
- The route shares the existing client and route managed rate-limit bindings and `OVERPASS_PROTECTION_STAGED` attestation. No new namespace or higher rate budget is required.
- Existing exact-origin CORS and canonical bounding-box validation apply: at most 25 km², with bounded spans.
- Each snapshot requests at most 16 zoom-14 tiles, with two concurrent tile requests, at most 2 MiB per tile and 8 MiB total. Large or polar coverage may require zooming in.
- Metadata is capped at 64 KiB. Only the fixed OpenFreeMap host and strict dated planet template are accepted; callers cannot supply upstream URLs. Redirects are not followed.
- The whole route retains the 22-second deadline. Each metadata/tile request is capped at eight seconds. A failed tile cancels its peer; no partial snapshot is served.
- Every upstream request identifies Strata honestly. Credentials, client IPs, queries and tile coordinates are not added to logs.
- A compact binary envelope avoids base64 expansion. Geometry decoding runs on the client, not on the free-plan Worker CPU budget.

OpenFreeMap's [download policy](https://openfreemap.org/tos/) allows bounded offline area downloads of at most 3,000 tiles or 50 MB, at most four parallel requests, with a unique app User-Agent. Strata's limits are smaller. The service is free and provided without an availability guarantee; this fallback is not an SLA.

## Verification

Run the normal unit, lint, type, fixture build, Worker bundle and browser gates. Stage the exact tested Worker with both feature flags off, verify its code/configuration, then activate only the tile route for one small-area check. Validate the returned binary data with the actual browser decoder, not merely HTTP 200. Check both allowed origins and export attribution. Keep raw Overpass disabled if its separate live checks still fail.
