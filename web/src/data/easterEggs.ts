import type { Palette } from "../engine/types.ts";

/**
 * Landmark easter eggs: generate over one of these spots and its palette
 * unlocks (persisted through the custom-palette store, so it appears in the
 * picker like any user palette) with a one-time toast. Discovery state lives
 * in localStorage so an egg never re-toasts.
 *
 * Palette ids carry the `custom-` prefix deliberately — loadCustomPalettes
 * filters on isCustomPaletteId, so anything else would vanish on reload.
 */

export type GeoPoint = { lat: number; lng: number };

export type EasterEgg = {
  id: string;
  name: string;
  center: GeoPoint;
  /** Hit radius around the center, in kilometres (haversine). */
  radiusKm: number;
  /** Toast line for first discovery (instrument voice; CSS uppercases it). */
  toastText: string;
  /** The palette unlocked on discovery. */
  palette: { id: string; name: string; palette: Palette };
};

export const EASTER_EGGS: EasterEgg[] = [
  {
    id: "null-island",
    name: "Null Island",
    center: { lat: 0, lng: 0 },
    radiusKm: 75,
    toastText: "Null Island found. 'Glitch' palette unlocked",
    palette: {
      id: "custom-egg-glitch",
      name: "Glitch",
      palette: {
        background: "#0a0a10",
        foreground: "#00e5ff",
        accent: "#ff2d78",
        water: "#4d5dff",
        ocean: "#3a46d4",
        lake: "#5d6eff",
        river: "#8b97ff",
      },
    },
  },
  {
    id: "area-51",
    name: "Area 51",
    center: { lat: 37.235, lng: -115.811 },
    radiusKm: 30,
    toastText: "Area 51 found. 'Classified' palette unlocked",
    palette: {
      id: "custom-egg-classified",
      name: "Classified",
      palette: {
        background: "#0b0e09",
        foreground: "#a9bf9b",
        accent: "#6cff8f",
        water: "#3f7f6e",
        ocean: "#2f6455",
        lake: "#4d947f",
        river: "#63aa93",
      },
    },
  },
  {
    id: "everest-summit",
    name: "Everest Summit",
    center: { lat: 27.9881, lng: 86.925 },
    radiusKm: 25,
    toastText: "Everest summit found. 'Death Zone' palette unlocked",
    palette: {
      id: "custom-egg-death-zone",
      name: "Death Zone",
      palette: {
        background: "#0a1624",
        foreground: "#dcebf5",
        accent: "#ff9b3d",
        water: "#4385b7",
        ocean: "#2f6795",
        lake: "#5c9bca",
        river: "#7fb5da",
      },
    },
  },
  {
    id: "challenger-deep",
    name: "Challenger Deep",
    center: { lat: 11.3733, lng: 142.5917 },
    radiusKm: 60,
    toastText: "Challenger Deep found. 'Hadal' palette unlocked",
    palette: {
      id: "custom-egg-hadal",
      name: "Hadal",
      palette: {
        background: "#030712",
        foreground: "#5fb4cf",
        accent: "#8ef5cd",
        water: "#155570",
        ocean: "#0e3f57",
        lake: "#1c6787",
        river: "#2c82a4",
      },
    },
  },
  {
    id: "bermuda-triangle",
    name: "Bermuda Triangle",
    center: { lat: 25.5, lng: -70.5 },
    radiusKm: 350,
    toastText: "Bermuda Triangle found. 'Vanishing Point' palette unlocked",
    palette: {
      id: "custom-egg-vanishing-point",
      name: "Vanishing Point",
      palette: {
        background: "#041a1e",
        foreground: "#a3ded7",
        accent: "#e0b95c",
        water: "#2f8f96",
        ocean: "#22737c",
        lake: "#3ca4aa",
        river: "#57bdc1",
      },
    },
  },
  {
    id: "giza-pyramids",
    name: "Giza Pyramids",
    center: { lat: 29.9773, lng: 31.1325 },
    radiusKm: 20,
    toastText: "Giza pyramids found. 'Dynasty' palette unlocked",
    palette: {
      id: "custom-egg-dynasty",
      name: "Dynasty",
      palette: {
        background: "#f0e4cc",
        foreground: "#453320",
        accent: "#c8992d",
        water: "#2f6f8f",
        ocean: "#255a78",
        lake: "#3c809d",
        river: "#4b90a9",
      },
    },
  },
];

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two coordinates, in kilometres. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** The egg whose radius covers `center`, or null. */
export function findEasterEgg(
  center: GeoPoint,
  eggs: readonly EasterEgg[] = EASTER_EGGS,
): EasterEgg | null {
  for (const egg of eggs) {
    if (haversineKm(center, egg.center) <= egg.radiusKm) return egg;
  }
  return null;
}

/**
 * First-time-only detection: the egg covering `center`, unless it was
 * already discovered (present in `foundIds`).
 */
export function detectNewEasterEgg(
  center: GeoPoint,
  foundIds: ReadonlySet<string>,
  eggs: readonly EasterEgg[] = EASTER_EGGS,
): EasterEgg | null {
  const egg = findEasterEgg(center, eggs);
  return egg && !foundIds.has(egg.id) ? egg : null;
}

const STORAGE_KEY = "strata-easter-eggs-found";

/** Discovered egg ids from localStorage (errors resolve to the empty set). */
export function loadFoundEggIds(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [],
    );
  } catch {
    return new Set();
  }
}

/** Persists discovered egg ids; false when storage is full or disabled. */
export function saveFoundEggIds(ids: ReadonlySet<string>): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids].sort()));
    return true;
  } catch {
    return false;
  }
}
