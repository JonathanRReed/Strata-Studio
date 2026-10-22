/** Read-only deployment check. Never changes Worker settings or bypasses protection. */
export async function inspectProxyHealth(response: Response, origin: string): Promise<string[]> {
  const problems: string[] = [];
  if (!response.ok) problems.push(`Proxy health returned HTTP ${response.status}`);
  if (response.headers.get('Access-Control-Allow-Origin') !== origin) {
    problems.push('Proxy does not allow the application origin');
  }
  let health;
  try { health = await response.json(); } catch {
    return [...problems, 'Proxy health response is not JSON'];
  }
  if (!health || health.service !== 'strata-proxy' || !health.routes?.terrain || !health.routes?.overpass) {
    problems.push('Proxy health response is incomplete');
    return problems;
  }
  if (health.ok !== true) problems.push('Proxy configuration is not healthy');
  if (health.routes.terrain.enabled !== true) problems.push('Terrain route is disabled');
  if (health.routes.overpass.enabled !== true && health.routes.mapFeatures?.enabled !== true) problems.push('Overpass route is disabled');
  return problems;
}

export async function checkDeployment(appUrl: string): Promise<string[]> {
  const app = new URL(appUrl);
  if (app.protocol !== 'https:' || app.username || app.password || app.search || app.hash || app.pathname !== '/') {
    throw new Error('Pass the exact HTTPS application origin without a path or credentials');
  }
  const infoResponse = await fetch(new URL('/build-info.json', app), { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!infoResponse.ok) throw new Error(`Build information returned HTTP ${infoResponse.status}`);
  const info = await infoResponse.json();
  if (info.app !== 'strata-studio' || !info.dataRoutes?.overpass || !info.dataRoutes?.terrain) {
    throw new Error('Build information is missing Strata data routes');
  }
  const origins = new Set<string>();
  for (const route of [info.dataRoutes.terrain, info.dataRoutes.overpass]) {
    const url = new URL(route);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Published data routes must use credential-free HTTPS URLs');
    }
    origins.add(url.origin);
  }
  const problems: string[] = [];
  for (const proxyOrigin of origins) {
    const response = await fetch(new URL('/health', proxyOrigin), {
      headers: { Origin: app.origin }, signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    problems.push(...(await inspectProxyHealth(response, app.origin)).map(problem => `${proxyOrigin}: ${problem}`));
  }
  return problems;
}

if (import.meta.main) {
  try {
    const origin = process.argv[2];
    if (!origin) throw new Error('Usage: bun run check:deployment https://your-app.example');
    const problems = await checkDeployment(origin);
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exitCode = 1;
    } else {
      console.log('Deployment origin and data-route readiness checks passed. Live feature/rendering tests are still required.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
