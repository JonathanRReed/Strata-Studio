import { expect, test } from "bun:test";
import { pngBlobWithAttribution, downloadSvgWithAttribution } from "./export";

for (const [background, ink, halo] of [["#000000", "#ffffff", "#000000"], ["#ffffff", "#000000", "#ffffff"]]) {
  test(`PNG attribution has opaque contrasting ink and a scaled halo on ${background}`, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    const calls: string[] = [];
    const ctx = {
      save() {}, restore() {}, setTransform() {},
      fillStyle: "", strokeStyle: "", lineWidth: 0, lineJoin: "", font: "", textAlign: "",
      drawImage: () => calls.push("artwork"), measureText: () => ({ width: 100 }),
      strokeText: () => calls.push("halo"), fillText: () => calls.push("ink"),
    };
    const copy = { width: 0, height: 0, getContext: () => ctx,
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["png"])),
    };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => copy } });
    try {
      await pngBlobWithAttribution({ width: 2048, height: 2048 } as HTMLCanvasElement, "Map data © OpenStreetMap contributors", background, 4);
      expect(calls).toEqual(["artwork", "halo", "ink"]);
      expect(ctx.fillStyle).toBe(ink); expect(ctx.strokeStyle).toBe(halo);
      expect(ctx.lineWidth).toBe(8); expect(ctx.lineJoin).toBe("round");
    } finally {
      if (previous) Object.defineProperty(globalThis, "document", previous);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });
}

test("SVG attribution retains escaped metadata and paints its halo before opaque text", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const original = URL.createObjectURL;
  let captured: Blob | undefined;
  URL.createObjectURL = (blob) => { if (blob instanceof Blob) captured = blob; return original(blob); };
  const anchor = { click() {}, remove() {}, href: "", download: "" };
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (tag: string) => tag === "a" ? anchor : { getContext: () => ({ measureText: () => ({ width: 100 }) }) },
    body: { appendChild() {} },
  } });
  try {
    const receipt = downloadSvgWithAttribution('<svg width="2048" height="2048" viewBox="0 0 512 512"><path d="M0 0L512 512"/></svg>', "art.svg", "OSM & terrain", "#000000");
    receipt.dispose();
    const svg = await captured!.text();
    expect(svg).toContain('<metadata>OSM &amp; terrain</metadata>');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('stroke="#000000"');
    expect(svg).toContain('paint-order="stroke fill"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg).toContain('x="504" y="504"');
  } finally {
    URL.createObjectURL = original;
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
