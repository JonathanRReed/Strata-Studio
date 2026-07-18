import { afterEach, describe, expect, it } from "bun:test";
import {
  canvasToPngBlob,
  startBlobDownload,
  withPngDpi,
} from "./export.ts";

const originalDocument = globalThis.document;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("awaitable export primitives", () => {
  it("rejects when canvas.toBlob returns null", async () => {
    const canvas = {
      toBlob(callback: BlobCallback) {
        callback(null);
      },
    } as HTMLCanvasElement;
    await expect(canvasToPngBlob(canvas)).rejects.toThrow("Canvas returned no PNG data");
  });

  it("cancels a pending toBlob operation and ignores its late callback", async () => {
    let callback: BlobCallback = () => undefined;
    const canvas = {
      toBlob(next: BlobCallback) {
        callback = next;
      },
    } as HTMLCanvasElement;
    const controller = new AbortController();
    const pending = canvasToPngBlob(canvas, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    callback?.(new Blob(["late"], { type: "image/png" }));
  });

  it("propagates DPI byte-read failures", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    Object.defineProperty(blob, "arrayBuffer", {
      value: () => Promise.reject(new Error("DPI read failed")),
    });
    await expect(withPngDpi(blob, 300)).rejects.toThrow("DPI read failed");
  });

  it("revokes object URLs on disposal and propagates click failures", () => {
    const revoked: string[] = [];
    let shouldThrow = false;
    const link = {
      download: "",
      href: "",
      click: () => {
        if (shouldThrow) throw new Error("download blocked");
      },
      remove: () => undefined,
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => link,
        body: { appendChild: () => undefined },
      },
    });
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = (url) => revoked.push(url);

    const receipt = startBlobDownload(new Blob(["ok"], { type: "text/plain" }), "ok.txt");
    expect(receipt.filename).toBe("ok.txt");
    receipt.dispose();
    expect(revoked).toEqual(["blob:test"]);

    shouldThrow = true;
    expect(() => startBlobDownload(new Blob(["bad"]), "bad.txt")).toThrow("download blocked");
    expect(revoked).toEqual(["blob:test", "blob:test"]);
  });
});
