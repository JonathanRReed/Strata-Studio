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
