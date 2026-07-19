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
