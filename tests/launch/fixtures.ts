import { encodeMapTileBundle, mapTilesForBounds } from "../../workers/proxy/src/mapTiles";
import { readFileSync } from "node:fs";
import { test as base, expect } from "@playwright/test";

const TERRAIN_TIFF = readFileSync(
  new URL("./terrain-fixture.tif", import.meta.url),
);

const MAP_STYLE = {
  version: 8,
  name: "Strata launch fixture",
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#101014" },
    },
  ],
};

/**
 * A fresh visit boots on the date's Daily Strata place (web/src/data/places.ts),
 * so an unpinned clock makes every boot-dependent test depend on the day it
 * runs. Pin the page clock to a day whose place (Golden Gate) uses a
 * terrain-driven style that draws strokes from the fixture terrain.
 * `setSystemTime` only moves the wall clock: Date keeps flowing and timers,
 * animation frames, and `page.waitForTimeout` waits still advance in real time.
 */
export const LAUNCH_NOW = new Date("2026-10-14T12:00:00Z");

type LaunchOptions = {
  /** Wall-clock start for each page. A date-sensitive test overrides it with `test.use`; `null` keeps the real clock. */
  launchNow: Date | null;
};

type LaunchFixtures = {
  externalRequests: string[];
  pageErrors: string[];
};

export const test = base.extend<LaunchOptions & LaunchFixtures>({
  launchNow: [LAUNCH_NOW, { option: true }],
  externalRequests: async ({}, use) => {
    await use([]);
  },
  pageErrors: async ({}, use) => {
    await use([]);
  },
  page: async ({ page, launchNow, externalRequests, pageErrors }, use) => {
    if (launchNow) await page.clock.setSystemTime(launchNow);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("https://**/*", async (route) => {
      const url = new URL(route.request().url());
      externalRequests.push(url.href);

      if (
        url.hostname === "tiles.openfreemap.org" &&
        url.pathname === "/styles/dark"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify(MAP_STYLE),
        });
        return;
      }

      if (
        url.hostname === "strata-proxy.example" &&
        url.pathname.startsWith("/terrain-geotiff/")
      ) {
        await route.fulfill({
          status: 200,
          contentType: "image/tiff",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: TERRAIN_TIFF,
        });
        return;
      }

      if (
        url.hostname === "strata-proxy.example" &&
        url.pathname === "/map-features"
      ) {
        const q=url.searchParams;
        const bounds={south:Number(q.get("south")),west:Number(q.get("west")),north:Number(q.get("north")),east:Number(q.get("east"))};
        const bytes=new Uint8Array([26,15,10,8,98,117,105,108,100,105,110,103,120,2,40,128,32]);
        await route.fulfill({status:200,contentType:"application/vnd.strata.map-tiles",headers:{"Access-Control-Allow-Origin":"*"},body:Buffer.from(encodeMapTileBundle("20261018_080001_pt",mapTilesForBounds(bounds).map(tile=>({...tile,bytes}))))});
        return;
      }

      if (
        url.hostname === "nominatim.openstreetmap.org" &&
        url.pathname === "/reverse"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ address: { city: "Fixture City" } }),
        });
        return;
      }

      if (
        url.hostname === "nominatim.openstreetmap.org" &&
        url.pathname === "/search"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify([
            {
              lat: "40.7600",
              lon: "-73.9700",
              display_name: "Manhattan, New York, United States",
            },
          ]),
        });
        return;
      }

      await route.abort("blockedbyclient");
    });

    await use(page);
  },
});

export { expect };
