/**
 * Poster title block: letterspaced-caps title + rule + coordinates line,
 * rendered INTO the artwork with canvas/SVG parity. Verified DOM-lessly with
 * a recording context stub (the exportParity.test.ts pattern): logical
 * geometry is identical at scale 1 vs 3 (the raster transform does the
 * scaling), plain mode is unchanged, and the SVG output carries the same
 * layout via letter-spacing attributes.
 */

import { describe, it, expect } from "bun:test";
import {
  fitLabelText,
  posterLayout,
  posterMetaLine,
  renderSceneCanvas,
  sceneToSvg,
  type Scene,
} from "./scene.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import type { ArtworkMeta, FeatureMasks, Palette, StyleParams } from "./types.ts";

const PALETTE: Palette = {
  background: "#111111",
  foreground: "#eeeeee",
  accent: "#ff6600",
};

const W = 512;
const H = 512;

const SCENE: Scene = {
  strokes: [{ points: [{ x: 10, y: 400 }, { x: 500, y: 380 }], role: "foreground" }],
};

/** San Francisco-ish bounds/elevation, matching the design-doc example line. */
const META: ArtworkMeta = {
  bounds: { north: 37.8, south: 37.74, east: -122.39, west: -122.45 },
  elevation: { min: -110.4, max: 281.6 },
};

/** Zero-coverage masks carrying meta, like buildArtworkInput fabricates. */
function metaMasks(meta?: ArtworkMeta): FeatureMasks {
  const zero = new Float32Array(1);
  return {
    width: 1,
    height: 1,
    building: zero,
    road: zero,
    water: zero,
    ocean: zero,
    lake: zero,
    river: zero,
    meta,
  };
}

function posterParams(label = "San Francisco"): StyleParams {
  return { ...defaultStyleParams, label, labelStyle: "poster" };
}

type TextCall = {
  text: string;
  x: number;
  y: number;
  font: string;
  textAlign: string;
  alpha: number;
  letterSpacing: string | null;
};
type RectCall = { x: number; y: number; w: number; h: number; alpha: number };

/**
 * Recording context stub. `native` controls whether the stub exposes a
 * letterSpacing property (the preferred canvas API) — when false, the
 * renderer must fall back to manual per-character advances via measureText.
 */
class StubCtx {
  canvas: { width: number; height: number };
  fillTexts: TextCall[] = [];
  fillRects: RectCall[] = [];
  scales: [number, number][] = [];
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
  shadowBlur = 0;

  constructor(width: number, height: number, native: boolean) {
    this.canvas = { width, height };
    if (native) {
      (this as unknown as { letterSpacing: string }).letterSpacing = "0px";
    }
  }

  save() {}
  restore() {}
  setTransform() {}
  scale(x: number, y: number) {
    this.scales.push([x, y]);
  }
  translate() {}
  rotate() {}
  clearRect() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  stroke() {}
  fill() {}
  drawImage() {}
  measureText(text: string) {
    // Deterministic fake metrics: 10 logical px per character.
    return { width: text.length * 10 };
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.fillRects.push({ x, y, w, h, alpha: this.globalAlpha });
  }
  fillText(text: string, x: number, y: number) {
    const spacing = (this as unknown as { letterSpacing?: string }).letterSpacing ?? null;
    this.fillTexts.push({
      text,
      x,
      y,
      font: this.font,
      textAlign: this.textAlign,
      alpha: this.globalAlpha,
      letterSpacing: spacing,
    });
  }

  asCtx(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }
}

function render(
  ctx: StubCtx,
  params: StyleParams,
  masks?: FeatureMasks,
): StubCtx {
  renderSceneCanvas(ctx.asCtx(), SCENE, params, PALETTE, W, H, false, masks);
  return ctx;
}

describe("poster title block (canvas)", () => {
  it("emits title, rule, and coordinates line at the shared layout positions", () => {
    const ctx = render(new StubCtx(W, H, true), posterParams(), metaMasks(META));
    const L = posterLayout(W, H);

    expect(ctx.fillTexts.length).toBe(2);
    const [title, sub] = ctx.fillTexts;

    // Line 1: uppercase, letterspaced, centered (with trailing-track offset).
    expect(title.text).toBe("SAN FRANCISCO");
    expect(title.x).toBeCloseTo(L.cx + L.titleTracking / 2, 6);
    expect(title.y).toBeCloseTo(L.titleBaseline, 6);
    expect(title.textAlign).toBe("center");
    expect(title.font).toBe(`600 ${L.titleSize}px sans-serif`);
    expect(title.letterSpacing).toBe(`${L.titleTracking}px`);
    expect(title.alpha).toBeCloseTo(0.92, 6);

    // Line 2: the thin centered rule (the only poster fillRect besides bg).
    const rule = ctx.fillRects.find((r) => r.w === L.ruleHalf * 2);
    expect(rule).toBeDefined();
    expect(rule!.x).toBeCloseTo(L.cx - L.ruleHalf, 6);
    expect(rule!.y).toBeCloseTo(L.ruleY - L.ruleThickness / 2, 6);
    expect(rule!.h).toBeCloseTo(L.ruleThickness, 6);
    expect(rule!.alpha).toBeCloseTo(0.5, 6);

    // Line 3: coordinates + elevation range from the ArtworkMeta.
    expect(sub.text).toBe("37.77°N 122.42°W · ELEV −110–282 M");
    expect(sub.y).toBeCloseTo(L.subBaseline, 6);
    expect(sub.font).toBe(`${L.subSize}px sans-serif`);
    expect(sub.letterSpacing).toBe(`${L.subTracking}px`);
    expect(sub.alpha).toBeCloseTo(0.62, 6);
  });

  it("scales linearly: identical logical geometry at export scale 3", () => {
    const preview = render(new StubCtx(W, H, true), posterParams(), metaMasks(META));
    const export3x = render(new StubCtx(W * 3, H * 3, true), posterParams(), metaMasks(META));

    // Only the raster transform differs; all logical coordinates match.
    expect(preview.scales[0]).toEqual([1, 1]);
    expect(export3x.scales[0]).toEqual([3, 3]);
    expect(export3x.fillTexts).toEqual(preview.fillTexts);
    expect(export3x.fillRects).toEqual(preview.fillRects);
  });

  it("letterspaces manually (per-character advances) where ctx.letterSpacing is unsupported", () => {
    const ctx = render(new StubCtx(W, H, false), posterParams("Rio"), metaMasks(META));
    const L = posterLayout(W, H);

    const titleChars = ctx.fillTexts.slice(0, 3);
    expect(titleChars.map((c) => c.text)).toEqual(["R", "I", "O"]);
    // Stub metrics: 10px per char → total = 30 + 2 tracks; centered on cx.
    const total = 30 + L.titleTracking * 2;
    expect(titleChars[0].x).toBeCloseTo(L.cx - total / 2, 6);
    expect(titleChars[1].x).toBeCloseTo(titleChars[0].x + 10 + L.titleTracking, 6);
    expect(titleChars[2].x).toBeCloseTo(titleChars[1].x + 10 + L.titleTracking, 6);
    for (const c of titleChars) {
      expect(c.textAlign).toBe("left");
      expect(c.y).toBeCloseTo(L.titleBaseline, 6);
    }
    // The meta line is also drawn per-character in fallback mode.
    const metaLine = posterMetaLine(META);
    expect(ctx.fillTexts.length).toBe(3 + [...metaLine].length);
  });

  it("omits the coordinates line when no ArtworkMeta is available", () => {
    const ctx = render(new StubCtx(W, H, true), posterParams(), metaMasks(undefined));
    expect(ctx.fillTexts.map((t) => t.text)).toEqual(["SAN FRANCISCO"]);
    const L = posterLayout(W, H);
    expect(ctx.fillRects.some((r) => r.w === L.ruleHalf * 2)).toBe(true);
  });

  it("renders nothing for an empty label", () => {
    const ctx = render(new StubCtx(W, H, true), posterParams(""), metaMasks(META));
    expect(ctx.fillTexts.length).toBe(0);
  });

  it("leaves plain mode unchanged (single dim caption at the bottom-left)", () => {
    const params: StyleParams = { ...defaultStyleParams, label: "San Francisco" };
    const ctx = render(new StubCtx(W, H, true), params, metaMasks(META));
    expect(ctx.fillTexts.length).toBe(1);
    const caption = ctx.fillTexts[0];
    expect(caption.text).toBe("San Francisco"); // not uppercased
    expect(caption.x).toBe(16);
    expect(caption.y).toBe(H - 16);
    expect(caption.textAlign).toBe("left");
    expect(caption.font).toBe(`${Math.max(12, Math.round(W / 36))}px sans-serif`);
    expect(caption.alpha).toBeCloseTo(0.6, 6);
  });
});

describe("poster meta line formatting", () => {
  it("formats hemisphere letters and the elevation range with proper minus/dash", () => {
    expect(posterMetaLine(META)).toBe("37.77°N 122.42°W · ELEV −110–282 M");
    expect(
      posterMetaLine({
        bounds: { north: -33.8, south: -33.9, east: 151.25, west: 151.15 },
        elevation: { min: 0, max: 87.2 },
      }),
    ).toBe("33.85°S 151.20°E · ELEV 0–87 M");
  });
});

describe("poster title block (SVG parity)", () => {
  const svgOf = (params: StyleParams, masks?: FeatureMasks, exportSize?: { width: number; height: number }) =>
    sceneToSvg(SCENE, params, PALETTE, W, H, false, masks, exportSize);

  it("emits letter-spaced centered text nodes matching the canvas layout", () => {
    const svg = svgOf(posterParams(), metaMasks(META));
    const L = posterLayout(W, H);
    const n = (v: number) => +v.toFixed(2);

    expect(svg).toContain(">SAN FRANCISCO</text>");
    expect(svg).toContain(`letter-spacing="${n(L.titleTracking)}"`);
    expect(svg).toContain(`font-size="${n(L.titleSize)}"`);
    expect(svg).toContain('font-weight="600"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain(`x="${n(L.cx + L.titleTracking / 2)}" y="${n(L.titleBaseline)}"`);

    // The rule.
    expect(svg).toContain(
      `<rect x="${n(L.cx - L.ruleHalf)}" y="${n(L.ruleY - L.ruleThickness / 2)}" width="${n(L.ruleHalf * 2)}" height="${n(L.ruleThickness)}"`,
    );

    // The coordinates line.
    expect(svg).toContain(">37.77°N 122.42°W · ELEV −110–282 M</text>");
    expect(svg).toContain(`letter-spacing="${n(L.subTracking)}"`);
    expect(svg).toContain(`fill="${PALETTE.foreground}"`);
  });

  it("uses the same fitted title size in Canvas and SVG for long validated labels", () => {
    const longLabel = "A VERY LONG MOUNTAIN LANDSCAPE TITLE ".repeat(6).trim();
    const fitted = fitLabelText(longLabel.toUpperCase(), posterLayout(W, H).titleSize, 0.28, W * 0.88);
    expect(fitted.estimatedWidth).toBeLessThanOrEqual(W * 0.88 + 0.0001);

    const canvas = render(new StubCtx(W, H, true), posterParams(longLabel), metaMasks(META));
    expect(canvas.fillTexts[0].font).toBe(`600 ${fitted.fontSize}px sans-serif`);
    expect(canvas.fillTexts[0].letterSpacing).toBe(`${fitted.tracking}px`);

    const svg = svgOf(posterParams(longLabel), metaMasks(META));
    expect(svg).toContain(`font-size="${+fitted.fontSize.toFixed(2)}"`);
    expect(svg).toContain(`letter-spacing="${+fitted.tracking.toFixed(2)}"`);
  });

  it("keeps the layout in logical viewBox units at export size (scales with the artwork)", () => {
    const logical = svgOf(posterParams(), metaMasks(META));
    const scaled = svgOf(posterParams(), metaMasks(META), { width: 3000, height: 3000 });
    expect(scaled).toContain('width="3000" height="3000" viewBox="0 0 512 512"');
    // The poster block's text nodes are identical — geometry is logical.
    const textNodes = (svg: string) => svg.match(/<text[^>]*>[^<]*<\/text>/g) ?? [];
    expect(textNodes(scaled)).toEqual(textNodes(logical));
    expect(textNodes(scaled).length).toBe(2);
  });

  it("omits the coordinates line without meta and stays plain in plain mode", () => {
    const noMeta = svgOf(posterParams(), metaMasks(undefined));
    expect(noMeta).toContain(">SAN FRANCISCO</text>");
    expect(noMeta).not.toContain("ELEV");

    const plain = svgOf({ ...defaultStyleParams, label: "San Francisco" }, metaMasks(META));
    expect(plain).toContain(`<text x="16" y="${H - 16}"`);
    expect(plain).toContain(">San Francisco</text>");
    expect(plain).not.toContain("letter-spacing");
    expect(plain).not.toContain("SAN FRANCISCO");
  });
});
