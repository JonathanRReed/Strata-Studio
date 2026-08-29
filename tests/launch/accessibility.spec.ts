import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

test("@a11y fresh visit has no serious WCAG or contrast violations", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Regenerate now" }),
  ).toBeEnabled({
    timeout: 20_000,
  });

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  const seriousViolations = results.violations.filter(
    (violation) =>
      violation.impact === "critical" || violation.impact === "serious",
  );

  await testInfo.attach("axe-results", {
    body: Buffer.from(JSON.stringify(results, null, 2)),
    contentType: "application/json",
  });
  expect(seriousViolations).toEqual([]);
});

test("@a11y interactive map, export, variations, and mobile sheet have no serious violations", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium",
    "Expanded interactive surfaces are covered in Chromium.",
  );
  await page.addInitScript(() =>
    localStorage.setItem("strata.orientation.dismissed", "1"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Regenerate now" }),
  ).toBeEnabled({
    timeout: 20_000,
  });

  const assertSurface = async (name: string) => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    await testInfo.attach(`axe-${name}`, {
      body: Buffer.from(JSON.stringify(results, null, 2)),
      contentType: "application/json",
    });
    expect(
      results.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  };

  await page.getByRole("button", { name: "Expand map" }).click();
  await expect(
    page.getByRole("dialog", { name: "Choose artwork area" }),
  ).toHaveCSS("opacity", "1");
  await assertSurface("expanded-map");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Variations" }).click();
  await expect(page.getByRole("dialog", { name: "Variations" })).toHaveCSS(
    "opacity",
    "1",
  );
  await assertSurface("variations");
  await page
    .getByRole("dialog", { name: "Variations" })
    .getByRole("button", {
      name: "Close variations",
    })
    .click();

  await page.getByRole("button", { name: "Export…" }).click();
  await expect(page.getByRole("dialog", { name: "Export" })).toHaveCSS(
    "opacity",
    "1",
  );
  await assertSurface("export");
  await page
    .getByRole("dialog", { name: "Export" })
    .getByRole("button", {
      name: "Close export dialog",
    })
    .click();

  await page.setViewportSize({ width: 390, height: 844 });
  const handle = page.locator('button[aria-controls="mobile-sheet-body"]');
  await page.getByRole("button", { name: "Open controls" }).click();
  await page.waitForTimeout(350);
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, 20, { steps: 8 });
  await page.mouse.up();
  await expect(
    page.getByRole("dialog", { name: "Artwork controls" }),
  ).toHaveCSS("opacity", "1");
  await assertSurface("mobile-full-sheet");
});
