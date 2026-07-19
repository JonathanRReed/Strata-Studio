import { describe, expect, test } from "bun:test";
import type { GeoBounds } from "../engine/types.ts";
import {
  claimInitialGeneration,
  mapSelectionAcknowledgesFlyTo,
  reconcileMapSelection,
  resolveBootSelection,
} from "./bootSelection.ts";
import { validateGeoBounds } from "./stateSafety.ts";

const EXACT_BOUNDS: GeoBounds = {
  west: -122.51234,
  south: 37.70123,
  east: -122.35678,
  north: 37.85001,
};

describe("map-independent boot selection", () => {
  test("preserves exact validated share bounds", () => {
    const selection = resolveBootSelection(
      { bounds: EXACT_BOUNDS, center: [-122.4, 37.77], zoom: 12 },
      null,
    );
    expect(selection.bounds).toBe(EXACT_BOUNDS);
    expect(selection.center[0]).toBeCloseTo(-122.4, 12);
    expect(selection.center[1]).toBe(37.77);
    expect(selection.zoom).toBe(12);
  });

  test("deterministically derives valid bounds from legacy center/zoom", () => {
    const input = { bounds: null, center: [7.66, 45.98] as [number, number], zoom: 11 };
    const first = resolveBootSelection(input, null);
    const second = resolveBootSelection(input, null);
    expect(first).toEqual(second);
    expect(validateGeoBounds(first.bounds)).toEqual(first.bounds);
  });

  test("uses curated geography without requiring a map", () => {
    const selection = resolveBootSelection(
      { bounds: null, center: null, zoom: null },
      { center: [138.73, 35.36], zoom: 10.5 },
    );
    expect(selection.center[0]).toBeCloseTo(138.73, 12);
    expect(selection.center[1]).toBe(35.36);
    expect(selection.zoom).toBe(10.5);
    expect(validateGeoBounds(selection.bounds)).toEqual(selection.bounds);
  });
});

describe("initial generation and map synchronization", () => {
  test("claims mount generation once across StrictMode effect replay", () => {
    const started = { current: false };
    expect(claimInitialGeneration(started)).toBe(true);
    expect(claimInitialGeneration(started)).toBe(false);
  });

  test("marks an equal floating-point boot echo unchanged", () => {
    const echo = {
      west: EXACT_BOUNDS.west + 0.000001,
      south: EXACT_BOUNDS.south - 0.000001,
      east: EXACT_BOUNDS.east - 0.000001,
      north: EXACT_BOUNDS.north + 0.000001,
    };
    expect(reconcileMapSelection(EXACT_BOUNDS, echo, 12.01, 11)).toEqual({
      bounds: echo,
      zoom: 12.01,
      changed: false,
    });
  });

  test("acknowledges only the report that lands at the requested fly-to", () => {
    const request = { center: [-73.97, 40.76] as [number, number], zoom: 13 };
    expect(
      mapSelectionAcknowledgesFlyTo(
        { bounds: EXACT_BOUNDS, zoom: 12 },
        request,
      ),
    ).toBe(false);
    expect(
      mapSelectionAcknowledgesFlyTo(
        {
          bounds: { west: -73.98, south: 40.75, east: -73.96, north: 40.77 },
          zoom: 13.01,
        },
        request,
      ),
    ).toBe(true);
  });

  test("acknowledges exact restored bounds at a viewport-derived zoom", () => {
    const request = {
      center: [-122.4, 37.77] as [number, number],
      zoom: 12,
      bounds: EXACT_BOUNDS,
    };
    expect(
      mapSelectionAcknowledgesFlyTo(
        { bounds: { ...EXACT_BOUNDS }, zoom: 9.25 },
        request,
      ),
    ).toBe(true);
  });

  test("accepts a genuinely moved selection and rejects invalid reports", () => {
    const moved = { ...EXACT_BOUNDS, west: EXACT_BOUNDS.west + 0.01 };
    expect(reconcileMapSelection(EXACT_BOUNDS, moved, 99, 11)).toEqual({
      bounds: moved,
      zoom: 22,
      changed: true,
    });
    expect(
      reconcileMapSelection(
        EXACT_BOUNDS,
        { ...EXACT_BOUNDS, north: 90 },
        12,
        11,
      ),
    ).toBeNull();
  });
});
