import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, "utf8");

describe("committed proxy safety configuration", () => {
  test("keeps Overpass disabled until edge protection is staged", () => {
    const wrangler = read("wrangler.jsonc");
    expect(wrangler).toContain('"OVERPASS_ENABLED": "false"');
    expect(wrangler).toContain('"OVERPASS_PROTECTION_STAGED": "false"');
    expect(wrangler).toContain('"TERRAIN_ENABLED": "true"');
    expect(wrangler).toContain('"ALLOWED_ORIGINS": "http://localhost:5173"');
    expect(wrangler).not.toMatch(/"ALLOWED_ORIGINS"\s*:\s*"\*"/);
    expect(wrangler).not.toMatch(/account_id|zone_id/i);
  });

  test("configures distinct provider-backed client and route budgets", () => {
    const config = JSON.parse(read("wrangler.jsonc").replace(/^\s*\/\/.*$/gm, ""));
    expect(config.ratelimits).toEqual([
      { name: "OVERPASS_CLIENT_LIMITER", namespace_id: "2026102201", simple: { limit: 6, period: 60 } },
      { name: "OVERPASS_ROUTE_LIMITER", namespace_id: "2026102202", simple: { limit: 30, period: 60 } },
    ]);
  });

  test("has no dynamic OG route source or runtime dependency", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.["workers-og"]).toBeUndefined();
    expect(packageJson.devDependencies?.["workers-og"]).toBeUndefined();
    expect(existsSync(`${root}/src/og.ts`)).toBe(false);
    expect(read("src/index.ts")).not.toContain('pathname === "/og"');
  });
});
