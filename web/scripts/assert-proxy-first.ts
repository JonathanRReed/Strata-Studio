import { resolve } from "node:path";
import {
  CANONICAL_APP_ORIGIN,
  KNOWN_DIRECT_DATA_HOSTS,
  resolvePublicBuildConfig,
} from "../build-config.ts";

const webRoot = resolve(import.meta.dir, "..");
const distDir = resolve(webRoot, "dist");

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object in build-info.json.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string in build-info.json.`);
  }
  return value;
}

const buildInfo = requireRecord(
  await Bun.file(resolve(distDir, "build-info.json")).json(),
  "build-info.json",
);
if (buildInfo.schemaVersion !== 1 || buildInfo.app !== "strata-studio") {
  throw new Error("build-info.json has an unsupported schema or app identity.");
}
if (buildInfo.dataPolicy !== "proxy-first") {
  throw new Error("build-info.json must declare the proxy-first data policy.");
}
const appOrigin = requireString(buildInfo.appOrigin, "appOrigin");
if (buildInfo.canonicalOrigin !== CANONICAL_APP_ORIGIN) {
  throw new Error("build-info.json must declare the branded canonical origin.");
}

const dataRoutes = requireRecord(buildInfo.dataRoutes, "dataRoutes");
const artifactValues = {
  appOrigin,
  terrainTileUrl: requireString(dataRoutes.terrain, "dataRoutes.terrain"),
  overpassUrl: requireString(dataRoutes.overpass, "dataRoutes.overpass"),
};
const expected = resolvePublicBuildConfig(artifactValues, true);
if (
  artifactValues.appOrigin !== expected.appOrigin ||
  artifactValues.terrainTileUrl !== expected.terrainTileUrl ||
  artifactValues.overpassUrl !== expected.overpassUrl
) {
  throw new Error("build-info.json contains non-canonical public URLs.");
}

const scripts: string[] = [];
const scriptPaths: string[] = [];
for await (const path of new Bun.Glob("assets/*.js").scan({
  cwd: distDir,
  absolute: true,
})) {
  scriptPaths.push(path);
  scripts.push(await Bun.file(path).text());
}
const compiledJavaScript = scripts.join("\n");
for (const [name, value] of Object.entries({
  VITE_TERRAIN_TILE_URL: expected.terrainTileUrl,
  VITE_OVERPASS_URL: expected.overpassUrl,
})) {
  if (!value || !compiledJavaScript.includes(value)) {
    throw new Error(
      `${name} was validated but is missing from the compiled JavaScript.`,
    );
  }
}
if (
  /VITE_(APP_ORIGIN|TERRAIN_TILE_URL|OVERPASS_URL)/.test(compiledJavaScript)
) {
  throw new Error(
    "Compiled JavaScript still contains unresolved launch environment variables.",
  );
}

const proxyOrigin = new URL(expected.terrainTileUrl).origin;
const indexHtml = await Bun.file(resolve(distDir, "index.html")).text();
const entryMatch = indexHtml.match(/<script[^>]+src="\/(assets\/index-[^"]+\.js)"/);
if (!entryMatch) throw new Error("Compiled HTML is missing the Vite entry script.");
const entrySource = await Bun.file(resolve(distDir, entryMatch[1])).text();
const scriptNames = scriptPaths.map((path) => path.split("/").at(-1) ?? path);
const gifChunk = scriptNames.find((name) => /^gifenc-[^.]+\.js$/.test(name));
const apngChunk = scriptNames.find((name) => /^UPNG-[^.]+\.js$/.test(name));
if (!gifChunk || !apngChunk) {
  throw new Error("GIF and APNG encoders must emit as separate lazy chunks.");
}
if (
  indexHtml.includes(gifChunk) ||
  indexHtml.includes(apngChunk) ||
  !entrySource.includes("import(`./gifenc-") ||
  !entrySource.includes("import(`./UPNG-")
) {
  throw new Error("GIF/APNG encoders must be dynamically imported and absent from initial preloads.");
}
if (
  !indexHtml.includes(`content="${CANONICAL_APP_ORIGIN}/"`) ||
  !indexHtml.includes(`content="${CANONICAL_APP_ORIGIN}/og.png"`)
) {
  throw new Error("Compiled social metadata does not use the branded canonical origin.");
}
if (!indexHtml.includes(`href="${proxyOrigin}"`)) {
  throw new Error("Compiled HTML does not preconnect to the proxy origin.");
}
for (const directHost of KNOWN_DIRECT_DATA_HOSTS) {
  if (indexHtml.includes(directHost)) {
    throw new Error(
      `Compiled HTML still warms a direct upstream host: ${directHost}.`,
    );
  }
}

console.log(`Proxy-first build assertion passed for ${proxyOrigin}.`);
