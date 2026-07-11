import { describe, expect, test } from "bun:test";
import {
  computeInfluenceBump,
  firstRunPlace,
  hasShareState,
  INFLUENCE_BUMP,
  INFLUENCE_KEYS,
  urlLocksInfluence,
} from "./autopilot.ts";
import { serializeShareState, paramsDiff, resolveDefaultParams } from "./urlState.ts";
import { defaultStyleParams, presets, applyPreset } from "../presets/stylePresets.ts";
import { getStyle, allStyles } from "../studios/registry.ts";
import { CURATED_PLACES, dailyPlace } from "../data/places.ts";
import type { ControlKey, GeoBounds, StyleParams } from "../engine/types.ts";

const BOUNDS: GeoBounds = { west: -122.5, south: 37.7, east: -122.35, north: 37.85 };

function encodeDiff(diff: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(diff));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("hasShareState / firstRunPlace (first-run decision)", () => {
  test("empty search means fresh visit", () => {
    expect(hasShareState("")).toBe(false);
    expect(hasShareState("?")).toBe(false);
  });

  test("unknown params alone still count as fresh", () => {
    expect(hasShareState("?utm_source=twitter&fbclid=abc")).toBe(false);
  });

  test("each share key marks the visit as returning", () => {
    for (const key of ["lat", "lng", "z", "b", "style", "seed", "palette", "p", "preset"]) {
      expect(hasShareState(`?${key}=x`)).toBe(true);
    }
  });

  test("a full serialized share URL counts as returning", () => {
    const query = serializeShareState({
      styleId: "waveform-terrain",
      params: { ...defaultStyleParams },
      bounds: BOUNDS,
      mapZoom: 11,
    });
    expect(hasShareState(query)).toBe(true);
  });

  test("fresh visit picks the deterministic daily place", () => {
    const day = new Date("2026-07-10T12:00:00Z");
    const place = firstRunPlace("", day);
    expect(place).toEqual(dailyPlace(day));
    expect(place).not.toBeNull();
    expect(CURATED_PLACES.some((p) => p.id === place!.id)).toBe(true);
  });

  test("returning visit picks no place", () => {
    expect(firstRunPlace("?lat=1&lng=2&z=10")).toBeNull();
  });

  test("every curated place preset id resolves to a real preset", () => {
    for (const place of CURATED_PLACES) {
      expect(presets.some((p) => p.id === place.presetId)).toBe(true);
    }
  });
});

describe("urlLocksInfluence (URL influence values are user choices)", () => {
  test("no p diff never locks", () => {
    expect(urlLocksInfluence("")).toBe(false);
    expect(urlLocksInfluence("?lat=1&lng=2&style=ridge")).toBe(false);
  });

  test("p diff without influence keys does not lock", () => {
    expect(urlLocksInfluence(`?p=${encodeDiff({ amplitude: 80, grain: 0.3 })}`)).toBe(false);
  });

  test("p diff with a nonzero influence locks", () => {
    expect(urlLocksInfluence(`?p=${encodeDiff({ buildingInfluence: 60 })}`)).toBe(true);
  });

  test("p diff with a mask mode locks", () => {
    expect(urlLocksInfluence(`?p=${encodeDiff({ waterMode: "glow" })}`)).toBe(true);
  });

  test("explicit zero vs a nonzero baseline locks (deliberate zero)", () => {
    // interference-map preset sets buildingInfluence 90; the p diff pinning
    // it back to 0 is a deliberate user zero and must lock the bump.
    expect(
      urlLocksInfluence(`?preset=interference-map&p=${encodeDiff({ buildingInfluence: 0 })}`),
    ).toBe(true);
  });

  test("malformed p is ignored", () => {
    expect(urlLocksInfluence("?p=%%%not-base64")).toBe(false);
  });

  test("round-trip: a bumped session's share URL locks the next visit", () => {
    const params: StyleParams = {
      ...resolveDefaultParams("waveform-terrain"),
      buildingInfluence: INFLUENCE_BUMP.buildingInfluence,
      roadInfluence: INFLUENCE_BUMP.roadInfluence,
      waterInfluence: INFLUENCE_BUMP.waterInfluence,
    };
    const query = serializeShareState({
      styleId: "waveform-terrain",
      params,
      bounds: BOUNDS,
      mapZoom: 13,
    });
    expect(urlLocksInfluence(query)).toBe(true);
  });
});

describe("computeInfluenceBump", () => {
  const allInfluenceControls = [...INFLUENCE_KEYS] as ControlKey[];

  test("bumps building/road/water when all declared influences are zero", () => {
    const bump = computeInfluenceBump({ ...defaultStyleParams }, allInfluenceControls);
    expect(bump).toEqual({
      buildingInfluence: INFLUENCE_BUMP.buildingInfluence,
      buildingMode: "interrupt",
      roadInfluence: INFLUENCE_BUMP.roadInfluence,
      waterInfluence: INFLUENCE_BUMP.waterInfluence,
    });
  });

  test("never sets per-type water influences", () => {
    const bump = computeInfluenceBump({ ...defaultStyleParams }, allInfluenceControls);
    expect(bump).not.toBeNull();
    expect(bump!.oceanInfluence).toBeUndefined();
    expect(bump!.lakeInfluence).toBeUndefined();
    expect(bump!.riverInfluence).toBeUndefined();
  });

  test("no bump when any declared influence is already nonzero", () => {
    for (const key of INFLUENCE_KEYS) {
      const params = { ...defaultStyleParams, [key]: 15 };
      expect(computeInfluenceBump(params, allInfluenceControls)).toBeNull();
    }
  });

  test("preset with influences already set is left alone", () => {
    const preset = presets.find((p) => p.id === "interference-map")!;
    const params = applyPreset(preset, getStyle(preset.styleId).defaultParams);
    expect(computeInfluenceBump(params, getStyle(preset.styleId).controls)).toBeNull();
  });

  test("only sets influences the style declares", () => {
    const bump = computeInfluenceBump({ ...defaultStyleParams }, [
      "amplitude",
      "buildingInfluence",
    ] as ControlKey[]);
    expect(bump).toEqual({
      buildingInfluence: INFLUENCE_BUMP.buildingInfluence,
      buildingMode: "interrupt",
    });
  });

  test("null when the style declares no influence controls", () => {
    expect(
      computeInfluenceBump({ ...defaultStyleParams }, ["amplitude", "spacing"] as ControlKey[]),
    ).toBeNull();
  });

  test("undefined controls fall back to all influences (ControlsPanel parity)", () => {
    const bump = computeInfluenceBump({ ...defaultStyleParams }, undefined);
    expect(bump).toEqual({
      buildingInfluence: INFLUENCE_BUMP.buildingInfluence,
      buildingMode: "interrupt",
      roadInfluence: INFLUENCE_BUMP.roadInfluence,
      waterInfluence: INFLUENCE_BUMP.waterInfluence,
    });
  });

  test("a nonzero per-type water influence blocks the bump", () => {
    const params = { ...defaultStyleParams, riverInfluence: 20 };
    expect(computeInfluenceBump(params, allInfluenceControls)).toBeNull();
  });

  test("per registered style: bumps iff its factory defaults leave influences at zero", () => {
    for (const style of allStyles) {
      const params = { ...defaultStyleParams, ...style.defaultParams };
      const declared = new Set(style.controls ?? INFLUENCE_KEYS);
      const anyEngaged = INFLUENCE_KEYS.some(
        (key) => declared.has(key) && params[key] !== 0,
      );
      const bump = computeInfluenceBump(params, style.controls);
      if (anyEngaged) {
        // e.g. building-interference ships with influences on — leave it be.
        expect(bump).toBeNull();
      } else {
        expect(bump).not.toBeNull();
      }
    }
  });

  test("bumped params round-trip through the share URL diff", () => {
    const defaults = resolveDefaultParams("waveform-terrain");
    const bump = computeInfluenceBump(defaults, getStyle("waveform-terrain").controls)!;
    const diff = paramsDiff({ ...defaults, ...bump }, defaults);
    expect(diff.buildingInfluence).toBe(INFLUENCE_BUMP.buildingInfluence);
    expect(diff.roadInfluence).toBe(INFLUENCE_BUMP.roadInfluence);
    expect(diff.waterInfluence).toBe(INFLUENCE_BUMP.waterInfluence);
  });
});
