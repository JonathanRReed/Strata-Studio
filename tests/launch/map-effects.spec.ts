import Pbf from "../../web/node_modules/pbf/index.js";
import { test, expect } from "./fixtures";
import {
  encodeMapTileBundle,
  mapTilesForBounds,
} from "../../workers/proxy/src/mapTiles";
import { defaultStyleParams } from "../../web/src/presets/stylePresets";

function featureTile() {
  const pbf = new Pbf();
  const zig = (n: number) => (n < 0 ? -n * 2 - 1 : n * 2);
  const layer = (
    name: string,
    type: number,
    points: number[][],
    classification?: string,
  ) => {
    pbf.writeMessage(
      3,
      (_: unknown, out: Pbf) => {
        out.writeStringField(1, name);
        out.writeVarintField(15, 2);
        out.writeVarintField(5, 4096);
        if (classification) {
          out.writeStringField(3, "class");
          out.writeMessage(
            4,
            (_: unknown, value: Pbf) =>
              value.writeStringField(1, classification),
            null,
          );
        }
        out.writeMessage(
          2,
          (_: unknown, feature: Pbf) => {
            feature.writeVarintField(3, type);
            if (classification) feature.writePackedVarint(2, [0, 0]);
            const geometry = [
              9,
              zig(points[0][0]),
              zig(points[0][1]),
              ((points.length - 1) << 3) | 2,
            ];
            for (let i = 1; i < points.length; i++)
              geometry.push(
                zig(points[i][0] - points[i - 1][0]),
                zig(points[i][1] - points[i - 1][1]),
              );
            if (type === 3) geometry.push(15);
            feature.writePackedVarint(4, geometry);
          },
          null,
        );
      },
      null,
    );
  };
  layer("building", 3, [
    [800, 900],
    [1800, 900],
    [1800, 1900],
    [800, 1900],
  ]);
  layer(
    "transportation",
    2,
    [
      [100, 100],
      [3900, 3900],
    ],
    "minor",
  );
  layer(
    "water",
    3,
    [
      [2400, 2700],
      [3800, 2700],
      [3800, 3800],
      [2400, 3800],
    ],
    "lake",
  );
  return pbf.finish();
}

for (const style of ["ridge", "waveform-terrain"])
  test(`@smoke streets, buildings and water each visibly change NYC artwork (${style})`, async ({
    page,
    pageErrors,
  }) => {
    test.setTimeout(60000);
    const bounds = {
      south: 40.75,
      west: -74.003,
      north: 40.763,
      east: -73.982,
    };
    const payload = featureTile();
    await page.route("https://strata-proxy.example/map-features?*", (route) => {
      const query = new URL(route.request().url()).searchParams;
      const requested = {
        south: Number(query.get("south")),
        west: Number(query.get("west")),
        north: Number(query.get("north")),
        east: Number(query.get("east")),
      };
      expect(requested.west).toBeGreaterThan(-74.1);
      expect(requested.east).toBeLessThan(-73.8);
      return route.fulfill({
        status: 200,
        contentType: "application/vnd.strata.map-tiles",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: Buffer.from(
          encodeMapTileBundle(
            "20261018_080001_pt",
            mapTilesForBounds(requested).map((tile) => ({
              ...tile,
              bytes: payload,
            })),
          ),
        ),
      });
    });
    const composition = Buffer.from(
      JSON.stringify({
        kind: "strata-composition",
        version: 1,
        bounds,
        zoom: 13,
        style,
        params: {
          ...defaultStyleParams,
          grain: 0,
          noise: 0,
          occlusion: 0,
          label: "New York",
          buildingInfluence: 0,
          roadInfluence: 0,
          waterInfluence: 0,
        },
      }),
    ).toString("base64url");
    await page.goto(`/?composition=${composition}`);
    await expect(
      page.getByRole("button", { name: "Regenerate now" }),
    ).toBeEnabled({ timeout: 20000 });
    // Restoring square artwork can expand the original non-square bounds
    // over another tile, so require each layer rather than exactly one fragment.
    await expect(
      page.getByText(
        /Map tiles: [1-9]\d* building shapes, [1-9]\d* road segments, [1-9]\d* water shapes/,
      ),
    ).toBeVisible();
    const canvas = page.getByRole("img", { name: /artwork of/i });
    const pixels = () =>
      canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
    const baseline = await pixels();
    for (const name of ["Building", "Road", "Water"]) {
      await page
        .getByRole("combobox", { name: `${name} mode`, exact: true })
        .selectOption("interrupt");
      const slider = page.getByRole("slider", {
        name: name === "Water" ? "Water influence (all)" : `${name} influence`,
        exact: true,
      });
      await slider.press("End");
      await expect.poll(pixels, { timeout: 10000 }).not.toBe(baseline);
      await slider.press("Home");
      await expect.poll(pixels, { timeout: 10000 }).toBe(baseline);
    }
    expect(pageErrors).toEqual([]);
  });
