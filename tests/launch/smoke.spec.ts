import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";
import { encodeMapTileBundle, mapTilesForBounds } from "../../workers/proxy/src/mapTiles";

test.describe.configure({ mode: "serial" });

const DIRECT_DATA_HOSTS = new Set([
  "s3.amazonaws.com",
  "overpass-api.de",
  "overpass.private.coffee",
  "maps.mail.ru",
]);

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

type SharedComposition = {
  bounds: { west: number; south: number; east: number; north: number };
};

function sharedComposition(url: string): SharedComposition | null {
  const encoded = new URL(url).searchParams.get("composition");
  if (!encoded) return null;
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SharedComposition;
}

function directDataRequests(requests: string[]): string[] {
  return requests.filter((request) =>
    DIRECT_DATA_HOSTS.has(new URL(request).hostname),
  );
}

test("@smoke fresh visit renders proxy-backed artwork exactly once", async ({
  page,
  externalRequests,
  pageErrors,
}) => {
  test.setTimeout(45_000);
  await page.addInitScript(() => {
    const busyByButton = new WeakMap<Element, boolean>();
    let starts = 0;
    Object.defineProperty(window, "__strataGenerateBusyStarts", {
      configurable: true,
      get: () => starts,
    });
    const scan = () => {
      for (const button of document.querySelectorAll("button[aria-busy]")) {
        const busy = button.getAttribute("aria-busy") === "true";
        const previous = busyByButton.get(button) ?? false;
        if (busy && !previous) starts++;
        busyByButton.set(button, busy);
      }
    };
    new MutationObserver(scan).observe(document, {
      attributes: true,
      attributeFilter: ["aria-busy"],
      childList: true,
      subtree: true,
    });
    queueMicrotask(scan);
  });

  await page.goto("/");

  await expect(page).toHaveTitle(/Strata Studio/);
  await expect(
    page.getByRole("heading", { name: "Strata Studio" }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: /artwork of/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate now" })).toBeEnabled({
    timeout: 30_000,
  });
  // Let MapLibre's initial resize/fit and the live-regeneration debounce pass.
  // A provisional resize report used to start a second boot generation here.
  await page.waitForTimeout(1_200);
  expect(
    await page.evaluate(
      () => (window as Window & { __strataGenerateBusyStarts?: number }).__strataGenerateBusyStarts,
    ),
  ).toBe(1);
  expect(pageErrors).toEqual([]);

  await expect
    .poll(() =>
      externalRequests.some((request) =>
        request.includes("strata-proxy.example/terrain-geotiff/"),
      ),
    )
    .toBe(true);
  expect(directDataRequests(externalRequests)).toEqual([]);

  const response = await page.request.get("/build-info.json");
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    app: "strata-studio",
    dataPolicy: "proxy-first",
    appOrigin: "https://strata-studio.example",
    canonicalOrigin: "https://stratastudio.jonathanrreed.com",
    dataRoutes: {
      terrain: "https://strata-proxy.example/terrain",
      overpass: "https://strata-proxy.example/overpass",
    },
  });
});

test("@smoke artwork boots and location choices work without the map chunk", async ({
  page,
  externalRequests,
  pageErrors,
}) => {
  await page.route("**/assets/MapSelector-*.js", async (route) => {
    await route.abort("failed");
  });

  await page.goto("/");

  await expect(page.getByRole("img", { name: /artwork of/i })).toBeVisible();
  await expect(page.getByLabel("Map unavailable")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Locating", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Regenerate now" })).toBeEnabled({
    timeout: 20_000,
  });
  await expect
    .poll(() =>
      externalRequests.some((request) =>
        request.includes("strata-proxy.example/terrain-geotiff/"),
      ),
    )
    .toBe(true);

  await page.getByRole("button", { name: "Expand map" }).click();
  const curatedPlaces = page.getByRole("group", { name: "Suggested places" });
  await expect(curatedPlaces).toBeVisible();
  await curatedPlaces.getByRole("button", { name: /Manhattan/ }).click();
  await expect(
    curatedPlaces.getByRole("button", { name: /Manhattan/ }),
  ).toHaveAttribute("aria-pressed", "true");

  expect(pageErrors).toEqual([]);
  expect(directDataRequests(externalRequests)).toEqual([]);
});

test("@smoke MapLibre loads its same-origin module worker", async ({
  page,
  externalRequests,
  pageErrors,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Worker startup is verified with Chromium WebGL2.");
  const workerUrls: string[] = [];
  page.on("worker", (worker) => workerUrls.push(worker.url()));
  await page.route("https://tiles.openfreemap.org/styles/dark", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      version: 8,
      sources: {
        fixture: {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [-122.4783, 37.8199] },
          },
        },
      },
      layers: [
        { id: "background", type: "background", paint: { "background-color": "#101014" } },
        { id: "point", type: "circle", source: "fixture", paint: { "circle-radius": 8 } },
      ],
    }),
  }));
  await page.goto("/");
  await expect(page.getByLabel("Interactive area selection map")).toBeVisible();
  await expect.poll(() => workerUrls.some((url) => url.includes("maplibre-gl-worker"))).toBe(true);
  // The load event requires successful source processing, not just Worker construction.
  await expect(page.getByLabel("Map for area selection", { exact: true })).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
  const mapWorkers = workerUrls.filter((url) => url.includes("maplibre-gl-worker"));
  for (const url of mapWorkers) {
    expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    expect(new URL(url).pathname).toMatch(/\/assets\/maplibre-gl-worker-[^/]+\.js$/);
  }
  await expect(page.getByRole("button", { name: "Regenerate now" })).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByLabel("Map unavailable")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  expect(directDataRequests(externalRequests)).toEqual([]);
});

test("@smoke WebGL1-only devices use the functional map fallback", async ({ page, pageErrors }) => {
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    let webGl1Probes = 0;
    Object.defineProperty(window, "__strataWebGl1Probes", { get: () => webGl1Probes });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: function (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
        if (contextId === "webgl2") return null;
        if (contextId === "webgl") webGl1Probes++;
        return Reflect.apply(originalGetContext, this, [contextId, ...args]);
      },
    });
  });
  await page.goto("/");
  await expect(page.getByLabel("Map unavailable")).toBeVisible();
  await expect(page.getByText("WebGL2 is unavailable in this browser or device")).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate now" })).toBeEnabled({ timeout: 20_000 });
  expect(await page.evaluate(() => (window as Window & { __strataWebGl1Probes: number }).__strataWebGl1Probes)).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("@smoke artwork continues when WebGL is unavailable", async ({
  page,
  externalRequests,
  pageErrors,
}) => {
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: function (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
        if (contextId === "webgl" || contextId === "webgl2") return null;
        return Reflect.apply(originalGetContext, this, [contextId, ...args]);
      },
    });
  });

  await page.goto("/");
  await expect(page.getByRole("img", { name: /artwork of/i })).toBeVisible();
  await expect(page.getByLabel("Map unavailable")).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate now" })).toBeEnabled({
    timeout: 20_000,
  });
  expect(pageErrors).toEqual([]);
  expect(directDataRequests(externalRequests)).toEqual([]);
});

test("@smoke artwork continues when the basemap style fails", async ({
  page,
  externalRequests,
  pageErrors,
}) => {
  await page.route("https://tiles.openfreemap.org/styles/dark", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "text/plain",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: "style unavailable",
    });
  });

  await page.goto("/");
  await expect(page.getByRole("img", { name: /artwork of/i })).toBeVisible();
  await expect(page.getByLabel("Map unavailable")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Regenerate now" })).toBeEnabled({
    timeout: 20_000,
  });
  expect(pageErrors).toEqual([]);
  expect(directDataRequests(externalRequests)).toEqual([]);
});

test("@smoke map recovery preserves the active selection", async ({
  page,
  externalRequests,
  pageErrors,
}, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Synthetic WebGL loss recovery is covered in Chromium.");

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Regenerate now" })).toBeEnabled({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Expand map" }).click();
  const curatedPlaces = page.getByRole("group", { name: "Suggested places" });
  await curatedPlaces.getByRole("button", { name: /Manhattan/ }).click();
  await expect
    .poll(() => {
      const bounds = sharedComposition(page.url())?.bounds;
      if (!bounds) return false;
      const lng = (bounds.west + bounds.east) / 2;
      const lat = (bounds.south + bounds.north) / 2;
      return Math.abs(lng + 73.97) < 0.01 && Math.abs(lat - 40.76) < 0.01;
    })
    .toBe(true);
  const selectedBounds = JSON.stringify(sharedComposition(page.url())?.bounds ?? null);
  expect(selectedBounds).not.toBe("null");

  const mapCanvas = page.locator(".maplibregl-canvas");
  await expect(mapCanvas).toBeVisible();
  await mapCanvas.evaluate((canvas) => {
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
  });
  await expect(page.getByLabel("Map unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Retry map" }).click();
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);

  expect(JSON.stringify(sharedComposition(page.url())?.bounds ?? null)).toBe(selectedBounds);
  expect(pageErrors).toEqual([]);
  expect(directDataRequests(externalRequests)).toEqual([]);
});

test("@smoke map-feature failure disables ineffective controls without probing public Overpass",async({page,externalRequests,pageErrors})=>{
 await page.route("https://strata-proxy.example/map-features?*",route=>route.fulfill({status:503,contentType:"application/json",headers:{"Access-Control-Allow-Origin":"*"},body:JSON.stringify({error:{code:"unavailable"}})}));
 await page.goto("/");
 await expect(page.getByRole("button",{name:"Regenerate now"})).toBeEnabled({timeout:20000});
 const features=page.getByRole("button",{name:/^Features/});
 if(await features.getAttribute("aria-expanded")==="false")await features.click();
 await expect(page.getByText("Feature fetch failed",{exact:true})).toBeVisible({timeout:20000});
 await expect(page.getByText(/Terrain-only preview/)).toBeVisible();
 await expect(page.getByRole("slider",{name:"Building influence",exact:true})).toBeDisabled();
 expect(externalRequests.some(url=>url.includes("/overpass")||url.includes("/interpreter"))).toBe(false);
 expect(pageErrors).toEqual([]);
});

test("@smoke evaluator can choose a place, change style, generate, and export", async ({
  page,
  externalRequests,
  pageErrors,
}) => {
  await page.goto("/");
  const generate = page.getByRole("button", {
    name: /Regenerating|Regenerate now/,
  });
  await expect(generate).toBeEnabled({ timeout: 20_000 });

  await page.getByRole("button", { name: "Expand map" }).click();
  const curatedPlaces = page.getByRole("group", { name: "Suggested places" });
  await expect(curatedPlaces).toBeVisible();
  const manhattan = curatedPlaces.getByRole("button", { name: /Manhattan/ });
  await manhattan.click();
  await expect(manhattan).toHaveAttribute("aria-pressed", "true");

  await expect
    .poll(
      () =>
        externalRequests.some((request) =>
          request.includes(
            "strata-proxy.example/map-features?south=",
          ),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  await page.getByRole("button", { name: "Collapse map" }).click();

  await page.getByRole("tab", { name: "Experimental Lab" }).click();
  await expect(
    page.getByRole("tab", { name: "Experimental Lab" }),
  ).toHaveAttribute("aria-selected", "true");

  const composition = page.getByRole("button", { name: "Composition" });
  if ((await composition.getAttribute("aria-expanded")) !== "true") {
    await composition.click();
  }
  await page.getByRole("textbox", { name: "Label" }).fill("Launch Fixture");
  await expect(
    page.getByRole("img", { name: /Launch Fixture/i }),
  ).toBeVisible();

  await generate.evaluate((element) => {
    const button = element as HTMLButtonElement;
    button.dataset.launchTestBusyObserved = String(
      button.getAttribute("aria-busy") === "true",
    );
    const observer = new MutationObserver(() => {
      if (button.getAttribute("aria-busy") === "true") {
        button.dataset.launchTestBusyObserved = "true";
        observer.disconnect();
      }
    });
    observer.observe(button, {
      attributes: true,
      attributeFilter: ["aria-busy"],
    });
  });
  await generate.click();
  await expect(generate).toHaveAttribute(
    "data-launch-test-busy-observed",
    "true",
  );
  await expect(generate).toBeEnabled({ timeout: 20_000 });

  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  await expect(dialog).toBeVisible();
  const screenSize = dialog.getByRole("radio", { name: /1024/ });
  await screenSize.focus();
  await screenSize.press("Space");
  await expect(screenSize).toBeChecked();

  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^strata-.*-1024x1024\.png$/);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  if (!downloadPath)
    throw new Error("Playwright did not expose the download path.");
  const png = await readFile(downloadPath);
  expect(Array.from(png.subarray(0, PNG_SIGNATURE.length))).toEqual(
    PNG_SIGNATURE,
  );
  expect(png.byteLength).toBeGreaterThan(PNG_SIGNATURE.length);

  expect(pageErrors).toEqual([]);
  expect(directDataRequests(externalRequests)).toEqual([]);
});

test("@smoke primary map tiles expose snapshot provenance and preserves SVG attribution", async ({ page, externalRequests, pageErrors }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Regenerate now" })).toBeEnabled({ timeout: 20_000 });
  let tileCalls = 0;
  await page.route("https://strata-proxy.example/overpass?*", route => route.fulfill({
    status: 503, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*", "Retry-After": "0" }, body: JSON.stringify({ error: { code: "overpass_disabled" } }),
  }));
  await page.route("https://strata-proxy.example/map-features?*", async route => {
    tileCalls++;
    const query = new URL(route.request().url()).searchParams;
    const bounds = { south: Number(query.get("south")), west: Number(query.get("west")), north: Number(query.get("north")), east: Number(query.get("east")) };
    // A real protobuf layer with a small closed building polygon in tile coordinates.
    const bytes = new Uint8Array([26,39,10,8,98,117,105,108,100,105,110,103,120,2,40,128,32,18,22,8,123,24,3,34,16,9,208,15,208,15,26,200,1,0,0,200,1,199,1,0,15]);
    const bundle = encodeMapTileBundle("20261018_080001_pt", mapTilesForBounds(bounds).map(tile => ({ ...tile, bytes })));
    await route.fulfill({ status: 200, contentType: "application/vnd.strata.map-tiles", headers: { "Access-Control-Allow-Origin": "*" }, body: Buffer.from(bundle) });
  });
  await page.getByRole("button", { name: "Expand map" }).click();
  await page.getByRole("group", { name: "Suggested places" }).getByRole("button", { name: /Manhattan/ }).click();
  await expect.poll(() => tileCalls, { timeout: 20_000 }).toBe(1);
  await page.getByRole("button", { name: "Collapse map" }).click();
  const features = page.getByRole("button", { name: /^Features/ });
  if (await features.getAttribute("aria-expanded") !== "true") await features.click();
  await expect(page.getByText(/Generalized map geometry; snapshot 2026-10-18/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Regenerate now" })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  const svgFormat = dialog.getByRole("radio", { name: "SVG" });
  await svgFormat.focus();
  await svgFormat.press("Space");
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (!path) throw new Error("SVG download was not available");
  const svg = await readFile(path, "utf8");
  expect(svg).toContain("OpenMapTiles");
  expect(svg).toContain("OpenStreetMap");
  expect(tileCalls).toBe(1);
  expect(directDataRequests(externalRequests)).toEqual([]);
  expect(pageErrors).toEqual([]);
});
