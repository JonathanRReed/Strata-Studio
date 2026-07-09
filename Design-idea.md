Yes. Build **Strata Studio** as a static, browser-only generative map-art tool with two modes: **Classic Studio** for polished cartographic poster styles, and **Experimental Lab** for terrain-driven waveform/noise art. The strongest MVP is the waveform terrain slice renderer, because it is visually distinctive and technically interesting without needing a backend.

Confidence: 92/100

# Strata Studio Design Doc

## 1. Product Summary

**Strata Studio** is a web app that turns real places into generative map artwork. The user chooses a location, selects an art mode, adjusts visual controls, and exports a high-resolution image.

The app should feel less like Google Maps and more like an album-cover generator for geography. It uses real terrain, roads, water, boundaries, or building shapes as raw material, then transforms them into stylized linework, waveforms, contour art, and noise-driven compositions.

The final app should be hostable for free on **Cloudflare Pages** as a static site. Cloudflare Pages supports static site hosting and its free plan includes unlimited sites, unlimited static requests, and unlimited bandwidth, though individual static assets have limits such as 20,000 files per site and 25 MiB max per asset. ([Cloudflare Pages][1])

## 2. Core Concept

User flow:

1. Pick a place.
2. Pick a studio.
3. Pick a style.
4. Adjust sliders.
5. Export the artwork.

The app does not use AI inside the product. AI is only used to help build the app.

The value is in the rendering engine: real-world geography becomes abstract visual design.

## 3. Studios

## Classic Studio

Classic Studio is the polished side. It creates clean map posters that users would actually print, use as a wallpaper, or post.

Classic styles:

| Style         | Description                                                                             |
| ------------- | --------------------------------------------------------------------------------------- |
| **Contour**   | Traditional topographic contour lines with clean spacing and elevation bands.           |
| **Ridge**     | Dense ridge-line map inspired by topographic terrain and physical product map patterns. |
| **Flow**      | Streets, rivers, and coastlines are bent into smooth flow-field paths.                  |
| **Blueprint** | Thin cyan/white technical drawing style with grid overlays and labels.                  |
| **Woodcut**   | Rough ink-like carved linework with grain, imperfections, and hatch shading.            |
| **Drift**     | Roads and boundaries slightly offset into dreamy layered motion trails.                 |
| **Signal**    | Urban street grids rendered like circuit traces or radio paths.                         |

Classic controls:

| Control        | Function                                                   |
| -------------- | ---------------------------------------------------------- |
| Line thickness | Controls stroke weight.                                    |
| Detail         | Simplifies or preserves geometry.                          |
| Spacing        | Controls contour or line density.                          |
| Palette        | Black/white, cream/ink, blueprint, neon, desert, glacier.  |
| Grain          | Adds paper or print texture.                               |
| Label toggle   | Optional city/place label.                                 |
| Crop shape     | Square, poster, album cover, phone wallpaper, wide banner. |
| Rotation       | Rotates final composition without changing source map.     |

Classic Studio should feel reliable. Every preset should look good with minimal tweaking.

## Experimental Lab

Experimental Lab is the weird side. This is where the product becomes memorable.

Experimental styles:

| Style                     | Description                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Waveform Terrain**      | Terrain is sliced into horizontal rows, each row displaced upward by elevation, like a topographic “Unknown Pleasures” style image. |
| **Noise Amplifier**       | Terrain, buildings, or roads act as amplitude sources for signal-like white waves on black.                                         |
| **Seismic**               | Elevation becomes earthquake-style wave traces. Sharp peaks create violent breaks.                                                  |
| **Melt Map**              | Roads, rivers, and elevation contours drip downward like heat distortion.                                                           |
| **Gravity Well**          | Features bend toward the highest peak, city center, river, or selected point.                                                       |
| **Magnetic Field**        | Lines wrap around roads, buildings, peaks, or water like iron filings.                                                              |
| **Pulse Rings**           | Concentric rings radiate from selected points, distorted by terrain.                                                                |
| **Terrain Sonogram**      | Elevation becomes a dense spectrogram-like field of vertical intensity lines.                                                       |
| **Building Interference** | Building footprints interrupt and modulate waveform lines. This matches the black background, white sound-wave-over-building idea.  |

Experimental controls:

| Control              | Function                                                  |
| -------------------- | --------------------------------------------------------- |
| Slice count          | Number of horizontal waveform rows.                       |
| Amplitude            | How strongly elevation affects each line.                 |
| Compression          | Controls vertical stacking density.                       |
| Noise warp           | Adds Perlin/simplex noise distortion.                     |
| Occlusion            | Lets foreground waves hide rear waves, creating 3D depth. |
| Terrain exaggeration | Makes mountains or hills more dramatic.                   |
| Building influence   | Makes buildings cut, lift, or distort waveforms.          |
| Street influence     | Makes roads act as signal paths.                          |
| Water influence      | Makes rivers/lakes flatten, invert, or glow.              |
| Chaos                | Adds controlled randomness.                               |
| Seed                 | Locks a generated variation so it can be recreated.       |

Experimental Lab should feel like a visual synth. Sliders should invite play.

## 4. Visual Direction

Primary default look:

Black background. White linework. High contrast. Album-cover energy.

The most important signature style is:

**White waveform lines over black, where terrain and buildings distort the lines.**

Visual references by style family:

| Visual Idea                    | App Translation                                 |
| ------------------------------ | ----------------------------------------------- |
| Sound waves                    | Horizontal terrain slices become waveform rows. |
| Topographic maps               | Elevation becomes contour and ridge structure.  |
| Dbrand/Ridge-like map patterns | Dense black-and-white geographic linework.      |
| Seismic readouts               | Terrain becomes sharp oscillating trace lines.  |
| Album covers                   | Square export, minimal label, high contrast.    |
| Technical diagrams             | Fine strokes, grids, annotation marks.          |
| Woodcut prints                 | Imperfect hatching, roughened strokes.          |

## 5. Recommended MVP

The MVP should not try to do every style. Build one excellent vertical slice.

MVP name:

**Strata Studio: Experimental Lab / Waveform Terrain**

MVP features:

1. Location search or manual map selection.
2. Square art canvas.
3. Fetch elevation data for the selected area.
4. Render waveform terrain slices.
5. Add optional building/road overlays.
6. Sliders for amplitude, spacing, noise, thickness, crop, and seed.
7. Export PNG and SVG.

This MVP proves the concept. It also tests an AI coding model well because it requires UI work, geospatial math, image processing, procedural rendering, and export handling.

## 6. Technical Architecture

Recommended stack:

| Layer            | Choice                                        |
| ---------------- | --------------------------------------------- |
| Framework        | Vite + React + TypeScript                     |
| Styling          | Tailwind CSS or plain CSS modules             |
| Map preview      | MapLibre GL JS                                |
| Rendering        | Canvas 2D first, SVG export second            |
| Geometry tools   | Turf.js or small custom utilities             |
| Elevation source | Public raster terrain tiles                   |
| Map data         | OpenStreetMap-derived data, carefully limited |
| Hosting          | Cloudflare Pages                              |
| Storage          | Browser localStorage / IndexedDB only         |
| Backend          | None for MVP                                  |

MapLibre GL JS is a TypeScript/WebGL library for rendering interactive maps from vector tiles in the browser, which makes it suitable for the location picker and preview map. ([MapLibre][2])

For elevation, the cleanest free-data route is to use tiled public terrain data. AWS lists Terrain Tiles as a global bare-earth terrain-height dataset provided on S3. ([Open Data Registry][3])

For OSM feature data, Overpass API can query OpenStreetMap objects by area, but public instances are shared infrastructure. Its documentation warns against relying on public instances as a backend for larger public apps and gives broad safety guidance around request volume and download size. ([Overpass API][4])

So the honest design decision is:

For a personal/demo MVP, use small, user-triggered Overpass queries with caching. For a public product, move to static prebuilt tiles, PMTiles, or a proper data provider.

## 7. Data Strategy

The app needs three types of data.

### A. Location

Options:

1. User types a place name.
2. User pans/zooms a map and clicks “Use this area.”
3. User enters coordinates.

Best MVP choice: support manual map selection first. Add search second.

Reason: search creates API policy problems faster than map selection. Nominatim, the common OSM geocoder, allows moderate user-triggered use but forbids client-side autocomplete and bulk/systematic use on the public API. ([OSMF Operations][5])

### B. Terrain

Terrain data powers the waveform style.

Process:

1. Convert selected bounds into tile coordinates.
2. Fetch raster elevation tiles.
3. Decode pixel values into elevation.
4. Normalize elevations to the selected area.
5. Sample rows across the heightmap.
6. Generate lines.

### C. Map Features

Feature data powers roads, buildings, water, and boundaries.

Use cases:

| Feature       | Visual Role                              |
| ------------- | ---------------------------------------- |
| Roads         | Signal lines, interruptions, glow paths. |
| Buildings     | Waveform blockers or amplifiers.         |
| Rivers        | Flattening/inversion zones.              |
| Water         | Negative space or smooth cutouts.        |
| Boundaries    | Poster framing or subtle outlines.       |
| Parks/landuse | Texture regions.                         |

MVP should only support buildings, roads, and water. More than that bloats the first version.

## 8. Rendering Engine

The rendering engine should be independent from React. Treat it like a small graphics library.

Suggested folder structure:

```txt
src/
  app/
    App.tsx
    routes/
    components/
  studios/
    classic/
      contourStyle.ts
      ridgeStyle.ts
      flowStyle.ts
    experimental/
      waveformTerrain.ts
      seismic.ts
      magneticField.ts
  engine/
    canvasRenderer.ts
    svgRenderer.ts
    geometry.ts
    elevation.ts
    noise.ts
    projection.ts
    export.ts
  data/
    terrainTiles.ts
    osmOverpass.ts
    cache.ts
  presets/
    palettes.ts
    stylePresets.ts
```

Core rendering interface:

```ts
type ArtworkInput = {
  bounds: GeoBounds;
  elevationGrid?: ElevationGrid;
  features?: GeoJSON.FeatureCollection;
  seed: string;
  width: number;
  height: number;
};

type StyleParams = {
  lineWidth: number;
  spacing: number;
  amplitude: number;
  noise: number;
  detail: number;
  palette: Palette;
};

type ArtStyle = {
  id: string;
  name: string;
  studio: "classic" | "experimental";
  defaultParams: StyleParams;
  renderCanvas(ctx: CanvasRenderingContext2D, input: ArtworkInput, params: StyleParams): void;
  renderSvg?(input: ArtworkInput, params: StyleParams): string;
};
```

This keeps the app extensible. Each style is just a renderer with parameters.

## 9. Waveform Terrain Algorithm

This is the key feature.

Input:

* Selected map bounds.
* Elevation grid.
* Optional buildings/roads/water.
* Canvas size.
* Style parameters.

Algorithm:

1. Project selected bounds into a normalized square coordinate space.
2. Build an elevation grid from terrain tiles.
3. Normalize elevation values between 0 and 1.
4. Create horizontal sample rows from top to bottom.
5. For each row:

   * Sample elevation across x positions.
   * Convert elevation to vertical displacement.
   * Add controlled noise.
   * Apply building/road/water influence.
   * Smooth into a spline.
   * Draw the row as a white stroke.
6. Apply optional occlusion so front lines cover back lines.
7. Add subtle grain or glow.
8. Export.

Simple formula:

$$
y'(x) = y - A \cdot h(x,y) + N(x,y) \cdot W
$$

Where:

* $y'$ is the rendered y-position.
* $y$ is the base row position.
* $A$ is amplitude.
* $h(x,y)$ is normalized elevation.
* $N(x,y)$ is noise.
* $W$ is noise warp strength.

Building influence version:

$$
y'(x) = y - A \cdot h(x,y) + B(x,y) \cdot I_b + N(x,y) \cdot W
$$

Where:

* $B(x,y)$ is building mask intensity.
* $I_b$ is building influence.

That lets buildings lift, interrupt, flatten, or amplify waveforms.

## 10. Interaction Design

Main screen layout:

```txt
┌────────────────────────────────────────────┐
│ Strata Studio                              │
├───────────────┬────────────────────────────┤
│ Controls      │ Artwork Preview            │
│               │                            │
│ Location      │                            │
│ Studio        │                            │
│ Style         │                            │
│ Sliders       │                            │
│ Export        │                            │
└───────────────┴────────────────────────────┘
```

User path:

1. Open app.
2. See two large cards:

   * **Classic Studio**
   * **Experimental Lab**
3. Choose Experimental Lab.
4. Choose **Waveform Terrain**.
5. Select location from map.
6. Click **Generate**.
7. Adjust sliders.
8. Export.

The app should always show something quickly. If terrain data is still loading, generate a placeholder noise waveform first, then replace it with real terrain.

## 11. Preset Names

Strong preset names matter because this is a creative tool.

Classic Studio presets:

* Contour
* Ridge
* Flow
* Blueprint
* Woodcut
* Drift
* Signal
* Atlas
* Quarry
* Survey

Experimental Lab presets:

* Waveform Terrain
* Seismic
* Noise Amplifier
* Gravity Well
* Magnetic Field
* Pulse Rings
* Terrain Sonogram
* Building Interference
* Melt Map
* Static Bloom

Best default preset:

**Waveform Terrain: Monolith**

Visual: black background, white lines, tight spacing, medium amplitude, high occlusion, subtle grain.

Other waveform preset names:

* Monolith
* Signal Peak
* Fault Line
* White Noise
* Mountain Broadcast
* Seismic Choir
* Black Ridge
* Interference Map
* Topo Signal
* Ghost Terrain

## 12. Export System

MVP exports:

| Export        | Priority                    |
| ------------- | --------------------------- |
| PNG           | Must-have                   |
| SVG           | Must-have if using line art |
| JSON preset   | Nice-to-have                |
| Copy seed URL | Nice-to-have                |

Export sizes:

* 1024 × 1024
* 2048 × 2048
* 3000 × 3000
* 16:9 wallpaper
* 9:16 phone wallpaper
* 12 × 18 poster ratio

The URL should store shareable parameters:

```txt
/studio/experimental/waveform?lat=...&lng=...&z=...&seed=...&style=monolith
```

No account system needed.

## 13. MVP Scope

Build only this:

### Must-have

* Static Cloudflare Pages deployment.
* React/TypeScript app.
* Map selection.
* Terrain fetch.
* Waveform terrain renderer.
* Basic controls:

  * amplitude
  * spacing
  * line thickness
  * noise
  * vertical compression
  * seed
* PNG export.
* A few presets.

### Should-have

* SVG export.
* Building mask influence.
* Road overlay influence.
* Local cache.
* Responsive layout.

### Skip for MVP

* Login.
* User galleries.
* Payments.
* AI generation.
* Social feed.
* Full global tile infrastructure.
* Advanced autocomplete search.
* Backend database.
* Dozens of styles.

## 14. Development Phases

### Phase 1: Fake Data Prototype

Goal: make it look good before worrying about real maps.

Build:

* Canvas waveform renderer.
* Random seeded terrain grid.
* Sliders.
* Export PNG.

Success criteria:

* The output already looks like album art.
* Sliders feel responsive.
* Seeded outputs are repeatable.

### Phase 2: Real Terrain

Goal: connect waveform style to real places.

Build:

* Map area picker.
* Terrain tile fetcher.
* Elevation decoder.
* Terrain grid sampler.
* Real waveform rendering.

Success criteria:

* Mountains look dramatically different from flat cities.
* Same location produces stable output.
* Yosemite, Denver, Dallas, Manhattan, and Grand Canyon each look distinct.

### Phase 3: Feature Influence

Goal: make buildings/roads/water visibly affect the art.

Build:

* Small Overpass queries for selected bounds.
* Convert buildings/roads/water into masks.
* Add mask modes:

  * interrupt
  * amplify
  * flatten
  * glow
  * outline

Success criteria:

* Urban areas have recognizable structure.
* Buildings can visibly cut through waveform lines.
* Rivers/lakes create attractive negative space.

### Phase 4: Classic Studio

Goal: broaden the product.

Build:

* Contour renderer.
* Ridge renderer.
* Blueprint renderer.
* Palette system.
* SVG export.

Success criteria:

* Classic Studio produces clean poster designs.
* Experimental Lab still feels like the unique hook.

## 15. Risks

| Risk                      | Problem                                        | Fix                                                              |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| Public API limits         | OSM/Nominatim/Overpass cannot be abused.       | Use manual map selection, small bbox, caching, and clear limits. |
| Terrain tile availability | Free terrain sources may change or rate-limit. | Abstract terrain provider behind an adapter.                     |
| Output looks generic      | Could feel like another map poster app.        | Lead with waveform terrain and building interference.            |
| Canvas gets slow          | High-res export may lag.                       | Render preview low-res, export high-res offscreen.               |
| Too many styles           | Scope creep.                                   | Build one killer style first.                                    |
| Data attribution          | OSM and terrain data require attribution.      | Add credits panel and export metadata.                           |

## 16. What Makes It Good

The product needs one obvious wow moment:

A user picks a real place, clicks generate, and instantly sees that place transformed into a black-and-white waveform object.

The art should be abstract but still geographically grounded. The user should feel: “This is my city/mountain/neighborhood, but turned into a record cover.”

The strongest differentiator is the collision of:

* real terrain,
* urban geometry,
* sound-wave aesthetics,
* exportable poster quality,
* no backend,
* no AI inside the product.

## 17. Suggested Final Product Positioning

Tagline options:

* **Turn any place into generative map art.**
* **Geography, rendered like sound.**
* **Album-cover maps from real terrain.**
* **A visual synth for places.**
* **Topographic art for any location.**

Best simple positioning:

**Strata Studio is a browser-based map-art generator that turns real terrain and city geometry into high-contrast generative posters.**

## 18. Build Recommendation

Start with **Experimental Lab → Waveform Terrain → Monolith preset**.

That is the product’s identity. Classic contour maps can come later. The first version should make one thing look unusually good.

Minimum first prompt to give the coding model:


Confidence: 92/100

[1]: https://pages.cloudflare.com/
[2]: https://www.maplibre.org/maplibre-gl-js/docs/
[3]: https://registry.opendata.aws/terrain-tiles/
[4]: https://dev.overpass-api.de/overpass-doc/en/preface/commons.html
[5]: https://operations.osmfoundation.org/policies/nominatim/
