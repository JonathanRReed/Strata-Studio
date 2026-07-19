import type { GeoBounds, Palette, StyleParams } from "../engine/types.ts";
import {
  deterministicCustomPaletteId,
  isCustomPaletteId,
  validateCustomPaletteEntry,
  type CustomPaletteEntry,
} from "../presets/customPalettes.ts";
import { palettes } from "../presets/palettes.ts";
import { defaultStyleParams } from "../presets/stylePresets.ts";
import { DEFAULT_STYLE_ID, getStyle, stylesById } from "../studios/registry.ts";
import {
  MAX_SHARE_PAYLOAD_LENGTH,
  normalizeMapZoom,
  normalizeStyleParams,
  validateGeoBounds,
} from "./stateSafety.ts";

export const COMPOSITION_KIND = "strata-composition";
export const COMPOSITION_VERSION = 1;
export const COMPOSITION_QUERY_KEY = "composition";
export const MAX_COMPOSITION_FILE_BYTES = 256 * 1024;

export type CompositionCustomPalette = {
  id: string;
  name: string;
  definition: Palette;
};

export type CompositionDocumentV1 = {
  kind: typeof COMPOSITION_KIND;
  version: typeof COMPOSITION_VERSION;
  bounds: GeoBounds;
  zoom: number;
  style: string;
  params: StyleParams;
  customPalette?: CompositionCustomPalette;
};

export type CompositionSourceState = {
  styleId: string;
  params: StyleParams;
  bounds: GeoBounds;
  mapZoom: number;
  selectedCustomPalette?: CustomPaletteEntry | null;
};

export type CompositionImportStatus =
  | { phase: "idle" }
  | { phase: "reading" }
  | { phase: "success"; message: string }
  | { phase: "error"; message: string };

export type ImportedComposition = {
  styleId: string;
  params: StyleParams;
  bounds: GeoBounds;
  mapZoom: number;
  customPalette: { id: string; entry: CustomPaletteEntry } | null;
};

export class CompositionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositionValidationError";
  }
}

function fail(message: string): never {
  throw new CompositionValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnRegistryEntry(registry: object, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, id);
}

function compositionDefaults(styleId: string): StyleParams {
  return { ...defaultStyleParams, ...getStyle(styleId).defaultParams };
}

function validateFullParams(value: unknown, styleId: string): StyleParams {
  if (!isRecord(value)) fail("Composition params must be an object.");
  const requiredKeys = Object.keys(defaultStyleParams) as (keyof StyleParams)[];
  const actualKeys = Object.keys(value);
  const unknown = actualKeys.find((key) => !(key in defaultStyleParams));
  if (unknown) fail(`Composition params contain an unknown field: ${unknown}.`);
  const missing = requiredKeys.find((key) => !(key in value));
  if (missing) fail(`Composition params are missing the required field: ${missing}.`);

  const normalized = normalizeStyleParams(value, compositionDefaults(styleId));
  for (const key of requiredKeys) {
    if (value[key] !== normalized[key]) {
      fail(`Composition param “${key}” is invalid or outside its supported range.`);
    }
  }
  return normalized;
}

export function createCompositionDocument(state: CompositionSourceState): CompositionDocumentV1 {
  const styleId = hasOwnRegistryEntry(stylesById, state.styleId)
    ? state.styleId
    : DEFAULT_STYLE_ID;
  const bounds = validateGeoBounds(state.bounds);
  if (!bounds) fail("The composition bounds are invalid.");
  const zoom = normalizeMapZoom(state.mapZoom, Number.NaN);
  if (!Number.isFinite(zoom)) fail("The composition zoom is invalid.");

  let params = normalizeStyleParams(state.params, compositionDefaults(styleId));
  let customPalette: CompositionCustomPalette | undefined;
  if (isCustomPaletteId(params.palette)) {
    const entry = validateCustomPaletteEntry(state.selectedCustomPalette);
    if (!entry) {
      fail("The selected custom palette is unavailable and cannot be shared safely.");
    }
    const id = deterministicCustomPaletteId(entry.palette);
    params = { ...params, palette: id };
    customPalette = { id, name: entry.name, definition: entry.palette };
  }

  return {
    kind: COMPOSITION_KIND,
    version: COMPOSITION_VERSION,
    bounds,
    zoom,
    style: styleId,
    params,
    ...(customPalette ? { customPalette } : {}),
  };
}

export function validateCompositionDocument(value: unknown): CompositionDocumentV1 {
  if (!isRecord(value)) fail("Composition file must contain a JSON object.");
  if (value.kind !== COMPOSITION_KIND) {
    fail(`This is not a ${COMPOSITION_KIND} document.`);
  }
  if (value.version !== COMPOSITION_VERSION) {
    const version = typeof value.version === "number" ? value.version : "missing";
    fail(`Unsupported composition version: ${version}. Expected version ${COMPOSITION_VERSION}.`);
  }
  if (
    typeof value.style !== "string" ||
    !hasOwnRegistryEntry(stylesById, value.style)
  ) {
    fail("Composition style is missing or unsupported.");
  }
  const bounds = validateGeoBounds(value.bounds);
  if (!bounds) fail("Composition bounds are invalid.");
  if (
    typeof value.zoom !== "number" ||
    !Number.isFinite(value.zoom) ||
    normalizeMapZoom(value.zoom, Number.NaN) !== value.zoom
  ) {
    fail("Composition zoom is invalid or outside the supported range.");
  }

  let params = validateFullParams(value.params, value.style);
  let customPalette: CompositionCustomPalette | undefined;
  if (value.customPalette !== undefined) {
    if (!isRecord(value.customPalette)) fail("Custom palette data must be an object.");
    const entry = validateCustomPaletteEntry({
      name: value.customPalette.name,
      palette: value.customPalette.definition,
    });
    if (!entry) fail("Custom palette data is malformed.");
    const id = deterministicCustomPaletteId(entry.palette);
    if (value.customPalette.id !== id) {
      fail("Custom palette identifier does not match its color definition.");
    }
    if (params.palette !== id) {
      fail("Composition params do not select the embedded custom palette.");
    }
    customPalette = { id, name: entry.name, definition: entry.palette };
  }

  if (isCustomPaletteId(params.palette) && !customPalette) {
    fail("A custom palette composition must include its palette definition and name.");
  }
  if (!isCustomPaletteId(params.palette) && customPalette) {
    fail("Embedded custom palette data is present but not selected.");
  }
  if (
    !isCustomPaletteId(params.palette) &&
    !hasOwnRegistryEntry(palettes, params.palette)
  ) {
    fail("Composition palette is unsupported.");
  }
  params = normalizeStyleParams(params, compositionDefaults(value.style));
  return {
    kind: COMPOSITION_KIND,
    version: COMPOSITION_VERSION,
    bounds,
    zoom: value.zoom,
    style: value.style,
    params,
    ...(customPalette ? { customPalette } : {}),
  };
}

export function serializeCompositionDocument(
  document: CompositionDocumentV1,
  pretty = false,
): string {
  const validated = validateCompositionDocument(document);
  return JSON.stringify(validated, null, pretty ? 2 : undefined);
}

export function parseCompositionText(text: string): CompositionDocumentV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("Composition file is not valid JSON.");
  }
  return validateCompositionDocument(parsed);
}

export function encodeCompositionForUrl(document: CompositionDocumentV1): string {
  const text = serializeCompositionDocument(document);
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCompositionFromUrl(encoded: string): CompositionDocumentV1 {
  if (!encoded || encoded.length > MAX_SHARE_PAYLOAD_LENGTH) {
    fail("Shared composition payload is missing or too large.");
  }
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padding = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
    const binary = atob(base64 + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return parseCompositionText(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof CompositionValidationError) throw error;
    fail("Shared composition payload is malformed.");
  }
}

export async function readCompositionFile(file: Blob): Promise<CompositionDocumentV1> {
  if (file.size > MAX_COMPOSITION_FILE_BYTES) {
    fail(
      `Composition file is too large (${file.size.toLocaleString()} bytes). Maximum size is ${MAX_COMPOSITION_FILE_BYTES.toLocaleString()} bytes.`,
    );
  }
  const text = await file.text();
  if (new TextEncoder().encode(text).byteLength > MAX_COMPOSITION_FILE_BYTES) {
    fail("Composition file exceeds the maximum decoded size.");
  }
  return parseCompositionText(text);
}

/** Converts a fully validated document into one state payload before any React setters run. */
export function prepareImportedComposition(document: CompositionDocumentV1): ImportedComposition {
  const validated = validateCompositionDocument(document);
  return {
    styleId: validated.style,
    params: validated.params,
    bounds: validated.bounds,
    mapZoom: validated.zoom,
    customPalette: validated.customPalette
      ? {
          id: validated.customPalette.id,
          entry: {
            name: validated.customPalette.name,
            palette: validated.customPalette.definition,
          },
        }
      : null,
  };
}
