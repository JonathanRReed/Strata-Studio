import { expect, test } from 'bun:test';
import { createWorker, type Env } from '../src/index';
const origin = 'https://studio.example';
const bbox = '/overpass?south=40.7500&west=-73.9900&north=40.7510&east=-73.9890';
function setup(options: { client?: boolean | Error; route?: boolean | Error; missing?: boolean; enabled?: boolean } = {}) {
  const calls: string[] = [];
  const limiter = (name: string, outcome = true as boolean | Error) => ({ limit: async ({ key }: { key: string }) => {
    calls.push(name + ':' + key);
    if (outcome instanceof Error) throw outcome;
    return { success: outcome };
  } });
  const env: Env = {
    ALLOWED_ORIGINS: origin, TERRAIN_ENABLED: 'true',
    OVERPASS_ENABLED: String(options.enabled ?? true), OVERPASS_PROTECTION_STAGED: String(options.enabled ?? true),
    ...(!options.missing ? { OVERPASS_CLIENT_LIMITER: limiter('client', options.client), OVERPASS_ROUTE_LIMITER: limiter('route', options.route) } : {}),
  };
  const worker = createWorker({ fetch: (async () => { calls.push('upstream'); return new Response('{"elements":[]}', { headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch, log: () => {}, requestId: () => 'test-request' });
  const run = (path = bbox, ip: string | null = '192.0.2.1', method = 'GET') => {
    const headers = new Headers({ Origin: origin });
    if (method === 'OPTIONS') headers.set('Access-Control-Request-Method', 'GET');
    if (ip !== null) headers.set('CF-Connecting-IP', ip);
    return worker.fetch!(new Request('https://proxy.test' + path, { headers, method }) as never, env, {} as never) as Promise<Response>;
  };
  return { run, calls };
}

test('missing managed bindings fail closed before upstream', async () => {
  const h = setup({ missing: true }); const r = await h.run();
  expect(r.status).toBe(503); expect(h.calls).toEqual([]);
});
test('missing client identity fails closed', async () => {
  const h = setup(); expect((await h.run(bbox, null)).status).toBe(503); expect(h.calls).toEqual([]);
});
for (const deny of ['client', 'route'] as const) {
  test(`${deny} limit returns uncached 429 with CORS and no upstream`, async () => {
    const h = setup({ [deny]: false }); const r = await h.run();
    expect(r.status).toBe(429); expect(r.headers.get('Retry-After')).toBe('60');
    expect(r.headers.get('Cache-Control')).toBe('no-store');
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(r.headers.get('X-Request-ID')).toBe('test-request');
    expect(h.calls).not.toContain('upstream');
  });
  test(`${deny} limiter exceptions fail closed`, async () => {
    const h = setup({ [deny]: new Error('unavailable') });
    expect((await h.run()).status).toBe(503); expect(h.calls).not.toContain('upstream');
  });
}
test('both budgets must allow before an upstream fetch', async () => {
  const h = setup(); expect((await h.run()).status).toBe(200);
  expect(h.calls).toEqual(['client:192.0.2.1', 'route:overpass', 'upstream']);
});
test('staging exercises limiters with activation flags still off', async () => {
  const h = setup({ enabled: false }); expect((await h.run()).status).toBe(503);
  expect(h.calls).toEqual(['client:192.0.2.1', 'route:overpass']);
});
test('health and invalid bbox requests do not spend the OSM budget', async () => {
  const h = setup(); expect((await h.run('/health')).status).toBe(200);
  expect((await h.run('/overpass?bad=1')).status).toBe(400);
  expect(h.calls).toEqual([]);
});
test('health cannot advertise enabled OSM when bindings are absent', async () => {
  const h = setup({ missing: true }); const r = await h.run('/health');
  expect(r.status).toBe(503);
  expect((await r.json()).routes.overpass.enabled).toBe(false);
});

test('preflight and terrain do not consume OSM limiter budget', async () => {
  const h = setup();
  expect((await h.run(bbox, '192.0.2.1', 'OPTIONS')).status).toBe(204);
  await h.run('/terrain/0/0/0.png');
  expect(h.calls.filter(call => call.startsWith('client:') || call.startsWith('route:'))).toEqual([]);
});
test('malformed client identity is rejected before limiter calls', async () => {
  const h = setup(); expect((await h.run(bbox, 'arbitrary-client-key')).status).toBe(503);
  expect(h.calls).toEqual([]);
});

test('a stalled limiter has a bounded fail-closed deadline', async () => {
  let upstream = false;
  const worker = createWorker({
    fetch: (async () => { upstream = true; return new Response(); }) as typeof fetch,
    // Accelerate the production deadline, without changing its fail-closed path.
    schedule: (callback) => setTimeout(callback, 5), log: () => {},
  });
  const env: Env = { ALLOWED_ORIGINS: origin, OVERPASS_ENABLED: 'true', OVERPASS_PROTECTION_STAGED: 'true',
    OVERPASS_CLIENT_LIMITER: { limit: () => new Promise(() => {}) },
    OVERPASS_ROUTE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const r = await worker.fetch!(new Request('https://proxy.test' + bbox, {
    headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.1' },
  }) as never, env, {} as never) as Response;
  expect(r.status).toBe(503); expect(upstream).toBe(false);
});
