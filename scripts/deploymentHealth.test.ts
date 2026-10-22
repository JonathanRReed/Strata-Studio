import { expect, test } from 'bun:test';
import { inspectProxyHealth } from './deploymentHealth.ts';
const origin = 'https://stratastudio.example';
const healthy = { ok: true, service: 'strata-proxy', routes: { terrain: { enabled: true }, overpass: { enabled: true } } };
function response(body: unknown, cors: string | null = origin, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(cors ? { 'Access-Control-Allow-Origin': cors } : {}) } });
}
test('accepts the exact browser origin with both data routes enabled', async () => {
  expect(await inspectProxyHealth(response(healthy), origin)).toEqual([]);
});
test("accepts the explicitly enabled free feature fallback when raw Overpass is disabled", async () => {
  expect(
    await inspectProxyHealth(
      response({
        ...healthy,
        routes: {
          terrain: { enabled: true },
          overpass: { enabled: false },
          mapFeatures: { enabled: true },
        },
      }),
      origin,
    ),
  ).toEqual([]);
});
test('rejects an HTTP-healthy proxy whose OSM route is disabled', async () => {
  expect(await inspectProxyHealth(response({ ...healthy, routes: { ...healthy.routes, overpass: { enabled: false } } }), origin)).toContain('Overpass route is disabled');
});
test('checks browser CORS, not merely a server-side 200 response', async () => {
  expect(await inspectProxyHealth(response(healthy, null), origin)).toContain('Proxy does not allow the application origin');
  expect(await inspectProxyHealth(response(healthy, '*'), origin)).toContain('Proxy does not allow the application origin');
});
test('reports forbidden origins and malformed health bodies without accepting them', async () => {
  expect(await inspectProxyHealth(response({ error: { code: 'origin_forbidden' } }, null, 403), origin)).toContain('Proxy health returned HTTP 403');
  expect(await inspectProxyHealth(response({ ok: true }), origin)).toContain('Proxy health response is incomplete');
});


test("browser CI images are immutable and match the installed Playwright version", async () => {
  const workflow = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
  const manifest = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const images = [...workflow.matchAll(/mcr\.microsoft\.com\/playwright:v([0-9.]+)-noble@sha256:[a-f0-9]{64}/g)];
  expect(images).toHaveLength(2);
  for (const image of images) expect(image[1]).toBe(manifest.devDependencies["@playwright/test"]);
});
