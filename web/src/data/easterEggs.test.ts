/**
 * Landmark easter eggs: haversine hit detection against each entry's radius,
 * first-time-only unlock logic, and integrity of the shipped entries (unique
 * ids, custom- palette ids so the palette store persists them, valid hexes).
 */

import { describe, expect, it } from "bun:test";
import {
  detectNewEasterEgg,
  EASTER_EGGS,
  findEasterEgg,
  haversineKm,
} from "./easterEggs.ts";
import { isCustomPaletteId } from "../presets/customPalettes.ts";

const HEX_RE = /^#[0-9a-f]{6}$/;

function egg(id: string) {
  const found = EASTER_EGGS.find((e) => e.id === id);
  if (!found) throw new Error(`No easter egg with id ${id}`);
  return found;
}

describe("haversineKm", () => {
  it("measures zero distance for identical points", () => {
    expect(haversineKm({ lat: 12.34, lng: -56.78 }, { lat: 12.34, lng: -56.78 })).toBe(0);
  });

  it("measures one degree of latitude/longitude at the equator as ~111 km", () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.19, 1);
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.19, 1);
  });

  it("shrinks longitude distance with latitude", () => {
    const atEquator = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    const atSixty = haversineKm({ lat: 60, lng: 0 }, { lat: 60, lng: 1 });
    expect(atSixty).toBeCloseTo(atEquator / 2, 0);
  });

  it("is symmetric", () => {
    const a = { lat: 37.235, lng: -115.811 };
    const b = { lat: 36.0, lng: -115.0 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 10);
  });
});

describe("findEasterEgg hit detection", () => {
  it("hits Null Island at exactly (0, 0)", () => {
    expect(findEasterEgg({ lat: 0, lng: 0 })?.id).toBe("null-island");
  });

  it("hits Null Island just inside its radius and misses just outside", () => {
    // 0.5° ≈ 55.6 km — inside the 75 km radius.
    expect(findEasterEgg({ lat: 0.5, lng: 0 })?.id).toBe("null-island");
    // 1° ≈ 111 km — outside.
    expect(findEasterEgg({ lat: 1, lng: 0 })).toBeNull();
  });

  it("hits every egg at its own center", () => {
    for (const e of EASTER_EGGS) {
      expect(findEasterEgg(e.center)?.id).toBe(e.id);
    }
  });

  it("hits Challenger Deep from the curated place's map center", () => {
    // data/places.ts "mariana" entry centers the map at [142.2, 11.35].
    expect(findEasterEgg({ lat: 11.35, lng: 142.2 })?.id).toBe("challenger-deep");
  });

  it("misses everywhere ordinary", () => {
    expect(findEasterEgg({ lat: 52.37, lng: 4.9 })).toBeNull(); // Amsterdam
    expect(findEasterEgg({ lat: -33.86, lng: 151.21 })).toBeNull(); // Sydney
    expect(findEasterEgg({ lat: 37.7749, lng: -122.4194 })).toBeNull(); // SF
  });
});

describe("detectNewEasterEgg first-time-only logic", () => {
  it("returns the egg when it has not been found yet", () => {
    expect(detectNewEasterEgg({ lat: 0, lng: 0 }, new Set())?.id).toBe("null-island");
  });

  it("returns null once the egg is in the found set", () => {
    expect(detectNewEasterEgg({ lat: 0, lng: 0 }, new Set(["null-island"]))).toBeNull();
  });

  it("other found eggs do not mask a fresh discovery", () => {
    const found = new Set(["area-51", "giza-pyramids"]);
    expect(detectNewEasterEgg({ lat: 0, lng: 0 }, found)?.id).toBe("null-island");
  });

  it("returns null when no egg covers the center at all", () => {
    expect(detectNewEasterEgg({ lat: 48.85, lng: 2.35 }, new Set())).toBeNull();
  });
});

describe("shipped entries integrity", () => {
  it("has six eggs with unique ids and unique palette ids", () => {
    expect(EASTER_EGGS.length).toBe(6);
    expect(new Set(EASTER_EGGS.map((e) => e.id)).size).toBe(6);
    expect(new Set(EASTER_EGGS.map((e) => e.palette.id)).size).toBe(6);
  });

  it("palette ids carry the custom- prefix so loadCustomPalettes keeps them", () => {
    for (const e of EASTER_EGGS) {
      expect(isCustomPaletteId(e.palette.id)).toBe(true);
    }
  });

  it("palettes are fully-specified lowercase hex (store-validation safe)", () => {
    for (const e of EASTER_EGGS) {
      const p = e.palette.palette;
      for (const value of [p.background, p.foreground, p.accent, p.water, p.ocean, p.lake, p.river]) {
        expect(value).toMatch(HEX_RE);
      }
      expect(e.palette.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("radii are positive and toasts name the unlock", () => {
    for (const e of EASTER_EGGS) {
      expect(e.radiusKm).toBeGreaterThan(0);
      expect(e.toastText.toLowerCase()).toContain("palette unlocked");
      expect(e.toastText.toLowerCase()).toContain(e.palette.name.toLowerCase());
    }
  });

  it("egg centers are covered by exactly one egg (no overlaps at centers)", () => {
    for (const e of EASTER_EGGS) {
      const hits = EASTER_EGGS.filter((other) => haversineKm(e.center, other.center) <= other.radiusKm);
      expect(hits.map((h) => h.id)).toEqual([e.id]);
    }
  });

  it("egg(\"null-island\") helper sees the glitch palette", () => {
    expect(egg("null-island").palette.name).toBe("Glitch");
  });
});
