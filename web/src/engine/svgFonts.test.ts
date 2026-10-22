import { test, expect } from "bun:test";
import { embedPosterFonts, type SvgFontManifest } from "./svgFonts.ts";
const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text font-family='"Archivo Variable", sans-serif'>Art</text></svg>`;
const manifest = (url: string): SvgFontManifest => ({
  licenses: ["Copyright & license <text>"],
  faces: [
    {
      family: "Archivo Variable",
      weight: "100 900",
      unicodeRange: "U+0000-00FF",
      url,
    },
  ],
});
const woff = new Uint8Array([119, 79, 70, 50, 0, 0, 0, 0]);
test("SVG embeds cached font bytes and escaped license text without external URLs", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(woff);
  }) as unknown as typeof fetch;
  try {
    const result = await embedPosterFonts(
      svg,
      undefined,
      manifest("/font-test-success.woff2"),
    );
    expect(result).toContain("data:font/woff2;base64,d09GMgAAAAA=");
    expect(result).toContain("Copyright &amp; license &lt;text&gt;");
    expect(result).not.toContain("/font-test-success.woff2");
    await embedPosterFonts(
      svg,
      undefined,
      manifest("/font-test-success.woff2"),
    );
    expect(calls).toBe(1);
    expect(
      await embedPosterFonts(
        result,
        undefined,
        manifest("/font-test-success.woff2"),
      ),
    ).toBe(result);
  } finally {
    globalThis.fetch = original;
  }
});
test("fontless SVG skips downloads and invalid fonts can be retried", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(calls === 1 ? "not a font" : woff);
  }) as unknown as typeof fetch;
  try {
    expect(
      await embedPosterFonts(
        "<svg/>",
        undefined,
        manifest("/font-test-retry.woff2"),
      ),
    ).toBe("<svg/>");
    expect(calls).toBe(0);
    await expect(
      embedPosterFonts(svg, undefined, manifest("/font-test-retry.woff2")),
    ).rejects.toThrow("invalid");
    expect(
      await embedPosterFonts(
        svg,
        undefined,
        manifest("/font-test-retry.woff2"),
      ),
    ).toContain("data:font/woff2");
  } finally {
    globalThis.fetch = original;
  }
});
test("cancelled caller does not cancel shared font loading for another export", async () => {
  const original = globalThis.fetch;
  let resolve!: (value: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((r) => {
      resolve = r;
    })) as unknown as typeof fetch;
  try {
    const controller = new AbortController();
    const first = embedPosterFonts(
      svg,
      controller.signal,
      manifest("/font-test-shared.woff2"),
    );
    const second = embedPosterFonts(
      svg,
      undefined,
      manifest("/font-test-shared.woff2"),
    );
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    resolve(new Response(woff));
    expect(await second).toContain("data:font/woff2");
  } finally {
    globalThis.fetch = original;
  }
});
test("oversized font streams fail before embedding", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(new Uint8Array(256 * 1024 + 1))) as unknown as typeof fetch;
  try {
    await expect(
      embedPosterFonts(svg, undefined, manifest("/font-test-large.woff2")),
    ).rejects.toThrow("size limit");
  } finally {
    globalThis.fetch = original;
  }
});
