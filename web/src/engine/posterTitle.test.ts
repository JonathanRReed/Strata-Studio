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
  composePosterTitle,
  posterLayout,
  posterMetaLine,
  posterTitleTrackingRatio,
  POSTER_META_FAMILY,
  POSTER_TITLE_FAMILY,
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
  createLinearGradient() {
    return { addColorStop() {} };
  }
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
  it("emits title, rule, and coordinates line at the composed layout positions", () => {
    const ctx = render(new StubCtx(W, H, true), posterParams(), metaMasks(META));
    const C = composePosterTitle("San Francisco", W, H, META);

    // One fillText per title line + one per meta character is not asserted
    // here (the native-letterSpacing path emits one fillText per line). The
    // native path is what the stub exercises when native=true.
    expect(C.titleLines.length).toBe(1);
    expect(ctx.fillTexts.length).toBe(2); // title line + meta line
    const [title, sub] = ctx.fillTexts;

    // Line 1: uppercase, letterspaced, centered (with trailing-track offset).
    expect(title.text).toBe("SAN FRANCISCO");
    expect(title.x).toBeCloseTo(C.cx + C.titleLines[0].tracking / 2, 6);
    expect(title.y).toBeCloseTo(C.titleLines[0].baseline, 6);
    expect(title.textAlign).toBe("center");
    expect(title.font).toBe(`600 ${C.titleLines[0].fontSize}px ${POSTER_TITLE_FAMILY}`);
    expect(title.letterSpacing).toBe(`${C.titleLines[0].tracking}px`);
    expect(title.alpha).toBeCloseTo(0.92, 6);

    // Line 2: the thin centered rule (the only poster fillRect besides bg
    // and the scrim gradient rect, which is wider than the rule).
    const rule = ctx.fillRects.find((r) => r.w === C.rule.width);
    expect(rule).toBeDefined();
    expect(rule!.x).toBeCloseTo(C.rule.x, 6);
    expect(rule!.y).toBeCloseTo(C.rule.y, 6);
    expect(rule!.h).toBeCloseTo(C.rule.height, 6);
    expect(rule!.alpha).toBeCloseTo(0.5, 6);

    // Line 3: coordinates + elevation range from the ArtworkMeta.
    expect(sub.text).toBe("37.77°N 122.42°W · ELEV −110–282 M");
    expect(sub.y).toBeCloseTo(C.meta!.baseline, 6);
    expect(sub.font).toBe(`${C.meta!.fontSize}px ${POSTER_META_FAMILY}`);
    expect(sub.letterSpacing).toBe(`${C.meta!.tracking}px`);
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
    const C = composePosterTitle("Rio", W, H, META);

    const titleChars = ctx.fillTexts.slice(0, 3);
    expect(titleChars.map((c) => c.text)).toEqual(["R", "I", "O"]);
    // Stub metrics: 10px per char → total = 30 + 2 tracks; centered on cx.
    const total = 30 + C.titleLines[0].tracking * 2;
    expect(titleChars[0].x).toBeCloseTo(C.cx - total / 2, 6);
    expect(titleChars[1].x).toBeCloseTo(titleChars[0].x + 10 + C.titleLines[0].tracking, 6);
    expect(titleChars[2].x).toBeCloseTo(titleChars[1].x + 10 + C.titleLines[0].tracking, 6);
    for (const c of titleChars) {
      expect(c.textAlign).toBe("left");
      expect(c.y).toBeCloseTo(C.titleLines[0].baseline, 6);
    }
    // The meta line is also drawn per-character in fallback mode.
    const metaLine = posterMetaLine(META);
    expect(ctx.fillTexts.length).toBe(3 + [...metaLine].length);
  });

  it("omits the coordinates line when no ArtworkMeta is available", () => {
    const ctx = render(new StubCtx(W, H, true), posterParams(), metaMasks(undefined));
    expect(ctx.fillTexts.map((t) => t.text)).toEqual(["SAN FRANCISCO"]);
    const C = composePosterTitle("San Francisco", W, H, undefined);
    expect(ctx.fillRects.some((r) => r.w === C.rule.width)).toBe(true);
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

  it("optically sizes short names larger than the nominal titleSize", () => {
    // A three-letter name should be scaled up toward the optical measure,
    // not left at the nominal size — that is the whole point of optical sizing.
    const C = composePosterTitle("Rio", W, H, META);
    const L = posterLayout(W, H);
    expect(C.titleLines[0].fontSize).toBeGreaterThan(L.titleSize);
  });

  it("wraps a long multi-word title across two lines on a word boundary", () => {
    const longLabel = "A Very Long Mountain Landscape Title";
    const C = composePosterTitle(longLabel, W, H, META);
    expect(C.titleLines.length).toBe(2);
    // Both lines share one font size so they read as one lockup.
    expect(C.titleLines[0].fontSize).toBe(C.titleLines[1].fontSize);
    // The wrap is on a word boundary (no broken words).
    const rejoined = C.titleLines.map((l) => l.text).join(" ");
    expect(rejoined).toBe(longLabel.toUpperCase());
  });

  it("tapers tracking as the title lengthens", () => {
    expect(posterTitleTrackingRatio(3)).toBeGreaterThan(posterTitleTrackingRatio(20));
    expect(posterTitleTrackingRatio(30)).toBeLessThan(posterTitleTrackingRatio(8));
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

  it("emits letter-spaced centered text nodes matching the composed layout", () => {
    const svg = svgOf(posterParams(), metaMasks(META));
    const C = composePosterTitle("San Francisco", W, H, META);
    const n = (v: number) => +v.toFixed(2);

    expect(svg).toContain(">SAN FRANCISCO</text>");
    expect(svg).toContain(`letter-spacing="${n(C.titleLines[0].tracking)}"`);
    expect(svg).toContain(`font-size="${n(C.titleLines[0].fontSize)}"`);
    expect(svg).toContain('font-weight="600"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain(`x="${n(C.cx + C.titleLines[0].tracking / 2)}" y="${n(C.titleLines[0].baseline)}"`);
    expect(svg).toContain(`font-family='${POSTER_TITLE_FAMILY}'`);

    // The rule.
    expect(svg).toContain(
      `<rect x="${n(C.rule.x)}" y="${n(C.rule.y)}" width="${n(C.rule.width)}" height="${n(C.rule.height)}"`,
    );

    // The coordinates line, set in the mono readout face.
    expect(svg).toContain(">37.77°N 122.42°W · ELEV −110–282 M</text>");
    expect(svg).toContain(`letter-spacing="${n(C.meta!.tracking)}"`);
    expect(svg).toContain(`font-family='${POSTER_META_FAMILY}'`);
    expect(svg).toContain(`fill="${PALETTE.foreground}"`);

    // The legibility scrim.
    expect(svg).toContain("strata-poster-scrim");
    expect(svg).toContain("linearGradient");
  });

  it("uses the same fitted title size in Canvas and SVG for long validated labels", () => {
    const longLabel = "A VERY LONG MOUNTAIN LANDSCAPE TITLE ".repeat(6).trim();
    const C = composePosterTitle(longLabel, W, H, META);

    const canvas = render(new StubCtx(W, H, true), posterParams(longLabel), metaMasks(META));
    // A wrapped title emits one fillText per line.
    const canvasTitleFonts = canvas.fillTexts.filter((t) => t.text === C.titleLines[0].text || t.text === C.titleLines[1]?.text);
    expect(canvasTitleFonts.length).toBe(C.titleLines.length);
    for (const tf of canvasTitleFonts) {
      expect(tf.font).toBe(`600 ${C.titleLines[0].fontSize}px ${POSTER_TITLE_FAMILY}`);
    }

    const svg = svgOf(posterParams(longLabel), metaMasks(META));
    expect(svg).toContain(`font-size="${+C.titleLines[0].fontSize.toFixed(2)}"`);
    expect(svg).toContain(`letter-spacing="${+C.titleLines[0].tracking.toFixed(2)}"`);
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
