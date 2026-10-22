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

The audit is ongoing. Separate follow-ups remain for directed raw-coastline
reconstruction, feature-line influence modes, transparent/export parity,
recording cancellation/timing, and animation work avoidance. Raw Overpass remains
disabled in the deployed worker; production uses explicit ocean polygons from
free vector-tile snapshots, not the known raw-coastline fill path. No paid
provider, new credentials, or UI library migration is introduced here.
