/**
 * Curated places for the quick-start strip, Surprise Me, and Daily Strata.
 * Each entry pairs coordinates with a preset that flatters that terrain:
 * ridge styles for glacial relief, circuit styles for street grids.
 * Zooms ≥ 13 keep the selection under the 25 km² OSM-fetch gate so
 * feature influence works out of the box for the urban entries.
 */
export type CuratedPlace = {
  id: string;
  name: string;
  region: string;
  blurb: string;
  /** [lng, lat] — MapLibre order. */
  center: [number, number];
  zoom: number;
  presetId: string;
  /** Urban entries render best with OSM features fetched. */
  wantsFeatures?: boolean;
};

export const CURATED_PLACES: CuratedPlace[] = [
  // — Mountains & ridges —
  {
    id: "yosemite",
    name: "Yosemite Valley",
    region: "California, USA",
    blurb: "Glacier-carved granite, a kilometre of relief",
    center: [-119.57, 37.73],
    zoom: 11,
    presetId: "monolith",
  },
  {
    id: "fuji",
    name: "Mount Fuji",
    region: "Honshu, Japan",
    blurb: "The perfect cone",
    center: [138.73, 35.36],
    zoom: 10.5,
    presetId: "signal-peak",
  },
  {
    id: "matterhorn",
    name: "The Matterhorn",
    region: "Valais, Switzerland",
    blurb: "The Alps at their sharpest",
    center: [7.66, 45.98],
    zoom: 11,
    presetId: "black-ridge",
  },
  {
    id: "grand-canyon",
    name: "Grand Canyon",
    region: "Arizona, USA",
    blurb: "A mile-deep negative mountain",
    center: [-112.14, 36.06],
    zoom: 11,
    presetId: "quarry",
  },
  {
    id: "everest",
    name: "Everest & Khumbu",
    region: "Nepal / Tibet",
    blurb: "The roof of the world",
    center: [86.93, 27.99],
    zoom: 10.5,
    presetId: "mountain-broadcast",
  },
  {
    id: "denali",
    name: "Denali",
    region: "Alaska, USA",
    blurb: "Six kilometres of vertical rise",
    center: [-151.0, 63.07],
    zoom: 9.5,
    presetId: "ghost-terrain",
  },
  {
    id: "dolomites",
    name: "Tre Cime di Lavaredo",
    region: "Dolomites, Italy",
    blurb: "Pale towers over green valleys",
    center: [12.3, 46.62],
    zoom: 11,
    presetId: "topo-signal",
  },
  {
    id: "rainier",
    name: "Mount Rainier",
    region: "Washington, USA",
    blurb: "A volcano wearing 26 glaciers",
    center: [-121.76, 46.85],
    zoom: 10.5,
    presetId: "topo-classic",
  },
  {
    id: "table-mountain",
    name: "Table Mountain",
    region: "Cape Town, South Africa",
    blurb: "A city pinned between cliff and sea",
    center: [18.4, -33.96],
    zoom: 12,
    presetId: "survey",
  },
  // — Coasts, fjords & islands —
  {
    id: "lofoten",
    name: "Lofoten Wall",
    region: "Nordland, Norway",
    blurb: "Mountains that rise straight from the Arctic sea",
    center: [13.75, 68.16],
    zoom: 10,
    presetId: "seismic-choir",
  },
  {
    id: "milford",
    name: "Milford Sound",
    region: "Fiordland, New Zealand",
    blurb: "Rain-carved fjord walls",
    center: [167.9, -44.64],
    zoom: 11,
    presetId: "fault-line",
  },
  {
    id: "faroes",
    name: "Faroe Islands",
    region: "North Atlantic",
    blurb: "Basalt stairs in a grey sea",
    center: [-6.98, 62.05],
    zoom: 10,
    presetId: "static-bloom",
  },
  {
    id: "amalfi",
    name: "Amalfi Coast",
    region: "Campania, Italy",
    blurb: "Villages stacked on sea cliffs",
    center: [14.6, 40.63],
    zoom: 12,
    presetId: "carved-ink",
  },
  {
    id: "big-sur",
    name: "Big Sur",
    region: "California, USA",
    blurb: "Where the Santa Lucias meet the Pacific",
    center: [-121.81, 36.27],
    zoom: 11,
    presetId: "interference-map",
  },
  {
    id: "santorini",
    name: "Santorini",
    region: "Cyclades, Greece",
    blurb: "Living on the rim of a drowned volcano",
    center: [25.42, 36.4],
    zoom: 12,
    presetId: "atlas",
  },
  {
    id: "golden-gate",
    name: "Golden Gate",
    region: "San Francisco, USA",
    blurb: "The strait, the bridge, the fog line",
    center: [-122.48, 37.81],
    zoom: 13,
    presetId: "monolith",
    wantsFeatures: true,
  },
  // — Street grids & water cities —
  {
    id: "manhattan",
    name: "Manhattan",
    region: "New York, USA",
    blurb: "The grid against two rivers",
    center: [-73.97, 40.76],
    zoom: 13,
    presetId: "city-circuit",
    wantsFeatures: true,
  },
  {
    id: "venice",
    name: "Venice",
    region: "Veneto, Italy",
    blurb: "A city drawn in canals",
    center: [12.335, 45.437],
    zoom: 14,
    presetId: "drafting-table",
    wantsFeatures: true,
  },
  {
    id: "barcelona",
    name: "Eixample",
    region: "Barcelona, Spain",
    blurb: "Cerdà's chamfered supergrid",
    center: [2.16, 41.39],
    zoom: 14,
    presetId: "city-circuit",
    wantsFeatures: true,
  },
  {
    id: "tokyo",
    name: "Shibuya",
    region: "Tokyo, Japan",
    blurb: "Organic density, radial rails",
    center: [139.7, 35.66],
    zoom: 14,
    presetId: "neon-pulse",
    wantsFeatures: true,
  },
  {
    id: "amsterdam",
    name: "Grachtengordel",
    region: "Amsterdam, Netherlands",
    blurb: "Concentric canals, four centuries old",
    center: [4.9, 52.37],
    zoom: 14,
    presetId: "iron-filings",
    wantsFeatures: true,
  },
  // — Deserts & the strange —
  {
    id: "erg-chebbi",
    name: "Erg Chebbi",
    region: "Sahara, Morocco",
    blurb: "Dunes as slow waves",
    center: [-3.98, 31.15],
    zoom: 11,
    presetId: "white-noise",
  },
  {
    id: "landmannalaugar",
    name: "Landmannalaugar",
    region: "Highlands, Iceland",
    blurb: "Rhyolite mountains in mineral colors",
    center: [-19.06, 63.98],
    zoom: 11,
    presetId: "gravity-collapse",
  },
  {
    id: "uluru",
    name: "Uluru",
    region: "Northern Territory, Australia",
    blurb: "A single stone heart in the desert",
    center: [131.03, -25.35],
    zoom: 12,
    presetId: "signal-peak",
  },
  {
    id: "mariana",
    name: "Challenger Deep",
    region: "Mariana Trench, Pacific",
    blurb: "Eleven kilometres below the waves",
    center: [142.2, 11.35],
    zoom: 8,
    presetId: "ghost-terrain",
  },
];

/** Deterministic pick for Daily Strata: same place for everyone on a given date. */
export function dailyPlace(date: Date = new Date()): CuratedPlace {
  const daysSinceEpoch = Math.floor(date.getTime() / 86_400_000);
  return CURATED_PLACES[daysSinceEpoch % CURATED_PLACES.length];
}

/** Random pick for Surprise Me, avoiding an immediate repeat. */
export function surprisePlace(excludeId?: string): CuratedPlace {
  const pool = CURATED_PLACES.filter((p) => p.id !== excludeId);
  return pool[Math.floor(Math.random() * pool.length)];
}
