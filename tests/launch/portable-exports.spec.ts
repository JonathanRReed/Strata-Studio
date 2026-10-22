import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";

async function prepareAnimation(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Regenerate now" }),
  ).toBeEnabled({ timeout: 20_000 });
  const section = page.getByRole("button", { name: /^Animation/ });
  if ((await section.getAttribute("aria-expanded")) === "false")
    await section.click();
  await page
    .getByRole("combobox", { name: "Animation style", exact: true })
    .selectOption("draw");
  const speed = Number(
    await page
      .getByRole("slider", { name: "Animation speed", exact: true })
      .inputValue(),
  );
  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  await dialog.getByRole("radio", { name: "Animation", exact: true }).press("Space");
  await dialog.getByRole("radio", { name: /APNG/ }).press("Space");
  return { dialog, speed };
}
test("@smoke APNG worker downloads a complete animation at preview speed", async ({
  page,
  pageErrors,
}) => {
  test.setTimeout(60_000);
  const { dialog, speed } = await prepareAnimation(page);
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const download = await Promise.race([
    downloadPromise,
    dialog.getByRole("alert").waitFor({ state: "visible" }).then(async () => {
      throw new Error(`APNG export failed: ${await dialog.getByRole("alert").innerText()}`);
    }),
  ]),
    path = await download.path();
  if (!path) throw new Error("APNG download missing");
  const bytes = await readFile(path);
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8,
    frames = 0,
    totalMs = 0,
    last = "";
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    expect(offset + 12 + length).toBeLessThanOrEqual(bytes.length);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    last = type;
    if (type === "acTL") expect(bytes.readUInt32BE(offset + 8)).toBe(24);
    if (type === "fcTL") {
      frames++;
      totalMs +=
        (1000 * bytes.readUInt16BE(offset + 28)) /
        bytes.readUInt16BE(offset + 30);
    }
    offset += 12 + length;
  }
  expect(frames).toBe(24);
  expect(last).toBe("IEND");
  expect(offset).toBe(bytes.length);
  expect(totalMs).toBeCloseTo(Math.round(1000 / speed), 0);
  expect(pageErrors).toEqual([]);
});
test("@smoke Cancel terminates APNG encoding even when its worker stalls", async ({
  page,
  pageErrors,
}) => {
  test.setTimeout(60_000);
  let interceptedWorker = false;
  await page.route("**/assets/apng.worker-*.js", (route) => {
    interceptedWorker = true;
    return route.fulfill({
      contentType: "text/javascript",
      body: "self.onmessage = () => {};",
    });
  });
  const { dialog } = await prepareAnimation(page);
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog.getByText("Encoding APNG…", { exact: true })).toBeVisible(
    { timeout: 40_000 },
  );
  await expect.poll(() => interceptedWorker).toBe(true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Export", exact: true }),
  ).toBeEnabled({ timeout: 2000 });
  expect(pageErrors).toEqual([]);
});
test("@smoke poster SVG carries its licensed fonts for standalone viewing", async ({
  page,
  pageErrors,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Regenerate now" }),
  ).toBeEnabled({ timeout: 20_000 });
  const composition = page.getByRole("button", { name: /^Composition/ });
  if ((await composition.getAttribute("aria-expanded")) === "false")
    await composition.click();
  await page
    .getByRole("textbox", { name: "Label", exact: true })
    .fill("Golden Gate");
  await page.getByRole("radio", { name: "Poster", exact: true }).press("Space");
  await page.getByRole("button", { name: "Export…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  await dialog.getByRole("radio", { name: "SVG", exact: true }).press("Space");
  await dialog.getByRole("radio", { name: /1024/ }).press("Space");
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  const download = await pending,
    path = await download.path();
  if (!path) throw new Error("SVG download missing");
  const svg = await readFile(path, "utf8");
  expect(svg.match(/data:font\/woff2;base64,/g)).toHaveLength(4);
  expect(svg).toContain("SIL OPEN FONT LICENSE");
  expect(svg).toContain("strata-font-licenses");
  const parsed = await page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    return {
      errors: doc.querySelectorAll("parsererror").length,
      fonts: doc.querySelector("style")?.textContent,
    };
  }, svg);
  expect(parsed.errors).toBe(0);
  expect(parsed.fonts).toContain("Archivo Variable");
  expect(parsed.fonts).toContain("IBM Plex Mono");
  // A fresh SVG document must load its own embedded faces. The app's loaded
  // CSS/fonts cannot make this check pass for broken standalone font data.
  const standaloneUrl = await page.evaluate(
    (source) =>
      URL.createObjectURL(new Blob([source], { type: "image/svg+xml" })),
    svg,
  );
  const standalone = await page.context().newPage();
  try {
    await standalone.goto(standaloneUrl);
    const loaded = await standalone.evaluate(async () => {
      const title = await document.fonts.load(
        '650 48px "Archivo Variable"',
        "Golden Gate",
      );
      const meta = await document.fonts.load(
        '400 12px "IBM Plex Mono"',
        "40.7565 N",
      );
      return [title, meta].map((faces) => ({
        count: faces.length,
        loaded: faces.every((face) => face.status === "loaded"),
      }));
    });
    for (const face of loaded) {
      expect(face.count).toBeGreaterThan(0);
      expect(face.loaded).toBe(true);
    }
  } finally {
    await standalone.close();
    await page.evaluate((url) => URL.revokeObjectURL(url), standaloneUrl);
  }
  expect(pageErrors).toEqual([]);
});
