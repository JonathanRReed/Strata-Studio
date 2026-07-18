import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  resolvePublicBuildConfig,
  type PublicBuildConfig,
} from "./build-config.ts";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

function cleanMetadata(
  value: string | undefined,
  fallback: string,
  maxLength: number,
): string {
  const cleaned = value
    ?.trim()
    .replace(/[^a-zA-Z0-9._/@-]/g, "")
    .slice(0, maxLength);
  return cleaned || fallback;
}

function loadPublicBuildConfig(
  mode: string,
  production: boolean,
): PublicBuildConfig {
  const loaded = loadEnv(mode, webRoot, "VITE_");
  const read = (name: string) => {
    const value =
      process.env[name] !== undefined ? process.env[name] : loaded[name];
    return value?.trim() ?? "";
  };

  return resolvePublicBuildConfig(
    {
      appOrigin: read("VITE_APP_ORIGIN"),
      terrainTileUrl: read("VITE_TERRAIN_TILE_URL"),
      overpassUrl: read("VITE_OVERPASS_URL"),
    },
    production,
  );
}

function buildTimestamp(): string {
  const raw = process.env.SOURCE_DATE_EPOCH?.trim();
  if (!raw) return new Date().toISOString();

  const seconds = Number(raw);
  const date = new Date(seconds * 1000);
  if (
    !Number.isInteger(seconds) ||
    seconds <= 0 ||
    !Number.isFinite(date.getTime())
  ) {
    throw new Error(
      `SOURCE_DATE_EPOCH must be a positive integer Unix timestamp; received ${JSON.stringify(raw)}.`,
    );
  }
  return date.toISOString();
}

function buildInfoPlugin(config: PublicBuildConfig): Plugin {
  const commit = cleanMetadata(
    process.env.CF_PAGES_COMMIT_SHA ??
      process.env.GITHUB_SHA ??
      process.env.VITE_BUILD_COMMIT,
    "local",
    40,
  );
  const branch = cleanMetadata(
    process.env.CF_PAGES_BRANCH ??
      process.env.GITHUB_REF_NAME ??
      process.env.VITE_BUILD_BRANCH,
    "local",
    100,
  );
  const context = cleanMetadata(
    process.env.VITE_BUILD_CONTEXT,
    config.production ? "production" : "development",
    40,
  );
  const provider = ["1", "true"].includes(process.env.CF_PAGES ?? "")
    ? "cloudflare-pages"
    : process.env.GITHUB_ACTIONS === "true"
      ? "github-actions"
      : "local";
  const builtAt = buildTimestamp();

  return {
    name: "strata-build-info",
    transformIndexHtml(html) {
      return html
        .replaceAll("%STRATA_APP_ORIGIN%", config.appOrigin)
        .replaceAll(
          "%STRATA_PROXY_ORIGIN%",
          new URL(config.terrainTileUrl).origin,
        );
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-info.json",
        source: `${JSON.stringify(
          {
            schemaVersion: 1,
            app: "strata-studio",
            version: packageJson.version,
            builtAt,
            commit,
            branch,
            context,
            provider,
            appOrigin: config.appOrigin,
            dataPolicy: config.production ? "proxy-first" : "development",
            dataRoutes: {
              terrain: config.terrainTileUrl,
              overpass: config.overpassUrl,
            },
          },
          null,
          2,
        )}\n`,
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const publicConfig = loadPublicBuildConfig(mode, command === "build");
  return {
    plugins: [react(), tailwindcss(), buildInfoPlugin(publicConfig)],
    define: {
      "import.meta.env.VITE_APP_ORIGIN": JSON.stringify(publicConfig.appOrigin),
      "import.meta.env.VITE_TERRAIN_TILE_URL": JSON.stringify(
        publicConfig.terrainTileUrl,
      ),
      "import.meta.env.VITE_OVERPASS_URL": publicConfig.overpassUrl
        ? JSON.stringify(publicConfig.overpassUrl)
        : "undefined",
    },
    build: {
      chunkSizeWarningLimit: 1200,
    },
  };
});
