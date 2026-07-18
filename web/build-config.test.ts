import { describe, expect, test } from "bun:test";
import {
  DIRECT_TERRAIN_URL,
  resolvePublicBuildConfig,
} from "./build-config.ts";

const productionEnv = {
  appOrigin: "https://studio.example.com",
  terrainTileUrl: "https://proxy.example.com/terrain",
  overpassUrl: "https://proxy.example.com/overpass",
};

describe("resolvePublicBuildConfig", () => {
  test("accepts and normalizes the production proxy contract", () => {
    expect(
      resolvePublicBuildConfig(
        {
          appOrigin: " https://studio.example.com/ ",
          terrainTileUrl: "https://proxy.example.com/terrain/",
          overpassUrl: "https://proxy.example.com/overpass/",
        },
        true,
      ),
    ).toEqual({
      appOrigin: "https://studio.example.com",
      terrainTileUrl: "https://proxy.example.com/terrain",
      overpassUrl: "https://proxy.example.com/overpass",
      production: true,
    });
  });

  test("requires every production URL", () => {
    expect(() => resolvePublicBuildConfig({}, true)).toThrow(
      "VITE_APP_ORIGIN, VITE_TERRAIN_TILE_URL, VITE_OVERPASS_URL",
    );
  });

  test.each([
    [
      "localhost",
      { ...productionEnv, appOrigin: "https://localhost" },
      "must not use localhost",
    ],
    [
      "credentials",
      {
        ...productionEnv,
        terrainTileUrl: "https://user:secret@proxy.example.com/terrain",
      },
      "must not contain credentials",
    ],
    [
      "query strings",
      {
        ...productionEnv,
        overpassUrl: "https://proxy.example.com/overpass?token=secret",
      },
      "must not contain a query string or hash",
    ],
    [
      "wrong terrain route",
      { ...productionEnv, terrainTileUrl: "https://proxy.example.com/tiles" },
      "exact strata-proxy /terrain route",
    ],
    [
      "split proxy origins",
      {
        ...productionEnv,
        overpassUrl: "https://other-proxy.example.com/overpass",
      },
      "same strata-proxy origin",
    ],
    [
      "direct upstream host",
      {
        ...productionEnv,
        overpassUrl: "https://overpass-api.de/overpass",
        terrainTileUrl: "https://overpass-api.de/terrain",
      },
      "not a direct upstream host",
    ],
  ])("rejects %s", (_name, env, message) => {
    expect(() => resolvePublicBuildConfig(env, true)).toThrow(message);
  });

  test("keeps safe localhost defaults for development", () => {
    expect(resolvePublicBuildConfig({}, false)).toEqual({
      appOrigin: "http://localhost:5173",
      terrainTileUrl: DIRECT_TERRAIN_URL,
      overpassUrl: null,
      production: false,
    });
  });

  test("rejects non-local HTTP in development", () => {
    expect(() =>
      resolvePublicBuildConfig(
        { appOrigin: "http://studio.example.com" },
        false,
      ),
    ).toThrow("HTTP is only allowed for localhost");
  });
});
