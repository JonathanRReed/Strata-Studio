import { describe, expect, test } from "bun:test";
import { attachSubscriber, type SharedLoad } from "./terrainTiles.ts";

function makeShared<T>(): SharedLoad<T> & {
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  const controller = new AbortController();
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, controller, subscribers: 0, resolve, reject };
}

describe("attachSubscriber (shared tile loads)", () => {
  test("an aborted subscriber does not poison the survivor (regression)", async () => {
    const shared = makeShared<string>();
    const first = new AbortController();
    const second = new AbortController();
    const p1 = attachSubscriber(shared, first.signal);
    const p2 = attachSubscriber(shared, second.signal);

    first.abort();
    await expect(p1).rejects.toThrow("Aborted");
    expect(shared.controller.signal.aborted).toBe(false);

    shared.resolve("tile-data");
    await expect(p2).resolves.toBe("tile-data");
  });

  test("the shared fetch aborts only when the last subscriber leaves", async () => {
    const shared = makeShared<string>();
    const a = new AbortController();
    const b = new AbortController();
    const pa = attachSubscriber(shared, a.signal);
    const pb = attachSubscriber(shared, b.signal);

    a.abort();
    expect(shared.controller.signal.aborted).toBe(false);
    b.abort();
    expect(shared.controller.signal.aborted).toBe(true);
    await expect(pa).rejects.toThrow("Aborted");
    await expect(pb).rejects.toThrow("Aborted");
  });

  test("signal-less subscribers pin the shared fetch alive", async () => {
    const shared = makeShared<string>();
    const withSignal = new AbortController();
    const p1 = attachSubscriber(shared, withSignal.signal);
    const p2 = attachSubscriber(shared); // no signal — cannot abort

    withSignal.abort();
    await expect(p1).rejects.toThrow("Aborted");
    expect(shared.controller.signal.aborted).toBe(false);

    shared.resolve("tile-data");
    await expect(p2).resolves.toBe("tile-data");
  });

  test("upstream failures still propagate to live subscribers", async () => {
    const shared = makeShared<string>();
    const sub = new AbortController();
    const p = attachSubscriber(shared, sub.signal);
    shared.reject(new Error("HTTP 500"));
    await expect(p).rejects.toThrow("HTTP 500");
  });

  test("an already-aborted signal rejects immediately", async () => {
    const shared = makeShared<string>();
    const dead = new AbortController();
    dead.abort();
    await expect(attachSubscriber(shared, dead.signal)).rejects.toThrow("Aborted");
  });
});
