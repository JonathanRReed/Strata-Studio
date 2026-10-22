import { test, expect } from "bun:test";
import { encodeApngFrames, type ApngRequest } from "./apngWorker.ts";
// @ts-expect-error upng-js does not publish TypeScript declarations.
import UPNG from "upng-js";
const frame = (value = 255) =>
  ({
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      value,
      0,
      0,
      255,
      0,
      0,
      0,
      0,
      0,
      255,
      0,
      255,
      0,
      0,
      255,
      255,
    ]),
  }) as ImageData;
class FakeWorker extends EventTarget {
  terminated = 0;
  request?: ApngRequest;
  transfer?: Transferable[];
  postMessage(request: ApngRequest, transfer: Transferable[]) {
    this.request = request;
    this.transfer = transfer;
  }
  terminate() {
    this.terminated++;
  }
  reply(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
test("APNG transfers exact buffers, preserves cumulative timing, and terminates on success", async () => {
  const worker = new FakeWorker(),
    a = frame(),
    b = frame(127);
  const promise = encodeApngFrames([a, b], 24, {
    createWorker: () => worker as unknown as Worker,
  });
  expect(worker.transfer).toEqual([a.data.buffer, b.data.buffer]);
  expect(worker.request?.delays).toEqual([42, 41]);
  worker.reply({
    ok: true,
    png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
  });
  expect((await promise).byteLength).toBe(8);
  expect(worker.terminated).toBe(1);
});
test("APNG cancellation and timeout terminate hung encoding", async () => {
  const worker = new FakeWorker(),
    controller = new AbortController();
  const promise = encodeApngFrames([frame()], 24, {
    signal: controller.signal,
    createWorker: () => worker as unknown as Worker,
  });
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  expect(worker.terminated).toBe(1);
  const timed = new FakeWorker();
  await expect(
    encodeApngFrames([frame()], 24, {
      timeoutMs: 5,
      createWorker: () => timed as unknown as Worker,
    }),
  ).rejects.toThrow("timed out");
  expect(timed.terminated).toBe(1);
});
test("APNG worker failure and malformed replies clean up", async () => {
  for (const event of ["error", "messageerror", "badreply", "postfailure"]) {
    const worker = new FakeWorker();
    if (event === "postfailure")
      worker.postMessage = () => {
        throw new Error("post failed");
      };
    const promise = encodeApngFrames([frame()], 24, {
      createWorker: () => worker as unknown as Worker,
    });
    if (event === "badreply") worker.reply({ ok: true, png: "not a buffer" });
    else if (event !== "postfailure") worker.dispatchEvent(new Event(event));
    await expect(promise).rejects.toThrow();
    expect(worker.terminated).toBe(1);
  }
});
test("APNG checks cancellation and malformed frames before creating a worker", async () => {
  let created = false;
  const createWorker = () => {
    created = true;
    return new FakeWorker() as unknown as Worker;
  };
  await expect(encodeApngFrames([], 24, { createWorker })).rejects.toThrow(
    "Invalid",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    encodeApngFrames([frame()], 24, {
      signal: controller.signal,
      createWorker,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(created).toBe(false);
});
test("real APNG worker preserves frame pixels, transparency and timing", async () => {
  const frames = [frame(), frame(127)],
    expected = frames.map((f) => Array.from(f.data));
  const png = await encodeApngFrames(frames, 24);
  const decoded = UPNG.decode(png);
  expect(decoded.width).toBe(2);
  expect(decoded.height).toBe(2);
  expect(decoded.frames.map((f: { delay: number }) => f.delay)).toEqual([
    42, 41,
  ]);
  expect(
    UPNG.toRGBA8(decoded).map((f: ArrayBuffer) =>
      Array.from(new Uint8Array(f)),
    ),
  ).toEqual(expected);
  expect(frames[0].data.byteLength).toBe(0);
});
test("incompressible APNG container has complete chunks and round-trips every pixel", async () => {
  let state = 123456;
  const frames = Array.from({ length: 4 }, () => {
    const data = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < data.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      data[i] = i % 4 === 3 ? 1 + ((state >>> 24) % 255) : state >>> 24;
    }
    return { width: 32, height: 32, data } as ImageData;
  });
  const expected = frames.map((f) => Array.from(f.data));
  const png = await encodeApngFrames(frames, 24),
    bytes = new Uint8Array(png),
    view = new DataView(png);
  expect(png.byteLength).toBeGreaterThan(32 * 32 * 4 * 4 + 100);
  let offset = 8;
  const types: string[] = [];
  while (offset < png.byteLength) {
    const length = view.getUint32(offset),
      end = offset + 12 + length;
    expect(end).toBeLessThanOrEqual(png.byteLength);
    types.push(String.fromCharCode(...bytes.slice(offset + 4, offset + 8)));
    let crc = 0xffffffff;
    for (let i = offset + 4; i < offset + 8 + length; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    expect(view.getUint32(offset + 8 + length)).toBe((crc ^ 0xffffffff) >>> 0);
    offset = end;
  }
  expect(types.filter((t) => t === "fcTL")).toHaveLength(4);
  expect(types.at(-1)).toBe("IEND");
  expect(offset).toBe(png.byteLength);
  expect(
    UPNG.toRGBA8(UPNG.decode(png)).map((f: ArrayBuffer) =>
      Array.from(new Uint8Array(f)),
    ),
  ).toEqual(expected);
});
