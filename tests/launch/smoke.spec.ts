import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";

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
        request.includes("strata-proxy.example/terrain/"),
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
        request.includes("strata-proxy.example/terrain/"),
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

test("@smoke Overpass proxy failure uses one bounded direct fallback", async ({
  page,
  pageErrors,
}) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Regenerate now" })).toBeEnabled({
    timeout: 20_000,
  });

  let proxyCalls = 0;
  let directCalls = 0;
  let proxyRequestUrl = "";
  let directPostBody = "";
  await page.route("https://strata-proxy.example/overpass?*", async (route) => {
    proxyCalls++;
    proxyRequestUrl = route.request().url();
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Retry-After": "0",
      },
      body: JSON.stringify({ error: { code: "overpass_disabled" } }),
    });
  });
  await page.route(
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    async (route) => {
      directCalls++;
      directPostBody = route.request().postData() ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ elements: [] }),
      });
    },
  );

  await page.getByRole("button", { name: "Expand map" }).click();
  const curatedPlaces = page.getByRole("group", { name: "Suggested places" });
  await curatedPlaces.getByRole("button", { name: /Manhattan/ }).click();

  await expect.poll(() => directCalls, { timeout: 20_000 }).toBe(1);
  expect(proxyCalls).toBe(1);
  const proxyUrl = new URL(proxyRequestUrl);
  expect(proxyUrl.search).toMatch(
    /^\?south=-?\d+\.\d{4}&west=-?\d+\.\d{4}&north=-?\d+\.\d{4}&east=-?\d+\.\d{4}$/,
  );
  expect([...proxyUrl.searchParams.keys()]).toEqual([
    "south",
    "west",
    "north",
    "east",
  ]);
  expect(new URLSearchParams(directPostBody).get("data")).toContain(
    'way["building"]',
  );
  expect(pageErrors).toEqual([]);
});

test("@smoke evaluator can choose a place, change style, generate, and export", async ({
  page,
  externalRequests,
  pageErrors,
}) => {
  await page.goto("/");
  const generate = page.getByRole("button", { name: "Regenerate now" });
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
            "strata-proxy.example/overpass?south=",
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
