# New York source-data repair

## Reproduced failures (22 October 2026)

The user's New York screenshot showed a failed feature download, enabled
influence controls, and terrain extrema of about −1576…43 m. Without masks,
those controls had nothing to affect. This is an incomplete map, not successful
terrain-only output.

Independent raw-file checks found catastrophic spikes in the old Terrarium RGB
source, before browser decoding or interpolation:

- At 40.79204410, −73.98133278: Terrarium z13 reported −1203.113 m;
  matching-resolution scalar GeoTIFF reported +4 m; USGS EPQS reported −0.6315 m.
- At 40.80640339, −73.93163681: Terrarium z12 reported −1526.223 m;
  scalar GeoTIFF reported +1 m; USGS EPQS reported −1.3200 m.

The exact screenshot pixel was not identified because its full bounds were not
available. These measurements demonstrate a format-level improvement at the
sampled locations, not survey accuracy or universally error-free terrain.
The inspected AWS source files were last modified in December 2017; coastal
resolution/source-age disagreement with current USGS remains.

## Changes

- Protected OpenFreeMap vector tiles are now the primary geometry path. Raw
  public Overpass is no longer probed first in production, nor used as an
  unreliable automatic fallback. Streets/water/buildings retain source and
  snapshot attribution. Whole-area coverage and resource bounds remain enforced.
- The scalar `/terrain-geotiff` route serves fixed-source, validated GeoTIFFs.
  The legacy PNG route remains for older clients. GeoTIFF.js decodes Int16 and
  Float32, including Deflate predictors 2/3. 512px scalar data is averaged at
  canonical 256px pixel centers; encoded RGB is never resized.
- Terrain cache keys are versioned so corrupt old PNG-derived elevations cannot
  be reused. Missing/invalid samples and incomplete tile coverage fail explicitly
  instead of inventing zero-height terrain. Legitimate negative heights remain.
- Failed/missing map data disables ineffective feature controls and marks the
  preview incomplete. Artwork exports require completed geometry; saving/copying
  composition settings remains possible. A complete empty collection is valid.

## Evidence and limits

- [Tilezen formats](https://github.com/tilezen/joerd/blob/master/docs/formats.md#geotiff)
- [Tilezen service URLs](https://github.com/tilezen/joerd/blob/master/docs/use-service.md)
- [USGS point 1](https://epqs.nationalmap.gov/v1/json?x=-73.98133277893066&y=40.79204409933512&units=Meters&wkid=4326&includeDate=False)
- [USGS point 2](https://epqs.nationalmap.gov/v1/json?x=-73.93163681030273&y=40.8064033900658&units=Meters&wkid=4326&includeDate=False)
- [OpenFreeMap download policy](https://openfreemap.org/tos/)
- [Overpass public-service constraints](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)
- [GeoTIFF.js](https://github.com/geotiffjs/geotiff.js)

OpenFreeMap geometry is generalized and clipped, not surveyed cadastral data.
The current detail cap remains 25 km², at most 16 z14 tiles and 8 MiB per snapshot.
USGS 3DEP raw TIFF was independently viable as a future US-specific precision
source, but is not silently substituted or advertised as this release's source.
Mapterhorn could not be validated after HTTP 403 responses; no access workaround
was attempted and no improved accuracy is claimed for it.

The real regression fixture `tests/launch/terrain-fixture.tif` is the unmodified
public AWS GeoTIFF z12/1206/1538, used with the source attribution above.
`web/src/data/fixtures/float-terrain.tif` is a synthetic Float32 ramp encoded with
Deflate/predictor 3, testing scalar precision and pixel-center averaging.
