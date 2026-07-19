import { describe, expect, it } from "bun:test";
import { act, create } from "react-test-renderer";
import { useNominatimSearch } from "./useNominatimSearch.ts";
import type { GeocodeOutcome, NominatimSearchResult } from "../data/geocode.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Hook = ReturnType<typeof useNominatimSearch>;
type Searcher = (
  query: string,
  signal?: AbortSignal,
) => Promise<GeocodeOutcome<NominatimSearchResult>>;

function Probe({ searcher, expose }: { searcher: Searcher; expose: (hook: Hook) => void }) {
  const hook = useNominatimSearch({ onResult: () => undefined, searcher });
  expose(hook);
  return null;
}

describe("persistent Nominatim search states", () => {
  it("keeps no-results errors until retry, edit, or dismissal", async () => {
    let attempts = 0;
    const searcher: Searcher = async () => {
      attempts++;
      return attempts === 1
        ? { status: "no-results", cached: false }
        : {
            status: "success",
            cached: false,
            value: { lat: 1, lng: 2, displayName: "Found" },
          };
    };
    let hook: Hook | null = null;
    await act(async () => {
      create(<Probe searcher={searcher} expose={(value) => { hook = value; }} />);
    });
    await act(async () => {
      await hook!.search("missing");
    });
    expect(hook!.state).toMatchObject({ phase: "error", kind: "no-results" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook!.state.phase).toBe("error");

    await act(async () => {
      hook!.retry();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook!.state).toMatchObject({ phase: "success", message: "Found" });

    act(() => hook!.edited());
    expect(hook!.state).toEqual({ phase: "idle" });
    act(() => hook!.dismiss());
    expect(hook!.state).toEqual({ phase: "idle" });
  });

  it("reports explicit rate-limited and cancelled states", async () => {
    const outcomes: GeocodeOutcome<NominatimSearchResult>[] = [
      { status: "rate-limited", message: "Rate limited" },
    ];
    let hook: Hook | null = null;
    await act(async () => {
      create(
        <Probe
          searcher={async () => outcomes.shift() ?? { status: "cancelled" }}
          expose={(value) => { hook = value; }}
        />,
      );
    });
    await act(async () => {
      await hook!.search("place");
    });
    expect(hook!.state).toMatchObject({ phase: "error", kind: "rate-limited" });
    act(() => hook!.cancel());
    expect(hook!.state).toMatchObject({ phase: "error", kind: "cancelled" });
  });
});
