import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, test } from "bun:test";
import { NoMapFallback } from "./NoMapFallback.tsx";
import type { MapSelectionProps } from "./mapSelectionTypes.ts";
import { reconcileMapSelection } from "../app/bootSelection.ts";
import { CURATED_PLACES } from "../data/places.ts";
import { bboxAreaKm2, isBboxSmallEnough } from "../data/osmOverpass.ts";
import { deriveSelectionBounds, getMercatorBoundsCenter, zoomSelectionBounds, validateGeoBounds } from "../app/stateSafety.ts";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mountAt(center: [number, number], zoom: number, restoredBounds = deriveSelectionBounds(center, zoom, "square")) {
  let props: MapSelectionProps;
  let renderer!: ReactTestRenderer;
  let generations = 0;
  props = {
    aspectRatio: "square", bounds: restoredBounds, zoom,
    expanded: true, onToggleExpand: () => {},
    onChange: (bounds, nextZoom, cause) => {
      const selection = reconcileMapSelection(props.bounds, bounds, nextZoom, props.zoom, cause);
      expect(selection).not.toBeNull();
      if (!selection) return;
      props = { ...props, zoom: selection.zoom };
      if (selection.changed) {
        props = { ...props, bounds: selection.bounds };
        generations++;
      }
      renderer.update(<NoMapFallback {...props} />);
    },
  };
  act(() => { renderer = create(<NoMapFallback {...props} />); });
  return {
    renderer,
    props: () => props,
    generations: () => generations,
    report: (bounds: MapSelectionProps["bounds"], nextZoom: number, cause: Parameters<MapSelectionProps["onChange"]>[2]) => act(() => props.onChange(bounds, nextZoom, cause)),
    zoom: (name: "Zoom in" | "Zoom out") => act(() => {
      renderer.root.findByProps({ "aria-label": name }).props.onClick();
    }),
  };
}

describe("map fallback zoom recovery", () => {
  test("Yosemite square starts over the download limit and zoom-in recovers without WebGL", () => {
    const place = CURATED_PLACES.find((p) => p.id === "yosemite")!;
    const view = mountAt(place.center, place.zoom);
    expect(bboxAreaKm2(view.props().bounds)).toBeGreaterThan(25);
    view.zoom("Zoom in");
    expect(view.props().zoom).toBe(12);
    expect(isBboxSmallEnough(view.props().bounds)).toBe(true);
    const center = getMercatorBoundsCenter(view.props().bounds);
    expect(center[0]).toBeCloseTo(place.center[0], 8);
    expect(center[1]).toBeCloseTo(place.center[1], 8);
    act(() => view.renderer.unmount());
  });

  test("every oversized mountain preset can recover with the same zoom controls", () => {
    const mountainIds = ["yosemite", "fuji", "matterhorn", "grand-canyon", "everest", "denali", "dolomites", "rainier"];
    for (const place of CURATED_PLACES.filter((p) => mountainIds.includes(p.id))) {
      const view = mountAt(place.center, place.zoom);
      while (!isBboxSmallEnough(view.props().bounds) && view.props().zoom < 22) view.zoom("Zoom in");
      expect(isBboxSmallEnough(view.props().bounds)).toBe(true);
      view.zoom("Zoom out");
      expect(view.props().zoom).toBeLessThan(22);
      act(() => view.renderer.unmount());
    }
  });

  test("zoom scales exact restored bounds instead of replacing them with a canonical frame", () => {
    for (const frame of [56, 84, { width: 280, height: 120 }]) {
      const bounds = deriveSelectionBounds([-119.57, 37.73], 11, frame);
      const view = mountAt([-119.57, 37.73], 11, bounds);
      const originalWidth = bounds.east - bounds.west;
      const originalArea = bboxAreaKm2(bounds);
      view.zoom("Zoom in");
      expect(view.props().bounds.east - view.props().bounds.west).toBeCloseTo(originalWidth / 2, 10);
      expect(bboxAreaKm2(view.props().bounds)).toBeLessThan(originalArea);
      view.zoom("Zoom out");
      expect(view.props().bounds.east - view.props().bounds.west).toBeCloseTo(originalWidth, 10);
      view.zoom("Zoom out");
      expect(bboxAreaKm2(view.props().bounds)).toBeGreaterThan(originalArea);
      const center = getMercatorBoundsCenter(view.props().bounds);
      expect(center[0]).toBeCloseTo(-119.57, 8);
      expect(center[1]).toBeCloseTo(37.73, 8);
      act(() => view.renderer.unmount());
    }
  });

  test("clamped fractional zoom uses the actual delta and no-op limits preserve exact bounds", () => {
    const bounds = deriveSelectionBounds([4, 63], 21.75, 56);
    const scaled = zoomSelectionBounds(bounds, 21.75, 22.75);
    expect((scaled.east - scaled.west) / (bounds.east - bounds.west)).toBeCloseTo(2 ** -0.25, 6);
    expect(zoomSelectionBounds(bounds, 22, 23)).toBe(bounds);
    expect(zoomSelectionBounds(bounds, 0, -1)).toBe(bounds);
  });

  test("zoom near the antimeridian and Mercator edges stays legal without moving center", () => {
    for (const bounds of [
      { west: 179.5, east: 180, south: 40, north: 40.5 },
      { west: -180, east: -179.5, south: -40.5, north: -40 },
      { west: 20, east: 21, south: 84.9, north: 85.05112878 },
    ]) {
      const center = getMercatorBoundsCenter(bounds);
      for (const nextZoom of [10, 12]) {
        const scaled = zoomSelectionBounds(bounds, 11, nextZoom);
        expect(validateGeoBounds(scaled)).not.toBeNull();
        const nextCenter = getMercatorBoundsCenter(scaled);
        expect(nextCenter[0]).toBeCloseTo(center[0], 8);
        expect(nextCenter[1]).toBeCloseTo(center[1], 8);
      }
    }
  });

  test("explicit high zoom survives App reconciliation and restores a 21→22→21 round trip", () => {
    for (const center of [[0, 0], [4, 63]] as [number, number][]) {
      const view = mountAt(center, 21);
      const original = view.props().bounds;
      const originalSpan = original.east - original.west;
      view.zoom("Zoom in");
      expect(view.props().zoom).toBe(22);
      expect(view.props().bounds.east - view.props().bounds.west).toBeCloseTo(originalSpan / 2, 12);
      expect(view.generations()).toBe(1);
      const zoomed = view.props().bounds;
      view.report({ ...zoomed, west: zoomed.west + 1e-8 }, 22, "restore");
      expect(view.props().bounds).toBe(zoomed);
      expect(view.generations()).toBe(1);
      view.report({ ...zoomed }, 22, "zoom");
      expect(view.generations()).toBe(1);
      view.zoom("Zoom out");
      expect(view.props().zoom).toBe(21);
      expect(view.props().bounds.east - view.props().bounds.west).toBeCloseTo(originalSpan, 12);
      expect(view.props().bounds.north).toBeCloseTo(original.north, 12);
      expect(view.props().bounds.south).toBeCloseTo(original.south, 12);
      const restoredCenter = getMercatorBoundsCenter(view.props().bounds);
      expect(restoredCenter[0]).toBeCloseTo(center[0], 10);
      expect(restoredCenter[1]).toBeCloseTo(center[1], 10);
      expect(view.generations()).toBe(2);
      act(() => view.renderer.unmount());
    }
  });

  test("fractional clamping regenerates once and repeated limit actions do not regenerate", () => {
    const view = mountAt([0, 0], 21.75);
    const original = view.props().bounds;
    view.zoom("Zoom in");
    expect(view.props().zoom).toBe(22);
    expect((view.props().bounds.east - view.props().bounds.west) / (original.east - original.west)).toBeCloseTo(2 ** -0.25, 8);
    expect(view.generations()).toBe(1);
    const clamped = view.props().bounds;
    view.zoom("Zoom in");
    expect(view.props().bounds).toBe(clamped);
    expect(view.generations()).toBe(1);
    act(() => view.renderer.unmount());
    const minimum = mountAt([0, 0], 0);
    const minBounds = minimum.props().bounds;
    minimum.zoom("Zoom out");
    expect(minimum.props().bounds).toBe(minBounds);
    expect(minimum.generations()).toBe(0);
    act(() => minimum.renderer.unmount());
  });

  test("zoom buttons expose accessible bounds at the supported zoom limits", () => {
    for (const [zoom, name] of [[0, "Zoom out"], [22, "Zoom in"]] as const) {
      const view = mountAt([0, 0], zoom);
      expect(view.renderer.root.findByProps({ "aria-label": name }).props.disabled).toBe(true);
      act(() => view.renderer.unmount());
    }
  });
});
