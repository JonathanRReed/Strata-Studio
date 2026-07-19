import { describe, it, expect } from "bun:test";
import {
  parseShareParams,
  serializeShareState,
  paramsDiff,
  resolveDefaultParams,
  type ShareState,
} from "./urlState.ts";
import { defaultStyleParams, presets, applyPreset } from "../presets/stylePresets.ts";
import { DEFAULT_STYLE_ID, getStyle } from "../studios/registry.ts";
import type { GeoBounds, StyleParams } from "../engine/types.ts";
import {
  MAX_LABEL_LENGTH,
  MAX_SEED_LENGTH,
  MAX_SHARE_PAYLOAD_LENGTH,
  WEB_MERCATOR_MAX_LAT,
} from "./stateSafety.ts";
import { COMPOSITION_QUERY_KEY, decodeCompositionFromUrl } from "./composition.ts";

const BOUNDS: GeoBounds = { west: -122.51234, south: 37.70123, east: -122.35678, north: 37.85001 };

function makeState(overrides?: {
  styleId?: string;
  params?: Partial<StyleParams>;
  bounds?: GeoBounds;
  mapZoom?: number;
}): ShareState {
  const styleId = overrides?.styleId ?? DEFAULT_STYLE_ID;
  return {
    styleId,
    params: { ...resolveDefaultParams(styleId), ...overrides?.params },
    bounds: overrides?.bounds ?? BOUNDS,
    mapZoom: overrides?.mapZoom ?? 12,
  };
}

describe("urlState round-trip", () => {
  it("round-trips default state exactly", () => {
    const state = makeState();
    const parsed = parseShareParams(serializeShareState(state));
    expect(parsed.styleId).toBe(state.styleId);
    expect(parsed.params).toEqual(state.params);
    expect(parsed.bounds).toEqual(state.bounds);
    expect(parsed.zoom).toBe(state.mapZoom);
  });

  it("round-trips modified params exactly (numbers, strings, booleans, enums)", () => {
    const state = makeState({
      params: {
        amplitude: 87,
        spacing: 3.5,
        noise: 0.42,
        seed: "abc123",
        palette: "neon",
        label: "Zürich ☕ / test&=?",
        aspectRatio: "16:9",
        buildingMode: "glow",
        buildingInfluence: 55,
        animationMode: "drift",
        transparent: true,
        occlusion: 0.35,
      },
    });
    const parsed = parseShareParams(serializeShareState(state));
    expect(parsed.styleId).toBe(state.styleId);
    expect(parsed.params).toEqual(state.params);
    expect(parsed.bounds).toEqual(state.bounds);
  });

  it("round-trips an intentionally empty seed", () => {
    const state = makeState({ params: { seed: "" } });
    const query = serializeShareState(state);
    expect(parseShareParams(query).params.seed).toBe("");
  });

  it("round-trips a non-default style with its own defaults", () => {
    const styleId = "contour";
    const state = makeState({ styleId, params: { spacing: 11, seed: "topoX" } });
    const parsed = parseShareParams(serializeShareState(state));
    expect(parsed.styleId).toBe(styleId);
    expect(parsed.params).toEqual(state.params);
  });

  it("uses the versioned document as the exact bounds source of truth", () => {
    const state = makeState({
      bounds: { west: -0.1234567, south: 51.5000001, east: -0.1000109, north: 51.5200002 },
    });
    const query = serializeShareState(state);
    const encoded = new URLSearchParams(query).get(COMPOSITION_QUERY_KEY);
    expect(encoded).not.toBeNull();
    expect(decodeCompositionFromUrl(encoded!).bounds).toEqual(state.bounds);
    expect(parseShareParams(query).bounds).toEqual(state.bounds);
  });

  it("omits p when params match the resolved defaults", () => {
    const query = serializeShareState(makeState());
    expect(new URLSearchParams(query).has("p")).toBe(false);
  });

  it("stores the complete normalized params inside the versioned document", () => {
    const state = makeState({ params: { seed: "s1", palette: "cream", amplitude: 99 } });
    const query = new URLSearchParams(serializeShareState(state));
    const document = decodeCompositionFromUrl(query.get(COMPOSITION_QUERY_KEY)!);
    expect(document.params).toEqual(state.params);
  });
});

describe("urlState parse precedence", () => {
  const preset = presets[0];

  it("applies a preset as the base params", () => {
    const parsed = parseShareParams(`preset=${preset.id}`);
    expect(parsed.styleId).toBe(preset.styleId);
    expect(parsed.params).toEqual(applyPreset(preset, getStyle(preset.styleId).defaultParams));
  });

  it("lets explicit style override the preset's style", () => {
    const parsed = parseShareParams(`preset=${preset.id}&style=contour`);
    expect(parsed.styleId).toBe("contour");
    // Preset params are kept (matches the old behavior)
    expect(parsed.params.amplitude).toBe(applyPreset(preset, getStyle(preset.styleId).defaultParams).amplitude);
  });

  it("applies seed and palette over the preset", () => {
    const parsed = parseShareParams(`preset=${preset.id}&seed=xyz&palette=neon`);
    expect(parsed.params.seed).toBe("xyz");
    expect(parsed.params.palette).toBe("neon");
  });

  it("lets the p diff win last", () => {
    const state = makeState({ styleId: preset.styleId, params: { ...preset.params, amplitude: 3 } });
    const query = `${serializeShareState(state)}&preset=${preset.id}`;
    expect(parseShareParams(query).params.amplitude).toBe(3);
  });

  it("ignores unknown presets and styles", () => {
    const parsed = parseShareParams("preset=nope&style=also-nope");
    expect(parsed.styleId).toBe(DEFAULT_STYLE_ID);
    expect(parsed.params).toEqual(resolveDefaultParams(DEFAULT_STYLE_ID));
  });

  it("rejects unknown palettes via isKnownPalette", () => {
    const parsed = parseShareParams("palette=custom-missing", {
      isKnownPalette: (id) => id === "monochrome",
    });
    expect(parsed.params.palette).toBe(defaultStyleParams.palette);
  });
});

describe("urlState robustness", () => {
  it("ignores malformed and oversized p payloads", () => {
    expect(parseShareParams("p=!!!not-base64!!!").params).toEqual(
      resolveDefaultParams(DEFAULT_STYLE_ID),
    );
    expect(
      parseShareParams(`p=${"A".repeat(MAX_SHARE_PAYLOAD_LENGTH + 1)}`).params,
    ).toEqual(resolveDefaultParams(DEFAULT_STYLE_ID));
  });

  it("clamps URL numbers, caps text, and validates all enum families", () => {
    const payload = {
      amplitude: 99999,
      spacing: -999,
      label: "L".repeat(MAX_LABEL_LENGTH + 20),
      labelStyle: "billboard",
      aspectRatio: "100:1",
      animationMode: "warp",
      buildingMode: "erase",
      roadMode: "erase",
      waterMode: "erase",
      oceanMode: "erase",
      lakeMode: "erase",
      riverMode: "erase",
    };
    const p = Buffer.from(JSON.stringify(payload), "utf8")
      .toString("base64url");
    const parsed = parseShareParams(
      `seed=${"S".repeat(MAX_SEED_LENGTH + 20)}&p=${p}`,
    );
    expect(parsed.params.amplitude).toBe(120);
    expect(parsed.params.spacing).toBe(1);
    expect(parsed.params.seed).toHaveLength(MAX_SEED_LENGTH);
    expect(parsed.params.label).toHaveLength(MAX_LABEL_LENGTH);
    expect(parsed.params.labelStyle).toBe(defaultStyleParams.labelStyle);
    expect(parsed.params.aspectRatio).toBe(defaultStyleParams.aspectRatio);
    expect(parsed.params.animationMode).toBe(defaultStyleParams.animationMode);
    expect(parsed.params.buildingMode).toBe(defaultStyleParams.buildingMode);
    expect(parsed.params.roadMode).toBe(defaultStyleParams.roadMode);
    expect(parsed.params.waterMode).toBe(defaultStyleParams.waterMode);
    expect(parsed.params.oceanMode).toBe(defaultStyleParams.oceanMode);
    expect(parsed.params.lakeMode).toBe(defaultStyleParams.lakeMode);
    expect(parsed.params.riverMode).toBe(defaultStyleParams.riverMode);
  });

  it("normalizes extreme center/zoom and rejects non-Mercator bounds", () => {
    const parsed = parseShareParams(
      "lat=999&lng=1000000000&z=999&b=-1,-90,1,90",
    );
    expect(parsed.bounds).toBeNull();
    expect(parsed.center).toEqual([-80, WEB_MERCATOR_MAX_LAT]);
    expect(parsed.zoom).toBe(22);
  });

  it("drops unknown keys, wrong types, and invalid enum values from p", () => {
    const payload = {
      amplitude: "not-a-number",
      hacked: true,
      aspectRatio: "7:3",
      buildingMode: "explode",
      animationMode: "warp",
      spacing: 4,
      seed: "smuggled",
    };
    const p = Buffer.from(JSON.stringify(payload), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const parsed = parseShareParams(`p=${p}`);
    const defaults = resolveDefaultParams(DEFAULT_STYLE_ID);
    expect(parsed.params).toEqual({ ...defaults, spacing: 4 });
  });

  it("ignores invalid b values", () => {
    expect(parseShareParams("b=1,2,3").bounds).toBeNull();
    expect(parseShareParams("b=a,b,c,d").bounds).toBeNull();
    expect(parseShareParams("b=-1,,1,2").bounds).toBeNull();
    // west >= east
    expect(parseShareParams("b=10,0,-10,5").bounds).toBeNull();
    expect(parseShareParams("").bounds).toBeNull();
  });

  it("does not coerce blank legacy coordinates or zoom to zero", () => {
    const parsed = parseShareParams("lat=&lng=&z=");
    expect(parsed.center).toBeNull();
    expect(parsed.zoom).toBeNull();
  });

  it("reads legacy lat/lng/z URLs without b (center + zoom only)", () => {
    const parsed = parseShareParams("lat=37.7749&lng=-122.4194&z=11&style=ridge&seed=q");
    expect(parsed.bounds).toBeNull();
    expect(parsed.center).toEqual([-122.4194, 37.7749]);
    expect(parsed.zoom).toBe(11);
    expect(parsed.styleId).toBe("ridge");
    expect(parsed.params.seed).toBe("q");
  });

  it("derives the center from b when lat/lng are missing", () => {
    const parsed = parseShareParams("b=-1.00000,50.00000,1.00000,52.00000");
    expect(parsed.center).toEqual([0, 51]);
  });
});

describe("paramsDiff", () => {
  it("is empty for identical params", () => {
    const defaults = resolveDefaultParams(DEFAULT_STYLE_ID);
    expect(paramsDiff(defaults, defaults)).toEqual({});
  });

  it("captures only changed keys, never seed/palette", () => {
    const defaults = resolveDefaultParams(DEFAULT_STYLE_ID);
    const diff = paramsDiff(
      { ...defaults, amplitude: defaults.amplitude + 1, seed: "x", palette: "neon" },
      defaults,
    );
    expect(diff).toEqual({ amplitude: defaults.amplitude + 1 });
  });
});
