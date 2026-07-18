import { describe, expect, test } from "bun:test";
import { create, act, type ReactTestRenderer } from "react-test-renderer";
import type { ElevationGrid, GeoBounds } from "../engine/types.ts";
import { coordinateLabel } from "./autoLabel.ts";
import { useAutoLabel } from "./useAutoLabel.ts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function grid(bounds: GeoBounds): ElevationGrid {
  return { width: 1, height: 1, bounds, data: new Float32Array([0]) };
}

const A: GeoBounds = { west: 0, south: 0, east: 2, north: 2 };
const B: GeoBounds = { west: 20, south: 20, east: 22, north: 22 };

type HookValue = ReturnType<typeof useAutoLabel>;
type Geocoder = NonNullable<Parameters<typeof useAutoLabel>[0]["reverseGeocode"]>;

function Probe({
  terrain,
  label,
  geocoder,
  onLabel,
  expose,
}: {
  terrain: ElevationGrid | null;
  label: string;
  geocoder: Geocoder;
  onLabel: (name: string) => void;
  expose: (value: HookValue) => void;
}) {
  expose(
    useAutoLabel({
      grid: terrain,
      label,
      onAutoLabel: onLabel,
      reverseGeocode: geocoder,
    }),
  );
  return null;
}

describe("useAutoLabel races and provenance", () => {
  test("ignores an old reverse-geocode completion after the center changes", async () => {
    const pending: ReturnType<typeof deferred<string | null>>[] = [];
    const signals: AbortSignal[] = [];
    const geocoder: Geocoder = (_lat, _lng, signal) => {
      const request = deferred<string | null>();
      pending.push(request);
      signals.push(signal!);
      return request.promise;
    };
    const labels: string[] = [];
    let hook: HookValue | null = null;
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <Probe terrain={grid(A)} label="" geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={(value) => { hook = value; }} />,
      );
    });
    expect(hook).not.toBeNull();
    expect(pending).toHaveLength(1);

    await act(async () => {
      renderer.update(
        <Probe terrain={grid(B)} label="" geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={(value) => { hook = value; }} />,
      );
    });
    expect(signals[0].aborted).toBe(true);
    expect(pending).toHaveLength(2);

    await act(async () => {
      pending[0].resolve("Old Place");
      await pending[0].promise;
    });
    expect(labels).toEqual([]);

    await act(async () => {
      pending[1].resolve("New Place");
      await pending[1].promise;
    });
    expect(labels).toEqual(["New Place"]);
    act(() => renderer.unmount());
  });

  test("aborts a pending request when the user authors a label", async () => {
    const request = deferred<string | null>();
    let signal: AbortSignal | undefined;
    const geocoder: Geocoder = (_lat, _lng, nextSignal) => {
      signal = nextSignal;
      return request.promise;
    };
    const labels: string[] = [];
    const terrain = grid(A);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <Probe terrain={terrain} label="" geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={() => undefined} />,
      );
    });
    await act(async () => {
      renderer.update(
        <Probe terrain={terrain} label="My authored title" geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={() => undefined} />,
      );
    });
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      request.resolve("Late Place");
      await request.promise;
    });
    expect(labels).toEqual([]);
    act(() => renderer.unmount());
  });

  test("applies curated names immediately but preserves user-authored text", async () => {
    const geocoder: Geocoder = async () => null;
    const labels: string[] = [];
    let hook!: HookValue;
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <Probe terrain={null} label="" geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={(value) => { hook = value; }} />,
      );
    });
    act(() => hook.applyCuratedName("Yosemite Valley", [1, 1]));
    expect(labels).toEqual(["Yosemite Valley"]);

    await act(async () => {
      renderer.update(
        <Probe terrain={null} label="My title" geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={(value) => { hook = value; }} />,
      );
    });
    act(() => hook.applyCuratedName("Manhattan", [-73.97, 40.76]));
    expect(labels).toEqual(["Yosemite Valley"]);
    act(() => renderer.unmount());
  });

  test("does not leak an unconsumed curated marker into an unrelated settle", async () => {
    const labels: string[] = [];
    const geocoder: Geocoder = async () => "Actual Place";
    let hook!: HookValue;
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <Probe terrain={null} label="" geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={(value) => { hook = value; }} />,
      );
    });
    act(() => hook.applyCuratedName("Yosemite Valley", [1, 1]));
    await act(async () => {
      renderer.update(
        <Probe terrain={grid(B)} label="Yosemite Valley" geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={(value) => { hook = value; }} />,
      );
      await Promise.resolve();
    });
    expect(labels).toEqual(["Yosemite Valley", "Actual Place"]);
    act(() => renderer.unmount());
  });

  test("retries the same center after a transient reverse-geocode failure", async () => {
    const requests: ReturnType<typeof deferred<string | null>>[] = [];
    const geocoder: Geocoder = () => {
      const request = deferred<string | null>();
      requests.push(request);
      return request.promise;
    };
    const labels: string[] = [];
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <Probe terrain={grid(A)} label="" geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={() => undefined} />,
      );
    });
    await act(async () => {
      requests[0].reject(new Error("temporary outage"));
      await requests[0].promise.catch(() => undefined);
    });
    const fallback = coordinateLabel(1, 1);
    expect(labels).toEqual([fallback]);

    await act(async () => {
      renderer.update(
        <Probe terrain={null} label={fallback} geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={() => undefined} />,
      );
      renderer.update(
        <Probe terrain={grid(A)} label={fallback} geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={() => undefined} />,
      );
    });
    expect(requests).toHaveLength(2);
    await act(async () => {
      requests[1].resolve("Recovered Place");
      await requests[1].promise;
    });
    expect(labels).toEqual([fallback, "Recovered Place"]);
    act(() => renderer.unmount());
  });

  test("uses and session-caches a coordinate fallback for negative results", async () => {
    const requests: ReturnType<typeof deferred<string | null>>[] = [];
    const geocoder: Geocoder = () => {
      const request = deferred<string | null>();
      requests.push(request);
      return request.promise;
    };
    const labels: string[] = [];
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <Probe terrain={grid(A)} label="" geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={() => undefined} />,
      );
    });
    await act(async () => {
      requests[0].resolve(null);
      await requests[0].promise;
    });
    expect(labels).toEqual([coordinateLabel(1, 1)]);

    await act(async () => {
      renderer.update(
        <Probe terrain={null} label={labels[0]} geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={() => undefined} />,
      );
      renderer.update(
        <Probe terrain={grid(A)} label={labels[0]} geocoder={geocoder} onLabel={(name) => labels.push(name)} expose={() => undefined} />,
      );
    });
    expect(requests).toHaveLength(1);
    act(() => renderer.unmount());
  });
});
