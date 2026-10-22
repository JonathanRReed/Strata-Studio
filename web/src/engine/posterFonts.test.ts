import { expect, test } from "bun:test";
import { ensurePosterFonts } from "./posterFonts.ts";

test("font waits are shared but one cancellation does not cancel another export", async () => {
  const original = globalThis.document;
  let release!: (fonts: FontFace[]) => void,
    calls = 0;
  const loaded = new Promise<FontFace[]>((resolve) => {
    release = resolve;
  });
  const fonts = {
    load() {
      calls++;
      return loaded;
    },
    get ready() {
      throw new Error("unrelated document fonts must not block exports");
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { fonts },
  });
  try {
    const controller = new AbortController();
    const first = ensurePosterFonts(controller.signal),
      second = ensurePosterFonts();
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    release([]);
    await second;
    expect(calls).toBe(3);
  } finally {
    release([]);
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: original,
    });
  }
});
test("synchronous font loading failures preserve the documented fallback", async () => {
  const original = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      fonts: {
        load() {
          throw new Error("font unavailable");
        },
      },
    },
  });
  try {
    await ensurePosterFonts();
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: original,
    });
  }
});
