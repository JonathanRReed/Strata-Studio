import { describe, expect, test } from "bun:test";
import { create, act, type ReactTestRenderer } from "react-test-renderer";
import type { GeoBounds, GeoFeatureCollection } from "../engine/types.ts";
import {
  OSM_MEMORY_ENTRY_LIMIT,
  useOsmFeatures,
} from "./useOsmFeatures.ts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const A: GeoBounds = { west: 0, south: 0, east: 0.01, north: 0.01 };
const B: GeoBounds = { west: 1, south: 1, east: 1.01, north: 1.01 };
const FEATURES: GeoFeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [0.005, 0.005] },
      properties: { strataType: "building" },
    },
  ],
};

type HookValue = ReturnType<typeof useOsmFeatures>;
type Fetcher = NonNullable<Parameters<typeof useOsmFeatures>[0]["fetcher"]>;

function Probe({
  bounds,
  fetcher,
  expose,
}: {
  bounds: GeoBounds;
  fetcher: Fetcher;
  expose: (value: HookValue) => void;
}) {
  expose(useOsmFeatures({ bounds, fetcher }));
  return null;
}

describe("useOsmFeatures active-key ownership", () => {
  test("detaches loaded masks and summary immediately, then reuses them on return", async () => {
    const request = deferred<GeoFeatureCollection>();
    const fetcher: Fetcher = () => request.promise;
    let hook!: HookValue;
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<Probe bounds={A} fetcher={fetcher} expose={(value) => { hook = value; }} />);
    });
    let fetchPromise!: Promise<void>;
    act(() => {
      fetchPromise = hook.fetchFeatures();
    });
    await act(async () => {
      request.resolve(FEATURES);
      await fetchPromise;
    });
    expect(hook.features).toBe(FEATURES);
    expect(hook.featureInfo).toContain("Loaded 1 buildings");
    expect(hook.status.phase).toBe("done");

    await act(async () => {
      renderer.update(<Probe bounds={B} fetcher={fetcher} expose={(value) => { hook = value; }} />);
    });
    expect(hook.features).toBeUndefined();
    expect(hook.featureInfo).toBeNull();
    expect(hook.status.phase).toBe("idle");

    await act(async () => {
      renderer.update(<Probe bounds={A} fetcher={fetcher} expose={(value) => { hook = value; }} />);
    });
    expect(hook.features).toBe(FEATURES);
    expect(hook.featureInfo).toContain("Loaded 1 buildings");
    act(() => renderer.unmount());
  });

  test("bounds the in-memory feature cache and refetches an evicted key", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls++;
      return FEATURES;
    };
    const boundsFor = (index: number): GeoBounds => ({
      west: index,
      south: index,
      east: index + 0.01,
      north: index + 0.01,
    });
    let hook!: HookValue;
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <Probe bounds={boundsFor(0)} fetcher={fetcher} expose={(value) => { hook = value; }} />,
      );
    });
    for (let index = 0; index <= OSM_MEMORY_ENTRY_LIMIT; index++) {
      if (index > 0) {
        await act(async () => {
          renderer.update(
            <Probe bounds={boundsFor(index)} fetcher={fetcher} expose={(value) => { hook = value; }} />,
          );
        });
      }
      await act(async () => {
        await hook.fetchFeatures();
      });
    }
    expect(calls).toBe(OSM_MEMORY_ENTRY_LIMIT + 1);

    await act(async () => {
      renderer.update(
        <Probe bounds={boundsFor(0)} fetcher={fetcher} expose={(value) => { hook = value; }} />,
      );
    });
    expect(hook.features).toBeUndefined();
    await act(async () => {
      await hook.fetchFeatures();
    });
    expect(calls).toBe(OSM_MEMORY_ENTRY_LIMIT + 2);
    act(() => renderer.unmount());
  });

  test("aborts an old key and never exposes its late completion on the active key", async () => {
    const requests: Array<{
      deferred: ReturnType<typeof deferred<GeoFeatureCollection>>;
      signal?: AbortSignal;
    }> = [];
    const fetcher: Fetcher = (_bounds, signal) => {
      const next = deferred<GeoFeatureCollection>();
      requests.push({ deferred: next, signal });
      return next.promise;
    };
    let hook!: HookValue;
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<Probe bounds={A} fetcher={fetcher} expose={(value) => { hook = value; }} />);
    });
    let oldFetch!: Promise<void>;
    act(() => {
      oldFetch = hook.fetchFeatures();
    });
    expect(hook.status.phase).toBe("fetching");

    await act(async () => {
      renderer.update(<Probe bounds={B} fetcher={fetcher} expose={(value) => { hook = value; }} />);
    });
    expect(requests[0].signal?.aborted).toBe(true);
    expect(hook.features).toBeUndefined();
    expect(hook.status.phase).toBe("idle");

    await act(async () => {
      requests[0].deferred.resolve(FEATURES);
      await oldFetch;
    });
    expect(hook.features).toBeUndefined();
    expect(hook.featureInfo).toBeNull();
    expect(hook.status.phase).toBe("idle");
    act(() => renderer.unmount());
  });
});
