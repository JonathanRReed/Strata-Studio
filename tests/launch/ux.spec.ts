import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";

const ORIENTATION_KEY = "strata.orientation.dismissed";

type SharedDocument = {
  bounds: { west: number; south: number; east: number; north: number };
  params: { aspectRatio: string; label: string; palette: string };
  customPalette?: { name: string };
};

function sharedDocument(url: string): SharedDocument | null {
  const encoded = new URL(url).searchParams.get("composition");
  if (!encoded) return null;
  return JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as SharedDocument;
}

async function waitForArtwork(page: import("@playwright/test").Page) {
  await expect(page.getByRole("img", { name: /artwork of/i })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Regenerate now" }),
  ).toBeEnabled({
    timeout: 30_000,
  });
}

async function startWithoutOrientation(page: import("@playwright/test").Page) {
  await page.addInitScript(
    (key) => localStorage.setItem(key, "1"),
    ORIENTATION_KEY,
  );
  await page.goto("/");
  await waitForArtwork(page);
}

test("@smoke first-session orientation routes desktop actions and persists dismissal", async ({
  page,
}) => {
  await page.goto("/");
  await waitForArtwork(page);

  const guide = page.getByRole("complementary", {
    name: "Your Daily Strata is ready",
  });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText(" · ");

  const choosePlace = guide.getByRole("button", { name: "Choose your place" });
  await choosePlace.click();
  const mapDialog = page.getByRole("dialog", { name: "Choose artwork area" });
  await expect(mapDialog).toBeVisible();
  await expect(mapDialog).toBeFocused();
  await expect(page.locator("#controls-panel")).toHaveAttribute("inert", "");
  const describedBy = await mapDialog.getAttribute("aria-describedby");
  expect(describedBy).toBe("map-keyboard-instructions");
  await expect(page.locator(`#${describedBy}`)).toContainText("arrow keys");

  await page.keyboard.press("Escape");
  await expect(mapDialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Expand map" })).toBeFocused();
  await expect(guide).toBeHidden();

  await page.evaluate((key) => localStorage.removeItem(key), ORIENTATION_KEY);
  await page.reload();
  await waitForArtwork(page);
  const renewedGuide = page.getByRole("complementary", {
    name: "Your Daily Strata is ready",
  });
  await renewedGuide.getByRole("button", { name: "Customize artwork" }).click();
  await expect(page.locator("#style-controls-section-toggle")).toBeFocused();
  await expect(renewedGuide).toBeHidden();

  await page.reload();
  await waitForArtwork(page);
  await expect(guide).toHaveCount(0);
});

test("@smoke first-session Customize artwork opens the mobile Style sheet", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await waitForArtwork(page);

  const guide = page.getByRole("complementary", {
    name: "Your Daily Strata is ready",
  });
  await guide.getByRole("button", { name: "Customize artwork" }).click();
  const styleTab = page.getByRole("tab", { name: "Style" });
  await expect(styleTab).toHaveAttribute("aria-selected", "true");
  await expect(styleTab).toBeFocused();

  const sheet = page.getByRole("region", { name: "Artwork controls" });
  const transitionSeconds = await sheet.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).transitionDuration),
  );
  expect(transitionSeconds).toBeLessThanOrEqual(0.001);
});

test("@smoke every aspect preserves center and starts exactly one normal regeneration", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript((key) => {
    localStorage.setItem(key, "1");
    const busyByButton = new WeakMap<Element, boolean>();
    let starts = 0;
    Object.defineProperty(window, "__strataAspectBusyStarts", {
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
  }, ORIENTATION_KEY);
  await page.goto("/");
  await waitForArtwork(page);
  await page.waitForTimeout(1_200);

  const busyStarts = () =>
    page.evaluate(
      () =>
        (window as Window & { __strataAspectBusyStarts?: number })
          .__strataAspectBusyStarts ?? 0,
    );
  const baseline = await busyStarts();
  const initial = sharedDocument(page.url())!;
  const initialCenter = [
    (initial.bounds.west + initial.bounds.east) / 2,
    (initial.bounds.south + initial.bounds.north) / 2,
  ];
  const composition = page.getByRole("button", { name: "Composition" });
  if ((await composition.getAttribute("aria-expanded")) !== "true") {
    await composition.click();
  }
  const aspectSelect = page.getByRole("combobox", { name: "Aspect ratio" });
  const cases = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["12:18", 12 / 18],
    ["square", 1],
  ] as const;

  for (const [aspect, ratio] of cases) {
    const startsBefore = await busyStarts();
    await aspectSelect.selectOption(aspect);
    await expect.poll(busyStarts, { timeout: 30_000 }).toBe(startsBefore + 1);
    const regenerate = page.getByRole("button", {
      name: /Regenerating|Regenerate now/,
    });
    await expect(regenerate).toBeEnabled({ timeout: 30_000 });
    await expect
      .poll(() => sharedDocument(page.url())?.params.aspectRatio, {
        timeout: 30_000,
      })
      .toBe(aspect);

    const current = sharedDocument(page.url())!;
    const center = [
      (current.bounds.west + current.bounds.east) / 2,
      (current.bounds.south + current.bounds.north) / 2,
    ];
    expect(center[0]).toBeCloseTo(initialCenter[0], 4);
    expect(center[1]).toBeCloseTo(initialCenter[1], 4);
    expect(current.params.aspectRatio).toBe(aspect);

    // Headless Firefox can use the no-WebGL map fallback. The artboard stays
    // available in both map modes and is the user-visible aspect outcome.
    const artwork = page.getByRole("img", { name: /artwork of/i });
    await expect(artwork).toBeVisible();
    const box = await artwork.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width / box!.height).toBeCloseTo(ratio, 2);
  }

  const starts = await busyStarts();
  expect(starts).toBe(baseline + cases.length);
  const restoredSquare = sharedDocument(page.url())!.bounds;
  for (const key of ["west", "south", "east", "north"] as const) {
    // The no-WebGL fallback recomputes geographic bounds. Six decimals keeps
    // the allowed floating-point drift below roughly five centimeters.
    expect(restoredSquare[key]).toBeCloseTo(initial.bounds[key], 6);
  }
});

test("@smoke expanded map traps focus, exposes canvas focus, and clears curated state only after manual/search moves", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "MapLibre keyboard interaction is covered in Chromium.",
  );
  await startWithoutOrientation(page);

  const expand = page.getByRole("button", { name: "Expand map" });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "Choose artwork area" });
  await expect(dialog).toBeFocused();
  const canvas = page.locator(".maplibregl-canvas");
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).toBeFocused();
  await dialog.focus();

  const curated = page.getByRole("group", { name: "Suggested places" });
  const manhattan = curated.getByRole("button", { name: /Manhattan/ });
  await manhattan.click();
  await expect(manhattan).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(500);
  await expect(manhattan).toHaveAttribute("aria-pressed", "true");

  await canvas.focus();
  await expect(canvas).toBeFocused();
  const outline = await canvas.evaluate((element) => ({
    style: getComputedStyle(element).outlineStyle,
    width: getComputedStyle(element).outlineWidth,
  }));
  expect(outline.style).not.toBe("none");
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  await canvas.press("ArrowRight");
  await expect(manhattan).toHaveAttribute("aria-pressed", "false", {
    timeout: 10_000,
  });

  await manhattan.click();
  await expect(manhattan).toHaveAttribute("aria-pressed", "true");
  const search = page.getByRole("textbox", { name: "Search for a location" });
  await search.fill("Manhattan east");
  await search.press("Enter");
  await expect(manhattan).toHaveAttribute("aria-pressed", "false", {
    timeout: 10_000,
  });

  const firstControl = dialog.getByRole("button", { name: "Surprise me" });
  await firstControl.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(canvas).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstControl).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(expand).toBeFocused();
});

test("@a11y labels, help descriptions, slider values, and palette errors are associated", async ({
  page,
}) => {
  await startWithoutOrientation(page);

  await page.getByRole("tab", { name: "Experimental Lab" }).click();
  await page
    .getByRole("button", { name: "Waveform Terrain", exact: true })
    .click();
  await page.getByRole("button", { name: "Terrain", exact: true }).click();

  const slider = page.getByRole("slider", { name: "Amplitude" });
  const sliderId = await slider.getAttribute("id");
  expect(sliderId).toBeTruthy();
  const describedBy = await slider.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  await expect(page.locator(`#${describedBy}`)).toContainText(
    "terrain displaces",
  );
  await expect(
    page.getByRole("button", { name: "Amplitude help" }),
  ).toBeVisible();
  await expect(page.locator(`output[for="${sliderId}"]`)).not.toHaveAttribute(
    "aria-live",
    /.+/,
  );

  const seedPalette = page.getByRole("button", { name: "Seed & Palette" });
  await seedPalette.click();
  await page.getByRole("button", { name: "New palette" }).click();
  const backgroundHex = page.getByRole("textbox", {
    name: "Background",
    exact: true,
  });
  const stableId = await backgroundHex.getAttribute("id");
  await backgroundHex.fill("not-a-color");
  await expect(backgroundHex).toHaveAttribute("id", stableId!);
  await expect(backgroundHex).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("six-digit hex color");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("@smoke Generate stays busy through the complete no-preference reveal", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(false);
  await startWithoutOrientation(page);

  const regenerate = page.getByRole("button", {
    name: /Regenerating|Regenerate now/,
  });
  await regenerate.click();
  await expect(page.getByText("Rendering…", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(300);
  await expect(regenerate).toBeDisabled();
  await expect(regenerate).toBeEnabled({ timeout: 10_000 });
});

test("@smoke first-session guide never covers the artwork across supported layouts", async ({
  page,
}) => {
  await page.goto("/");
  await waitForArtwork(page);
  const guide = page.getByRole("complementary", {
    name: "Your Daily Strata is ready",
  });
  const artwork = page.getByRole("img", { name: /artwork of/i });

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 844, height: 390 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(guide).toBeVisible();
    await expect(artwork).toBeVisible();
    const overlap = await page.evaluate(() => {
      const guideRect = document
        .querySelector<HTMLElement>('[aria-labelledby="orientation-title"]')!
        .getBoundingClientRect();
      const artRect = document
        .querySelector<HTMLElement>('canvas[role="img"]')!
        .getBoundingClientRect();
      return (
        Math.max(
          0,
          Math.min(guideRect.right, artRect.right) -
            Math.max(guideRect.left, artRect.left),
        ) *
        Math.max(
          0,
          Math.min(guideRect.bottom, artRect.bottom) -
            Math.max(guideRect.top, artRect.top),
        )
      );
    });
    expect(overlap).toBeLessThan(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
  }
});

test("@smoke dialog fallback traps focus, inerts background, restores openers, and copies links", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Capability fallback injection is covered in Chromium.",
  );
  await page.addInitScript((key) => {
    localStorage.setItem(key, "1");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: (command: string) => command === "copy",
    });
  }, ORIENTATION_KEY);
  await page.goto("/");
  await waitForArtwork(page);

  const exportOpener = page.getByRole("button", { name: "Export…" });
  await exportOpener.click();
  const exportDialog = page.getByRole("dialog", { name: "Export" });
  await expect(exportDialog).toBeVisible();
  const closeExport = exportDialog.getByRole("button", {
    name: "Close export dialog",
  });
  await expect(closeExport).toBeFocused();
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await page.keyboard.press("Shift+Tab");
  await expect(
    exportDialog.getByRole("button", {
      name: "Import composition",
      exact: true,
    }),
  ).toBeFocused();
  await exportDialog.getByRole("button", { name: "Copy link" }).click();
  await expect(
    exportDialog.getByRole("button", { name: "Copied" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(exportDialog).toBeHidden();
  await expect(exportOpener).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");

  const variationsOpener = page.getByRole("button", { name: "Variations" });
  await variationsOpener.click();
  const variationsDialog = page.getByRole("dialog", { name: "Variations" });
  await expect(variationsDialog).toBeVisible();
  await expect(
    variationsDialog.getByRole("button", { name: "Close variations" }),
  ).toBeFocused();
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(variationsDialog).toBeHidden();
  await expect(variationsOpener).toBeFocused();
});

test("@smoke mobile map restores focus to visible chrome and full sheet inerts artwork", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Pointer-drag sheet modality is covered in Chromium.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await startWithoutOrientation(page);

  const handle = page.locator('button[aria-controls="mobile-sheet-body"]');
  await page.getByRole("button", { name: "Open controls" }).click();
  await page.getByRole("tab", { name: "Place" }).click();
  await page
    .getByRole("button", { name: "Choose area on map (search & pan)" })
    .click();
  await page.keyboard.press("Escape");
  await expect(handle).toBeFocused();

  await handle.click();
  await page.waitForTimeout(350);
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, 20, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.getByRole("dialog", { name: "Artwork controls" }),
  ).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Artwork controls" }),
  ).toHaveCount(0);
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
});

test("@smoke native URL sharing avoids image work when file share is unavailable", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Native share stubbing is covered in Chromium.",
  );
  await page.addInitScript((key) => {
    localStorage.setItem(key, "1");
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => {
        (
          window as Window & { __strataSharedData?: ShareData }
        ).__strataSharedData = data;
      },
    });
  }, ORIENTATION_KEY);
  await page.goto("/");
  await waitForArtwork(page);
  await page.getByRole("button", { name: "Export…" }).click();
  await page
    .getByRole("dialog", { name: "Export" })
    .getByRole("button", { name: "Share…" })
    .click();
  const shared = await page.evaluate(
    () =>
      (window as Window & { __strataSharedData?: ShareData })
        .__strataSharedData,
  );
  expect(shared?.url).toBe(page.url());
  expect(shared?.files).toBeUndefined();
});

test("@smoke native file sharing reuses the resident preview terrain", async ({
  page,
  externalRequests,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Native share stubbing is covered in Chromium.",
  );
  await page.addInitScript((key) => {
    localStorage.setItem(key, "1");
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: () => true,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => {
        const file = data.files?.[0];
        (
          window as Window & {
            __strataSharedFile?: { name: string; size: number };
          }
        ).__strataSharedFile = file
          ? { name: file.name, size: file.size }
          : undefined;
      },
    });
  }, ORIENTATION_KEY);
  await page.goto("/");
  await waitForArtwork(page);
  const terrainRequests = () =>
    externalRequests.filter((request) =>
      request.includes("strata-proxy.example/terrain/"),
    ).length;
  const baseline = terrainRequests();

  await page.getByRole("button", { name: "Export…" }).click();
  await page
    .getByRole("dialog", { name: "Export" })
    .getByRole("button", { name: "Share…" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __strataSharedFile?: { name: string; size: number };
            }
          ).__strataSharedFile,
      ),
    )
    .toEqual(
      expect.objectContaining({
        name: expect.stringMatching(/^strata-.*-1024x1024\.png$/),
        size: expect.any(Number),
      }),
    );
  expect(terrainRequests()).toBe(baseline);
});

test("@smoke every aspect keeps URL, caption, OSM, variations, PNG, SVG, and restore aligned", async ({
  page,
  externalRequests,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Representative multi-format exports are covered in Chromium.",
  );
  test.setTimeout(120_000);
  await startWithoutOrientation(page);
  await page.getByRole("button", { name: "Expand map" }).click();
  await page
    .getByRole("group", { name: "Suggested places" })
    .getByRole("button", { name: /Manhattan/ })
    .click();
  await expect
    .poll(() => {
      const bounds = sharedDocument(page.url())?.bounds;
      if (!bounds) return false;
      return (
        Math.abs((bounds.west + bounds.east) / 2 + 73.97) < 0.01 &&
        Math.abs((bounds.south + bounds.north) / 2 - 40.76) < 0.01
      );
    })
    .toBe(true);
  await page.getByRole("button", { name: "Collapse map" }).click();
  const placeRegeneration = page.getByRole("button", {
    name: /Regenerating|Regenerate now/,
  });
  await expect(placeRegeneration).toBeDisabled();
  await expect(placeRegeneration).toBeEnabled({ timeout: 30_000 });

  const composition = page.getByRole("button", { name: "Composition" });
  if ((await composition.getAttribute("aria-expanded")) !== "true")
    await composition.click();
  const posterLabel = page.getByRole("radio", { name: "Poster" });
  await posterLabel.focus();
  await posterLabel.press("Space");

  const cases = [
    ["16:9", 1024, 576],
    ["9:16", 576, 1024],
    ["12:18", 683, 1024],
    ["square", 1024, 1024],
  ] as const;
  for (const [aspect, width, height] of cases) {
    if ((await composition.getAttribute("aria-expanded")) !== "true")
      await composition.click();
    await page
      .getByRole("combobox", { name: "Aspect ratio" })
      .selectOption(aspect);
    const regenerate = page.getByRole("button", {
      name: /Regenerating|Regenerate now/,
    });
    await expect(regenerate).toBeDisabled();
    await expect(regenerate).toBeEnabled({ timeout: 30_000 });
    const document = sharedDocument(page.url())!;
    const { bounds } = document;
    const centerLat = (bounds.south + bounds.north) / 2;
    const centerLng = (bounds.west + bounds.east) / 2;
    const captionCoords = `${Math.abs(centerLat).toFixed(4)}°${centerLat >= 0 ? "N" : "S"} ${Math.abs(centerLng).toFixed(4)}°${centerLng >= 0 ? "E" : "W"}`;
    await expect(page.getByText(captionCoords, { exact: false })).toBeVisible();

    const matchingOsmRequests = () =>
      externalRequests
        .filter((url) => url.includes("strata-proxy.example/overpass?"))
        .map((url) => new URL(url))
        .filter((candidate) => {
          const south = Number(candidate.searchParams.get("south"));
          const west = Number(candidate.searchParams.get("west"));
          const north = Number(candidate.searchParams.get("north"));
          const east = Number(candidate.searchParams.get("east"));
          return (
            south <= bounds.south &&
            west <= bounds.west &&
            north >= bounds.north &&
            east >= bounds.east &&
            Math.abs((south + north) / 2 - centerLat) < 0.01 &&
            Math.abs((west + east) / 2 - centerLng) < 0.01
          );
        });
    await expect
      .poll(() => matchingOsmRequests().length, { timeout: 20_000 })
      .toBeGreaterThan(0);
    expect(matchingOsmRequests().at(-1)!.search).toMatch(
      /^\?south=-?\d+\.\d{4}&west=-?\d+\.\d{4}&north=-?\d+\.\d{4}&east=-?\d+\.\d{4}$/,
    );

    await page.getByRole("button", { name: "Variations" }).click();
    const variations = page.getByRole("dialog", { name: "Variations" });
    const variationCanvas = variations.locator("canvas").first();
    await expect(variationCanvas).toHaveAttribute(
      "width",
      String(Math.round((220 * width) / Math.max(width, height))),
    );
    await expect(variationCanvas).toHaveAttribute(
      "height",
      String(Math.round((220 * height) / Math.max(width, height))),
    );
    await variations.getByRole("button", { name: "Close variations" }).click();

    await page.getByRole("button", { name: "Export…" }).click();
    const exportDialog = page.getByRole("dialog", { name: "Export" });
    const screenSize = exportDialog.getByRole("radio", { name: /1024/ });
    await screenSize.focus();
    await screenSize.press("Space");

    const pngFormat = exportDialog.getByRole("radio", { name: "PNG" });
    await pngFormat.focus();
    await pngFormat.press("Space");
    const pngDownloadPromise = page.waitForEvent("download");
    await exportDialog
      .getByRole("button", { name: "Export", exact: true })
      .click();
    const pngDownload = await pngDownloadPromise;
    expect(pngDownload.suggestedFilename()).toContain(`${width}x${height}.png`);
    const pngPath = await pngDownload.path();
    expect(pngPath).not.toBeNull();
    const png = await readFile(pngPath!);
    expect(Array.from(png.subarray(0, 8))).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);

    const svgFormat = exportDialog.getByRole("radio", { name: "SVG" });
    await svgFormat.focus();
    await svgFormat.press("Space");
    const svgDownloadPromise = page.waitForEvent("download");
    await exportDialog
      .getByRole("button", { name: "Export", exact: true })
      .click();
    const svgDownload = await svgDownloadPromise;
    expect(svgDownload.suggestedFilename()).toContain(`${width}x${height}.svg`);
    const svgPath = await svgDownload.path();
    expect(svgPath).not.toBeNull();
    const svg = await readFile(svgPath!, "utf8");
    expect(svg).toContain(`width="${width}" height="${height}"`);
    expect(svg).toContain(
      `${Math.abs(centerLat).toFixed(2)}°${centerLat >= 0 ? "N" : "S"} ${Math.abs(centerLng).toFixed(2)}°${centerLng >= 0 ? "E" : "W"}`,
    );
    await exportDialog
      .getByRole("button", { name: "Close export dialog" })
      .click();

    const beforeRestore = sharedDocument(page.url())!;
    await page.reload();
    await waitForArtwork(page);
    const afterRestore = sharedDocument(page.url())!;
    expect(afterRestore.params.aspectRatio).toBe(aspect);
    for (const key of ["west", "south", "east", "north"] as const) {
      expect(afterRestore.bounds[key]).toBeCloseTo(
        beforeRestore.bounds[key],
        10,
      );
    }
    const frame = await page.getByTestId("export-frame").boundingBox();
    expect(frame).not.toBeNull();
    expect(frame!.width / frame!.height).toBeCloseTo(width / height, 2);
  }
});

test("@smoke custom palettes restore from an empty store and malformed imports are atomic", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Storage and file import journey is covered in Chromium.",
  );
  await startWithoutOrientation(page);
  await page.getByRole("button", { name: "Seed & Palette" }).click();
  await page.getByRole("button", { name: "New palette" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("Incognito Ember");
  await page
    .getByRole("textbox", { name: "Background", exact: true })
    .fill("#102030");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => sharedDocument(page.url())?.customPalette?.name)
    .toBe("Incognito Ember");
  const sharedUrl = page.url();

  await page.evaluate(() => localStorage.clear());
  await page.goto(sharedUrl);
  await waitForArtwork(page);
  const seedPalette = page.getByRole("button", { name: "Seed & Palette" });
  if ((await seedPalette.getAttribute("aria-expanded")) !== "true")
    await seedPalette.click();
  await expect(
    page.getByRole("button", { name: /Incognito Ember custom/i }),
  ).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  const beforeImport = page.url();
  const encoded = new URL(beforeImport).searchParams.get("composition")!;
  const document = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  );
  const malformed = {
    ...document,
    bounds: { west: 5, south: 0, east: -5, north: 1 },
    params: { ...document.params, label: "Must not apply" },
  };
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "malformed.composition.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(malformed)),
  });
  await expect(dialog.getByRole("alert")).toContainText("bounds are invalid");
  expect(page.url()).toBe(beforeImport);
  await expect(page.getByRole("img", { name: /Must not apply/i })).toHaveCount(
    0,
  );

  const valid = {
    ...document,
    params: { ...document.params, label: "Imported Atomically" },
  };
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "valid.composition.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(valid)),
  });
  await expect(dialog.getByRole("status")).toContainText(
    "Imported valid.composition.json",
  );
  await expect
    .poll(() => sharedDocument(page.url())?.params.label)
    .toBe("Imported Atomically");
  await dialog.getByRole("button", { name: "Close export dialog" }).click();
  await expect(
    page.getByRole("img", { name: /Imported Atomically/i }),
  ).toBeVisible();
});
