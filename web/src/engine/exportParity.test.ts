/**
 * WYSIWYG export tests: scenes are generated once in logical (preview)
 * coordinates and rendered onto canvases/SVGs of any pixel size via a scale
 * factor — so exports reproduce the preview composition exactly.
 * Also covers animation-export correctness (hoisted static-scene generation,
 * transparent-mode compositing, gifenc transparent palette index).
 */

import { describe, it, expect } from "bun:test";
// @ts-expect-error: gifenc has no bundled types
import { quantize, applyPalette } from "gifenc";
import { renderSceneCanvas, sceneToSvg, type Scene } from "./scene.ts";
import { createFrameRenderer, findTransparentIndex } from "./animationExport.ts";
import { renderStyleSvg } from "../studios/registry.ts";
import { waveformTerrain } from "../studios/experimental/waveformTerrain.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import type { ArtStyle, ArtworkInput, Palette, StyleParams } from "./types.ts";

const PALETTE: Palette = {
  background: "#111111",
  foreground: "#eeeeee",
  accent: "#ff6600",
};

const PARAMS: StyleParams = { ...defaultStyleParams, seed: "parity" };

type RecordedCall = { method: string; args: unknown[]; gco: string };

/**
 * Minimal recording stand-in for CanvasRenderingContext2D. Bun tests run
 * without a DOM, so renderSceneCanvas is exercised against this stub (grain
 * and water underlay stay off — they require document.createElement).
 */
class StubCtx {
  canvas: { width: number; height: number };
  calls: RecordedCall[] = [];
  shadowBlurs: number[] = [];
  globalCompositeOperation = "source-over";
  globalAlpha = 1;
  lineWidth = 0;
  lineJoin = "";
  lineCap = "";
  fillStyle: unknown = "";
  strokeStyle: unknown = "";
  font = "";
  textAlign = "";
  shadowColor = "";
  private blur = 0;

  constructor(width: number, height: number) {
    this.canvas = { width, height };
  }

  get shadowBlur(): number {
    return this.blur;
  }
  set shadowBlur(v: number) {
    this.blur = v;
    this.shadowBlurs.push(v);
  }

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args, gco: this.globalCompositeOperation });
  }
  save() { this.record("save"); }
  restore() { this.record("restore"); }
  setTransform(...args: unknown[]) { this.record("setTransform", ...args); }
  scale(x: number, y: number) { this.record("scale", x, y); }
  translate(x: number, y: number) { this.record("translate", x, y); }
  rotate(r: number) { this.record("rotate", r); }
  fillRect(...args: unknown[]) { this.record("fillRect", ...args); }
  clearRect(...args: unknown[]) { this.record("clearRect", ...args); }
  beginPath() { this.record("beginPath"); }
  closePath() { this.record("closePath"); }
  moveTo(x: number, y: number) { this.record("moveTo", x, y); }
  lineTo(x: number, y: number) { this.record("lineTo", x, y); }
  stroke() { this.record("stroke"); }
  fill() { this.record("fill"); }
  fillText(...args: unknown[]) { this.record("fillText", ...args); }
  drawImage(...args: unknown[]) { this.record("drawImage", ...args); }

  asCtx(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

const SCENE: Scene = {
  strokes: [
    {
      points: [{ x: 5, y: 90 }, { x: 50, y: 60 }, { x: 95, y: 80 }],
      role: "foreground",
      glow: true,
    },
    {
      points: [{ x: 5, y: 90 }, { x: 50, y: 60 }, { x: 95, y: 80 }, { x: 95, y: 100 }, { x: 5, y: 100 }],
      role: "background",
      fill: true,
      closed: true,
    },
  ],
};

describe("scene-scale invariance (canvas)", () => {
  it("emits identical logical stroke coordinates regardless of canvas pixel size", () => {
    const preview = new StubCtx(100, 100);
    const export3x = new StubCtx(300, 300);
    renderSceneCanvas(preview.asCtx(), SCENE, PARAMS, PALETTE, 100, 100);
    renderSceneCanvas(export3x.asCtx(), SCENE, PARAMS, PALETTE, 100, 100);

    for (const method of ["moveTo", "lineTo", "fillRect"]) {
      const a = preview.callsOf(method).map((c) => c.args);
      const b = export3x.callsOf(method).map((c) => c.args);
      expect(b).toEqual(a);
      expect(a.length).toBeGreaterThan(0);
    }
    // Only the raster transform differs.
    expect(preview.callsOf("scale")[0].args).toEqual([1, 1]);
    expect(export3x.callsOf("scale")[0].args).toEqual([3, 3]);
  });

  it("scales glow shadowBlur by the render scale (shadowBlur ignores the transform)", () => {
    const preview = new StubCtx(100, 100);
    const export3x = new StubCtx(300, 300);
    renderSceneCanvas(preview.asCtx(), SCENE, PARAMS, PALETTE, 100, 100);
    renderSceneCanvas(export3x.asCtx(), SCENE, PARAMS, PALETTE, 100, 100);
    expect(Math.max(...preview.shadowBlurs)).toBe(8);
    expect(Math.max(...export3x.shadowBlurs)).toBe(24);
  });

  it("lineWidth stays logical (the canvas transform scales it)", () => {
    const preview = new StubCtx(100, 100);
    const export3x = new StubCtx(300, 300);
    renderSceneCanvas(preview.asCtx(), SCENE, PARAMS, PALETTE, 100, 100);
    renderSceneCanvas(export3x.asCtx(), SCENE, PARAMS, PALETTE, 100, 100);
    expect(preview.lineWidth).toBe(PARAMS.lineWidth);
    expect(export3x.lineWidth).toBe(PARAMS.lineWidth);
  });
});

describe("transparent-mode compositing", () => {
  it("erases background-role occlusion shapes with destination-out", () => {
    const ctx = new StubCtx(100, 100);
    renderSceneCanvas(ctx.asCtx(), SCENE, PARAMS, PALETTE, 100, 100, true);
    // The background-role fill is the only fill in the scene.
    const fills = ctx.callsOf("fill");
    expect(fills.length).toBe(1);
    expect(fills[0].gco).toBe("destination-out");
    // The foreground stroke still paints normally...
    const strokes = ctx.callsOf("stroke");
    expect(strokes.length).toBe(1);
    expect(strokes[0].gco).toBe("source-over");
    // ...and the op is restored afterwards.
    expect(ctx.globalCompositeOperation).toBe("source-over");
    // Transparent mode clears rather than filling the background.
    expect(ctx.callsOf("clearRect").length).toBe(1);
    expect(ctx.callsOf("fillRect").length).toBe(0);
  });

  it("keeps opaque renders on source-over throughout", () => {
    const ctx = new StubCtx(100, 100);
    renderSceneCanvas(ctx.asCtx(), SCENE, PARAMS, PALETTE, 100, 100, false);
    for (const call of ctx.calls) {
      expect(call.gco).toBe("source-over");
    }
    expect(ctx.callsOf("fillRect").length).toBe(1);
  });

  it("omits background-role shapes from transparent SVG (documented parity limit)", () => {
    const opaque = sceneToSvg(SCENE, PARAMS, PALETTE, 100, 100, false);
    const transparent = sceneToSvg(SCENE, PARAMS, PALETTE, 100, 100, true);
    // Opaque output paints the occlusion shape in the background color.
    expect(opaque).toContain(`fill="${PALETTE.background}"`);
    // Transparent output has no occlusion shape (and no background rect).
    expect(transparent).not.toContain(`fill="${PALETTE.background}"`);
    expect(transparent).not.toContain("<rect");
    expect(transparent).toContain("<path");
  });
});

describe("scene-scale invariance (SVG)", () => {
  const input: ArtworkInput = {
    bounds: { west: 0, east: 1, north: 1, south: 0 },
    elevationGrid: {
      width: 8,
      height: 8,
      bounds: { west: 0, east: 1, north: 1, south: 0 },
      data: new Float32Array(64).map((_, i) => Math.sin(i * 0.4) * 0.5 + 0.5),
    },
    width: 100,
    height: 100,
    seed: "svg-scale",
  };
  const params = { ...defaultStyleParams, ...waveformTerrain.defaultParams };

  const pathData = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

  it("emits export pixel size with a logical viewBox and identical geometry", () => {
    const logical = renderStyleSvg(waveformTerrain.id, input, params);
    const scaled = renderStyleSvg(waveformTerrain.id, input, params, undefined, false, {
      width: 250,
      height: 250,
    });

    expect(logical).toContain('width="100" height="100" viewBox="0 0 100 100"');
    expect(scaled).toContain('width="250" height="250" viewBox="0 0 100 100"');
    expect(scaled).toContain('preserveAspectRatio="none"');

    const a = pathData(logical);
    const b = pathData(scaled);
    expect(a.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
    // Stroke widths stay in logical units; the root scaling sharpens them.
    expect(scaled).toContain(`stroke-width="${params.lineWidth}"`);
  });
});

describe("animation frame renderer", () => {
  const input: ArtworkInput = {
    bounds: { west: 0, east: 1, north: 1, south: 0 },
    elevationGrid: {
      width: 4,
      height: 4,
      bounds: { west: 0, east: 1, north: 1, south: 0 },
      data: new Float32Array(16).map((_, i) => (i % 4) / 3),
    },
    width: 100,
    height: 100,
    seed: "frames",
  };

  function countingStyle(): { style: ArtStyle; count: () => number } {
    let calls = 0;
    const style: ArtStyle = {
      id: "counting",
      name: "Counting",
      studio: "experimental",
      description: "test stub",
      defaultParams: {},
      generate: () => {
        calls++;
        return {
          strokes: [{ points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] }],
        };
      },
    };
    return { style, count: () => calls };
  }

  const paletteMap = { monochrome: PALETTE };

  it("generates the static scene exactly once for draw/parallax exports", () => {
    for (const animationMode of ["draw", "parallax"] as const) {
      const { style, count } = countingStyle();
      const render = createFrameRenderer({
        style,
        input,
        params: { ...PARAMS, animationMode },
        paletteMap,
        totalFrames: 8,
        transparent: false,
      });
      for (let f = 0; f < 8; f++) {
        render(new StubCtx(100, 100).asCtx(), f);
      }
      expect(count()).toBe(1);
    }
  });

  it("regenerates per frame for drift (phase changes the geometry)", () => {
    const { style, count } = countingStyle();
    const render = createFrameRenderer({
      style,
      input,
      params: { ...PARAMS, animationMode: "drift" },
      paletteMap,
      totalFrames: 8,
      transparent: false,
    });
    for (let f = 0; f < 8; f++) {
      render(new StubCtx(100, 100).asCtx(), f);
    }
    expect(count()).toBe(8);
  });
});

describe("gifenc transparency", () => {
  it("locates the quantized transparent palette index instead of assuming 0", () => {
    // 4x4 RGBA image: opaque colors first so the transparent entry is
    // unlikely to be palette index 0, then fully transparent pixels.
    const pixels: number[] = [];
    const opaque: [number, number, number][] = [
      [255, 255, 255], [200, 40, 40], [40, 200, 40], [40, 40, 200],
      [255, 255, 0], [0, 255, 255], [255, 0, 255], [120, 120, 120],
    ];
    for (const [r, g, b] of opaque) pixels.push(r, g, b, 255);
    for (let i = 0; i < 8; i++) pixels.push(0, 0, 0, 0);
    const data = new Uint8Array(pixels);

    const palette = quantize(data, 256, {
      format: "rgba4444",
      oneBitAlpha: true,
      clearAlpha: true,
      clearAlphaThreshold: 128,
    }) as number[][];

    const transparentIndex = findTransparentIndex(palette);
    expect(transparentIndex).toBeGreaterThanOrEqual(0);
    expect(palette[transparentIndex][3]).toBe(0);

    // Every transparent source pixel maps to that index, opaque ones don't.
    const indexed = applyPalette(data, palette, "rgba4444") as Uint8Array;
    for (let i = 8; i < 16; i++) {
      expect(indexed[i]).toBe(transparentIndex);
    }
    for (let i = 0; i < 8; i++) {
      expect(indexed[i]).not.toBe(transparentIndex);
    }
  });

  it("returns -1 when no transparent color exists (opaque GIFs skip transparency)", () => {
    expect(findTransparentIndex([[10, 20, 30], [40, 50, 60]])).toBe(-1);
    expect(findTransparentIndex([[10, 20, 30, 255]])).toBe(-1);
  });
});
