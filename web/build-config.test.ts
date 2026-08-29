import { describe, expect, test } from "bun:test";
import {
  CANONICAL_APP_ORIGIN,
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
      canonicalOrigin: "https://stratastudio.jonathanrreed.com",
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
      canonicalOrigin: "https://stratastudio.jonathanrreed.com",
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

describe("canonical public origin", () => {
  test("uses the branded origin across public metadata sources", async () => {
    expect(CANONICAL_APP_ORIGIN).toBe(
      "https://stratastudio.jonathanrreed.com",
    );
    const canonicalOrigin = CANONICAL_APP_ORIGIN;
    const legacyOrigin = ["https://strata-studio", ".pages.dev"].join("");
    const files = [
      "index.html",
      "public/robots.txt",
      "public/sitemap.xml",
      "public/llms.txt",
    ];
    const contents = await Promise.all(
      files.map((file) => Bun.file(new URL(`./${file}`, import.meta.url)).text()),
    );

    for (const content of contents) {
      expect(content).toContain(canonicalOrigin);
      expect(content).not.toContain(legacyOrigin);
    }
  });
});
