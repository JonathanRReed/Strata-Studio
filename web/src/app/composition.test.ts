import { describe, expect, it } from "bun:test";
import type { GeoBounds, StyleParams } from "../engine/types.ts";
import { deterministicCustomPaletteId } from "../presets/customPalettes.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import {
  COMPOSITION_KIND,
  COMPOSITION_VERSION,
  MAX_COMPOSITION_FILE_BYTES,
  CompositionValidationError,
  createCompositionDocument,
  parseCompositionText,
  prepareImportedComposition,
  readCompositionFile,
  serializeCompositionDocument,
  validateCompositionDocument,
} from "./composition.ts";
import { parseShareParams, serializeShareState } from "./urlState.ts";

const BOUNDS: GeoBounds = {
  west: -122.51234567,
  south: 37.70123456,
  east: -122.35678901,
  north: 37.85001234,
};

function params(overrides: Partial<StyleParams> = {}): StyleParams {
  return { ...defaultStyleParams, ...overrides };
}

const CUSTOM = {
  name: "Fog & Ember",
  palette: {
    background: "#101820",
    foreground: "#f2f0e6",
    accent: "#ff6b35",
    water: "#357ded",
  },
};

describe("versioned composition documents", () => {
  it("restores a custom palette identically without local profile storage", () => {
    const query = serializeShareState({
      styleId: "ridge",
      params: params({ palette: "custom-local-random-id", seed: "cross-profile" }),
      bounds: BOUNDS,
      mapZoom: 12.375,
      selectedCustomPalette: CUSTOM,
    });

    const parsed = parseShareParams(query, { isKnownPalette: () => false });
    const expectedId = deterministicCustomPaletteId(CUSTOM.palette);
    expect(parsed.params.palette).toBe(expectedId);
    expect(parsed.customPalette).toEqual({ id: expectedId, entry: CUSTOM });
    expect(parsed.bounds).toEqual(BOUNDS);
    expect(parsed.zoom).toBe(12.375);
  });

  it("keeps valid legacy center/bounds links supported", () => {
    const parsed = parseShareParams(
      "lat=37.7749&lng=-122.4194&z=11&b=-122.5,37.7,-122.3,37.9&style=ridge&seed=legacy&palette=monochrome",
    );
    expect(parsed.styleId).toBe("ridge");
    expect(parsed.params.seed).toBe("legacy");
    expect(parsed.bounds).toEqual({ west: -122.5, south: 37.7, east: -122.3, north: 37.9 });
    expect(parsed.customPalette).toBeNull();
  });

  it("rejects malformed JSON and unsupported schema versions with readable errors", () => {
    expect(() => parseCompositionText("{not-json")).toThrow(
      new CompositionValidationError("Composition file is not valid JSON."),
    );
    expect(() =>
      parseCompositionText(
        JSON.stringify({ kind: COMPOSITION_KIND, version: COMPOSITION_VERSION + 1 }),
      ),
    ).toThrow("Unsupported composition version");
  });

  it("rejects inherited registry property names as style and palette ids", () => {
    const document = createCompositionDocument({
      styleId: "ridge",
      params: params(),
      bounds: BOUNDS,
      mapZoom: 10,
    });

    expect(() =>
      validateCompositionDocument({ ...document, style: "toString" }),
    ).toThrow("Composition style is missing or unsupported");
    expect(() =>
      validateCompositionDocument({
        ...document,
        params: { ...document.params, palette: "constructor" },
      }),
    ).toThrow("Composition palette is unsupported");
  });

  it("rejects oversized files before reading their contents", async () => {
    let reads = 0;
    const file = {
      size: MAX_COMPOSITION_FILE_BYTES + 1,
      text: async () => {
        reads++;
        return "{}";
      },
    } as Blob;
    await expect(readCompositionFile(file)).rejects.toThrow("Composition file is too large");
    expect(reads).toBe(0);
  });

  it("prepares one complete state payload only after full validation", () => {
    const original = {
      styleId: "ridge",
      params: params({ seed: "before" }),
      bounds: BOUNDS,
      mapZoom: 10,
    };
    const document = createCompositionDocument({
      styleId: "contour",
      params: params({ seed: "after", label: "Imported" }),
      bounds: { west: -1, south: 50, east: 1, north: 52 },
      mapZoom: 9.5,
    });
    const prepared = prepareImportedComposition(document);
    expect(prepared).toMatchObject({
      styleId: "contour",
      params: { seed: "after", label: "Imported" },
      bounds: { west: -1, south: 50, east: 1, north: 52 },
      mapZoom: 9.5,
      customPalette: null,
    });
    expect(original.params.seed).toBe("before");

    const malformed = JSON.parse(serializeCompositionDocument(document)) as Record<string, unknown>;
    malformed.bounds = { west: 5, east: -5, south: 0, north: 1 };
    expect(() => prepareImportedComposition(malformed as never)).toThrow("bounds are invalid");
    expect(original).toEqual({
      styleId: "ridge",
      params: params({ seed: "before" }),
      bounds: BOUNDS,
      mapZoom: 10,
    });
  });
});
