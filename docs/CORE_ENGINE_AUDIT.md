# Core engine audit, October 22, 2026

This is a correctness and performance pass, not a UI redesign or a claim of
survey-grade geography. The free snapshot-backed map pipeline remains unchanged.

## Fixed with failing-first regression tests

- Terrain samples are registered at pixel centers and bilinearly interpolated
  across tile boundaries. The requested tile range includes interpolation halos;
  finite world boundaries clamp rather than wrap to another pole.
- Feature projection and cropped terrain bounds use the same Web Mercator rows.
- Boundary elevation gradients use their actual one-sided sample intervals.
  Flow and Magnetic Field convert normalized derivatives to pixel derivatives
  before forming tangents, including non-square artwork.
- The waveform row budget now spreads capped rows across the entire artwork.
- Draw animation reveals physical path length, including closing edges, instead
  of vertex count. Filled polygons fade rather than inventing closing chords.
- Contour extraction retains shared lattice identities, tiny loops, exact-zero
  edges and branch junctions. Bilinear saddle decisions use the exact determinant
  sign when floating-point products are inconclusive, not an arbitrary epsilon.
  A critical saddle is a real four-way junction, not an invented pairing.
- Nested water holes belong to only their smallest enclosing outer ring.

`fast-check` is a development-only dependency. Seeded property tests cover 600
random scalar fields plus 600 projection/draw cases; explicit fixtures cover
seams, boundary behavior, topology and exact/near-critical saddles. These are
bounded tests, not a mathematical proof for arbitrary input.

## Performance evidence

Each contour lattice is sampled once per level. Cells missing the level are
rejected before allocations; graph identities and safe segment keys are numeric.
The first topology rewrite was slower, so it was optimized before publication.

Run `bun scripts/benchmark-contours.ts` (optionally `--stress`) for alternating,
warmed comparisons against the pinned pre-audit commit. It tests 12 levels of a
smooth field and a high-frequency field at n=128; n=256 is stress-only (current
styles cap at n=144). Timings are diagnostic, machine-dependent and not CI gates.
Contour point counts can legitimately change where old topology was incorrect.

## Sources and limits

Pixel registration follows [Tilezen's Mercator geotransform](https://github.com/tilezen/joerd/blob/master/joerd/mercator.py#L76-L91),
its [Terrarium raster encoding](https://github.com/tilezen/joerd/blob/master/joerd/output/terrarium.py#L40-L76),
and [GDAL's pixel-center convention](https://gdal.org/en/stable/tutorials/geotransforms_tut.html).
Marching squares still approximates bilinear curves with straight segments;
optional artistic smoothing is not a geographic accuracy guarantee.

The audit is ongoing. The rendering/export section below tracks the next pass;
directed raw-coastline reconstruction remains separate. Raw Overpass remains
disabled in the deployed worker; production uses explicit ocean polygons from
free vector-tile snapshots, not the known raw-coastline fill path. No paid
provider, new credentials, or UI library migration is introduced here.

## Rendering and export follow-up

- Feature-line influence now uses signed ink gain: amplification strengthens
  line weight, flattening fades ink, and inversion passes through zero into
  knockout ink. Weight/fade is the arc-length-weighted mean per uninterrupted
  same-sign line, avoiding per-vertex seams and draw-call explosion; it is not a
  continuous local stroke-width gradient. Original geographic vertices are retained; sign crossings add
  only a collinear interpolated point. Cyclic runs merge across the arbitrary
  first vertex; knockout ink is applied last within each line. Interrupted rings
  never close across gaps.
- Static PNG/SVG honor the saved transparency setting. SVG erases the composed
  prefix in painter order, rather than deleting occlusion shapes or independently
  masking earlier layers (which would reveal hidden ink). Adjacent erasers share
  a mask. Transparent SVG rejects more than 128 mask layers or a cumulative
  estimated 128-megapixel mask surface; PNG/lower detail is the explicit fallback.
- SVG glow uses tight user-space filter regions, including zero-height/width
  paths. Transparent Canvas grain preserves alpha; SVG uses gray soft-light
  grain and restores source coverage. Grain textures remain renderer-specific,
  not byte-identical between Canvas and SVG.
- Draw/parallax preview does not redraw duplicate discrete frames. Drift still
  updates continuously. Hook tests verify generation counts and RAF cleanup.
- Font waits are shared, caller-cancellable, and bounded to five seconds with
  fallback faces. They do not wait for unrelated document fonts.
- WebM pre-renders artwork before starting its recording clock and schedules
  frames against absolute deadlines. A paused browser produces an explicit error
  rather than a silently stretched video. Missing stop callbacks can be cancelled
  and have a ten-second deadline. Tracks/listeners are cleaned up on every exit.
  Native WebM capture remains best-effort real-time, not deterministic offline
  encoding; brief stalls can still affect frame timestamps.
- UI exports retain preview loop speed. GIF/APNG quantize cumulative timestamps
  rather than accumulating one rounding error per frame. Transparent WebM is
  explicitly unsupported; GIF/APNG remain alternatives. Raw animation buffers
  are limited to 128 MiB, with finite frame-count/FPS validation.

The soft-light calculation follows [W3C Compositing, §10.1.10](https://www.w3.org/TR/compositing-1/#blendingsoftlight).
Browser pixel fixtures cover partial-alpha cutouts, later paint followed by
another cut, transparent grain, and a horizontal glowing line. These complement
unit tests; they must pass in CI before release. Main-thread APNG final encoding,
portable SVG font embedding, and raw-coastline topology remain follow-ups.
