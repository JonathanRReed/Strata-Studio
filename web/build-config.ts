export type PublicBuildConfig = {
  appOrigin: string;
  terrainTileUrl: string;
  overpassUrl: string | null;
  production: boolean;
};

export type PublicBuildEnv = {
  appOrigin?: string;
  terrainTileUrl?: string;
  overpassUrl?: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const DIRECT_TERRAIN_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

export const KNOWN_DIRECT_DATA_HOSTS = [
  "s3.amazonaws.com",
  "overpass-api.de",
  "overpass.private.coffee",
  "maps.mail.ru",
] as const;

const knownDirectDataHosts = new Set<string>(KNOWN_DIRECT_DATA_HOSTS);

function validatePublicUrl(
  name: string,
  value: string,
  {
    production,
    originOnly = false,
  }: { production: boolean; originOnly?: boolean },
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${name} must be an absolute URL; received ${JSON.stringify(value)}.`,
    );
  }

  const localHost = LOCAL_HOSTS.has(url.hostname);
  const localHttp = !production && url.protocol === "http:" && localHost;
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error(
      `${name} must use HTTPS${production ? " in production" : " (HTTP is only allowed for localhost)"}.`,
    );
  }
  if (production && localHost) {
    throw new Error(`${name} must not use localhost in production.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name} must not contain a query string or hash.`);
  }
  if (originOnly && url.pathname !== "/") {
    throw new Error(
      `${name} must be an origin without a path; received ${url.pathname}.`,
    );
  }

  return originOnly ? url.origin : value.replace(/\/+$/, "");
}

function assertProductionProxyRoutes(
  terrainTileUrl: string,
  overpassUrl: string,
): void {
  const terrain = new URL(terrainTileUrl);
  const overpass = new URL(overpassUrl);

  if (terrain.pathname !== "/terrain") {
    throw new Error(
      `VITE_TERRAIN_TILE_URL must target the exact strata-proxy /terrain route; received ${terrain.pathname}.`,
    );
  }
  if (overpass.pathname !== "/overpass") {
    throw new Error(
      `VITE_OVERPASS_URL must target the exact strata-proxy /overpass route; received ${overpass.pathname}.`,
    );
  }
  if (terrain.origin !== overpass.origin) {
    throw new Error(
      "VITE_TERRAIN_TILE_URL and VITE_OVERPASS_URL must use the same strata-proxy origin.",
    );
  }
  if (
    knownDirectDataHosts.has(terrain.hostname) ||
    knownDirectDataHosts.has(overpass.hostname)
  ) {
    throw new Error(
      "Production data routes must target strata-proxy, not a direct upstream host.",
    );
  }
}

export function resolvePublicBuildConfig(
  raw: PublicBuildEnv,
  production: boolean,
): PublicBuildConfig {
  const values = {
    appOrigin: raw.appOrigin?.trim() ?? "",
    terrainTileUrl: raw.terrainTileUrl?.trim() ?? "",
    overpassUrl: raw.overpassUrl?.trim() ?? "",
  };

  if (production) {
    const missing = [
      ["VITE_APP_ORIGIN", values.appOrigin],
      ["VITE_TERRAIN_TILE_URL", values.terrainTileUrl],
      ["VITE_OVERPASS_URL", values.overpassUrl],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `Production builds require explicit ${missing.join(", ")}.`,
      );
    }
  }

  const appOrigin = validatePublicUrl(
    "VITE_APP_ORIGIN",
    values.appOrigin || "http://localhost:5173",
    { production, originOnly: true },
  );
  const terrainTileUrl = validatePublicUrl(
    "VITE_TERRAIN_TILE_URL",
    values.terrainTileUrl || DIRECT_TERRAIN_URL,
    { production },
  );
  const overpassUrl = values.overpassUrl
    ? validatePublicUrl("VITE_OVERPASS_URL", values.overpassUrl, { production })
    : null;

  if (production) {
    if (!overpassUrl) {
      throw new Error("Production builds require explicit VITE_OVERPASS_URL.");
    }
    assertProductionProxyRoutes(terrainTileUrl, overpassUrl);
  }

  return {
    appOrigin,
    terrainTileUrl,
    overpassUrl,
    production,
  };
}
