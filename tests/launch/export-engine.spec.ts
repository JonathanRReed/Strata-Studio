import { expect, test } from "@playwright/test";
import { sceneToSvg, type Stroke } from "../../web/src/engine/scene.ts";
import { defaultStyleParams } from "../../web/src/presets/stylePresets.ts";
import { palettes } from "../../web/src/presets/palettes.ts";
const params = { ...defaultStyleParams, label: "", grain: 0, rotation: 0 };
const palette = {
  ...palettes.monochrome,
  foreground: "#ff0000",
  accent: "#00ff00",
};
const box = (
  x: number,
  y: number,
  size: number,
  role: Stroke["role"],
  opacity = 1,
): Stroke => ({
  points: [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ],
  fill: true,
  closed: true,
  role,
  opacity,
});

for (const grain of [0, 0.7])
  test(`@smoke transparent SVG preserves knockout alpha and paint order with grain ${grain}`, async ({
    page,
  }) => {
    const svg = sceneToSvg(
      {
        strokes: [
          box(10, 10, 80, "foreground"),
          box(20, 20, 60, "background", 0.5),
          box(25, 25, 10, "background", 0.5),
          box(40, 40, 20, "accent"),
          box(45, 45, 10, "background", 0.5),
        ],
      },
      { ...params, grain },
      palette,
      100,
      100,
      true,
    );
    await page.setContent(
      '<canvas id="test-canvas" width="100" height="100"></canvas>',
    );
    const pixels = await page.evaluate(async (svg) => {
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("SVG decode failed"));
      });
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await loaded;
      const ctx = (
        document.getElementById("test-canvas") as HTMLCanvasElement
      ).getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return [1, 15, 30, 50, 70].map((n) =>
        Array.from(ctx.getImageData(n, n, 1, 1).data),
      );
    }, svg);
    expect(pixels[0]![3]).toBe(0);
    expect(pixels[1]).toEqual([255, 0, 0, 255]);
    // Multiple 8-bit luminance-mask/compositing stages differ slightly by
    // engine (WebKit measured 62 for ideal 63.75). Allow two alpha bytes,
    // while keeping empty/opaque coverage and paint-order colors strict.
    expect(pixels[2]![3]).toBeGreaterThanOrEqual(62);
    expect(pixels[2]![3]).toBeLessThanOrEqual(66);
    expect(pixels[3]!.slice(0, 3)).toEqual([0, 255, 0]);
    expect(pixels[3]![3]).toBeGreaterThanOrEqual(126);
    expect(pixels[3]![3]).toBeLessThanOrEqual(130);
    expect(pixels[4]![3]).toBeGreaterThanOrEqual(126);
    expect(pixels[4]![3]).toBeLessThanOrEqual(130);
  });

test("@smoke SVG glow remains visible on a zero-height horizontal path", async ({
  page,
}) => {
  const svg = sceneToSvg(
    {
      strokes: [
        {
          points: [
            { x: 10, y: 50 },
            { x: 90, y: 50 },
          ],
          role: "foreground",
          width: 2,
          glow: true,
        },
      ],
    },
    params,
    palette,
    100,
    100,
    true,
  );
  await page.setContent(
    '<canvas id="test-canvas" width="100" height="100"></canvas>',
  );
  const alpha = await page.evaluate(async (svg) => {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("SVG decode failed"));
    });
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await loaded;
    const ctx = (
      document.getElementById("test-canvas") as HTMLCanvasElement
    ).getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    return [50, 55].map((y) => ctx.getImageData(50, y, 1, 1).data[3]);
  }, svg);
  expect(alpha[0]).toBeGreaterThan(200);
  expect(alpha[1]).toBeGreaterThan(0);
});

test("@smoke feathered line opacity has no dark bead at an internal vertex", async ({
  page,
}) => {
  const { applyInfluenceToLine } =
    await import("../../web/src/studios/common.ts");
  const zero = new Float32Array(4);
  const masks = {
    width: 2,
    height: 2,
    building: new Float32Array([0.6, 0.4, 0.6, 0.4]),
    road: zero,
    water: zero,
    ocean: zero,
    lake: zero,
    river: zero,
  };
  const strokes = applyInfluenceToLine(
    [
      { x: 10, y: 50 },
      { x: 50, y: 50 },
      { x: 90, y: 50 },
    ],
    100,
    100,
    masks,
    { ...params, buildingInfluence: 100, buildingMode: "flatten" },
    2,
    1,
    "foreground",
    false,
    "building",
  );
  const svg = sceneToSvg({ strokes }, params, palette, 100, 100, true);
  await page.setContent(
    '<canvas id="test-canvas" width="100" height="100"></canvas>',
  );
  const alpha = await page.evaluate(async (svg) => {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("SVG decode failed"));
    });
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await loaded;
    const ctx = (
      document.getElementById("test-canvas") as HTMLCanvasElement
    ).getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    return [40, 50, 60].map((x) => ctx.getImageData(x, 50, 1, 1).data[3]!);
  }, svg);
  for (const value of alpha) {
    expect(value).toBeGreaterThanOrEqual(127);
    expect(value).toBeLessThanOrEqual(129);
  }
});
