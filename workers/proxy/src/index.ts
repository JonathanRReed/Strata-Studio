import {
  CACHE_NONE,
  CACHE_OVERPASS_OK,
  MAX_BBOX_KM2,
  MAX_BBOX_SPAN_KM,
  OVERPASS_MAXSIZE_BYTES,
  OVERPASS_MIRROR,
  OVERPASS_PRIMARY,
  buildOverpassQuery,
  enabledFlag,
  isAllowedOrigin,
  isJsonContentType,
  isPngContentType,
  parseAllowedOrigins,
  parseCanonicalBbox,
  parseTerrainPath,
  sanitizeBuildId,
  sanitizeRetryAfter,
  shouldRetryOverpass,
  terrainCacheControl,
  terrainUpstreamUrl,
} from "./logic";

export interface Env {
  ALLOWED_ORIGINS?: string;
  TERRAIN_ENABLED?: string;
  OVERPASS_ENABLED?: string;
  OVERPASS_PROTECTION_STAGED?: string;
  BUILD_ID?: string;
}

type RouteName = "health" | "terrain" | "overpass" | "unknown";
type TimerHandle = ReturnType<typeof setTimeout>;

type Telemetry = {
  requestId: string;
  route: RouteName;
  upstream: "none" | "terrain" | "overpass-primary" | "overpass-mirror";
  retryCount: number;
};

export type ProxyLogRecord = {
  event: "proxy_request";
  requestId: string;
  route: RouteName;
  upstream: Telemetry["upstream"];
  status: number;
  durationMs: number;
  retryCount: number;
};

export type WorkerRuntime = {
  fetch: typeof fetch;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => TimerHandle;
  cancel: (timer: TimerHandle) => void;
  requestId: () => string;
  log: (record: ProxyLogRecord) => void;
  terrainRouteTimeoutMs: number;
  terrainUpstreamTimeoutMs: number;
  overpassRouteTimeoutMs: number;
  overpassUpstreamTimeoutMs: number;
};

const defaultRuntime: WorkerRuntime = {
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (timer) => clearTimeout(timer),
  requestId: () => crypto.randomUUID(),
  log: (record) => console.log(JSON.stringify(record)),
  terrainRouteTimeoutMs: 12_000,
  terrainUpstreamTimeoutMs: 8_000,
  overpassRouteTimeoutMs: 22_000,
  overpassUpstreamTimeoutMs: 9_000,
};

type FailureCode =
  | "request_aborted"
  | "route_deadline"
  | "upstream_timeout"
  | "upstream_unreachable"
  | "upstream_rate_limited"
  | "upstream_unavailable"
  | "upstream_bad_response";

class ProxyFailure extends Error {
  readonly code: FailureCode;
  readonly status: 429 | 502 | 503 | 504;
  readonly retryable: boolean;
  readonly retryAfter: string;

  constructor(
    code: FailureCode,
    status: 429 | 502 | 503 | 504,
    message: string,
    options: { retryable?: boolean; retryAfter?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProxyFailure";
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? false;
    this.retryAfter = options.retryAfter ?? "30";
  }
}

type ResponseContext = {
  requestId: string;
  corsOrigin?: string;
};

function routeName(pathname: string): RouteName {
  if (pathname === "/health") return "health";
  if (pathname === "/overpass") return "overpass";
  if (pathname.startsWith("/terrain/")) return "terrain";
  return "unknown";
}

function corsHeaders(origin?: string, preflight = false): Headers {
  const headers = new Headers({ Vary: "Origin" });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set(
      "Access-Control-Expose-Headers",
      "Retry-After, X-Request-ID",
    );
  }
  if (preflight) {
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    headers.set("Access-Control-Max-Age", "600");
    headers.set(
      "Vary",
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
  }
  return headers;
}

function jsonResponse(
  data: unknown,
  status: number,
  context: ResponseContext,
  extraHeaders?: Record<string, string>,
): Response {
  const headers = corsHeaders(context.corsOrigin);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", CACHE_NONE);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(
  code: string,
  message: string,
  status: number,
  context: ResponseContext,
  retryAfter?: string,
): Response {
  return jsonResponse(
    { error: { code, message }, requestId: context.requestId },
    status,
    context,
    retryAfter ? { "Retry-After": retryAfter } : undefined,
  );
}

function failureResponse(failure: ProxyFailure, context: ResponseContext): Response {
  return errorResponse(
    failure.code,
    failure.message,
    failure.status,
    context,
    failure.retryAfter,
  );
}

function passThrough(
  upstream: Response,
  cacheControl: string,
  context: ResponseContext,
  body: BodyInit | null =
    upstream.status === 204 || upstream.status === 304 ? null : upstream.body,
): Response {
  const headers = corsHeaders(context.corsOrigin);
  headers.set("Cache-Control", cacheControl);
  const contentType = upstream.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  return new Response(body, { status: upstream.status, headers });
}

function validatePreflightTarget(url: URL): boolean {
  if (url.pathname === "/health") return url.search === "";
  if (url.pathname.startsWith("/terrain/")) {
    return url.search === "" && parseTerrainPath(url.pathname) !== null;
  }
  if (url.pathname === "/overpass") return parseCanonicalBbox(url.search).ok;
  return false;
}

function handlePreflight(
  request: Request,
  url: URL,
  context: ResponseContext,
): Response {
  if (!validatePreflightTarget(url)) {
    return errorResponse("invalid_preflight_target", "invalid preflight target", 400, context);
  }
  if (request.headers.get("Access-Control-Request-Method") !== "GET") {
    const response = errorResponse(
      "invalid_preflight_method",
      "only GET may be preflighted",
      405,
      context,
    );
    response.headers.set("Allow", "GET, OPTIONS");
    return response;
  }

  const requestedHeaders = (request.headers.get("Access-Control-Request-Headers") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((header) => header !== "content-type")) {
    return errorResponse(
      "invalid_preflight_headers",
      "requested headers are not allowed",
      400,
      context,
    );
  }

  const headers = corsHeaders(context.corsOrigin, true);
  headers.set("Cache-Control", CACHE_NONE);
  if (requestedHeaders.length > 0) {
    headers.set("Access-Control-Allow-Headers", "Content-Type");
  }
  return new Response(null, { status: 204, headers });
}

function createRouteSignal(
  requestSignal: AbortSignal,
  timeoutMs: number,
  runtime: WorkerRuntime,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onRequestAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(
        new ProxyFailure("request_aborted", 504, "request was aborted", {
          cause: requestSignal.reason,
        }),
      );
    }
  };
  if (requestSignal.aborted) onRequestAbort();
  else requestSignal.addEventListener("abort", onRequestAbort, { once: true });

  const timer = runtime.schedule(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        new ProxyFailure("route_deadline", 504, "proxy route deadline exceeded"),
      );
    }
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      runtime.cancel(timer);
      requestSignal.removeEventListener("abort", onRequestAbort);
    },
  };
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

type UpstreamLease = {
  response: Response;
  signal: AbortSignal;
  dispose: () => void;
};

async function fetchWithDeadline(
  runtime: WorkerRuntime,
  input: RequestInfo | URL,
  init: RequestInit,
  routeSignal: AbortSignal,
  timeoutMs: number,
): Promise<UpstreamLease> {
  const controller = new AbortController();
  const onRouteAbort = () => {
    if (!controller.signal.aborted) controller.abort(routeSignal.reason);
  };
  if (routeSignal.aborted) onRouteAbort();
  else routeSignal.addEventListener("abort", onRouteAbort, { once: true });

  const timer = runtime.schedule(() => {
    if (!controller.signal.aborted) {
      controller.abort(
        new ProxyFailure("upstream_timeout", 504, "upstream request timed out", {
          retryable: true,
        }),
      );
    }
  }, timeoutMs);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    runtime.cancel(timer);
    routeSignal.removeEventListener("abort", onRouteAbort);
  };

  try {
    const response = await raceWithSignal(
      runtime.fetch(input, { ...init, signal: controller.signal }),
      controller.signal,
    );
    // Keep both abort propagation and the per-upstream timer alive until the
    // handler has consumed or discarded the response body.
    return { response, signal: controller.signal, dispose };
  } catch (error) {
    dispose();
    if (controller.signal.aborted && controller.signal.reason instanceof ProxyFailure) {
      throw controller.signal.reason;
    }
    throw new ProxyFailure("upstream_unreachable", 502, "upstream is unreachable", {
      retryable: true,
      cause: error,
    });
  }
}

const MAX_TERRAIN_BODY_BYTES = 1024 * 1024;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function discardResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    cancellation?.catch(() => {
      // The mapped failure is authoritative; cancellation is best effort.
    });
  } catch {
    // A locked/already-consumed body is already owned by its reader.
  }
}

async function readResponseBody(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("Content-Length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    discardResponseBody(response);
    throw new ProxyFailure(
      "upstream_bad_response",
      502,
      "upstream response body exceeded the permitted size",
      { retryable: true },
    );
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await raceWithSignal(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ProxyFailure(
          "upstream_bad_response",
          502,
          "upstream response body exceeded the permitted size",
          { retryable: true },
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    const cancellation = reader.cancel(error);
    cancellation.catch(() => {});
    if (error instanceof ProxyFailure) throw error;
    if (signal.aborted && signal.reason instanceof ProxyFailure) {
      throw signal.reason;
    }
    throw new ProxyFailure(
      "upstream_unreachable",
      502,
      "upstream response body failed",
      { retryable: true, cause: error },
    );
  }

  reader.releaseLock();
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isValidTerrainPng(body: Uint8Array): boolean {
  if (body.byteLength < 57) return false;
  if (PNG_SIGNATURE.some((byte, index) => body[index] !== byte)) return false;

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let offset: number = PNG_SIGNATURE.length;
  let sawHeader = false;
  let sawData = false;
  while (offset + 12 <= body.byteLength) {
    const length = view.getUint32(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > body.byteLength) return false;
    const type = String.fromCharCode(
      body[offset + 4]!,
      body[offset + 5]!,
      body[offset + 6]!,
      body[offset + 7]!,
    );
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      if (view.getUint32(offset + 8) !== 256 || view.getUint32(offset + 12) !== 256) {
        return false;
      }
      sawHeader = true;
    } else if (type === "IDAT") {
      sawData = true;
    } else if (type === "IEND") {
      return length === 0 && sawData && chunkEnd === body.byteLength;
    }
    offset = chunkEnd;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isValidOverpassElement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!(["node", "way", "relation"] as unknown[]).includes(value.type)) return false;
  if (!isSafeInteger(value.id)) return false;
  if (
    value.lat !== undefined &&
    (typeof value.lat !== "number" || !Number.isFinite(value.lat))
  ) {
    return false;
  }
  if (
    value.lon !== undefined &&
    (typeof value.lon !== "number" || !Number.isFinite(value.lon))
  ) {
    return false;
  }
  if (
    value.nodes !== undefined &&
    (!Array.isArray(value.nodes) || !value.nodes.every(isSafeInteger))
  ) {
    return false;
  }
  if (value.tags !== undefined) {
    if (!isRecord(value.tags)) return false;
    if (!Object.values(value.tags).every((tag) => typeof tag === "string")) {
      return false;
    }
  }
  if (value.members !== undefined) {
    if (!Array.isArray(value.members)) return false;
    for (const member of value.members) {
      if (!isRecord(member)) return false;
      if (!(["node", "way", "relation"] as unknown[]).includes(member.type)) {
        return false;
      }
      if (!isSafeInteger(member.ref) || typeof member.role !== "string") {
        return false;
      }
    }
  }
  return true;
}

function isValidOverpassJson(body: Uint8Array): boolean {
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(body);
    const value = JSON.parse(decoded) as unknown;
    return (
      isRecord(value) &&
      Array.isArray(value.elements) &&
      value.elements.every(isValidOverpassElement)
    );
  } catch {
    return false;
  }
}

function upstreamFailure(response: Response): ProxyFailure {
  const retryAfter = sanitizeRetryAfter(response.headers.get("Retry-After"));
  if (response.status === 429) {
    return new ProxyFailure(
      "upstream_rate_limited",
      429,
      "upstream rate limit reached",
      { retryable: true, retryAfter },
    );
  }
  if (response.status === 503) {
    return new ProxyFailure("upstream_unavailable", 503, "upstream is unavailable", {
      retryable: true,
      retryAfter,
    });
  }
  if (response.status === 504) {
    return new ProxyFailure("upstream_timeout", 504, "upstream timed out", {
      retryable: true,
      retryAfter,
    });
  }
  return new ProxyFailure("upstream_bad_response", 502, "upstream returned an invalid response", {
    retryable: response.status >= 500,
    retryAfter,
  });
}

async function handleTerrain(
  request: Request,
  url: URL,
  env: Env,
  runtime: WorkerRuntime,
  telemetry: Telemetry,
  context: ResponseContext,
): Promise<Response> {
  if (url.search !== "") {
    return errorResponse(
      "unknown_query",
      "terrain does not accept query parameters",
      400,
      context,
    );
  }
  const tile = parseTerrainPath(url.pathname);
  if (!tile) {
    return errorResponse("invalid_tile", "invalid terrain tile coordinates", 400, context);
  }
  if (!enabledFlag(env.TERRAIN_ENABLED)) {
    return errorResponse(
      "terrain_disabled",
      "terrain route is disabled",
      503,
      context,
      "300",
    );
  }

  telemetry.upstream = "terrain";
  const route = createRouteSignal(
    request.signal,
    runtime.terrainRouteTimeoutMs,
    runtime,
  );
  try {
    const lease = await fetchWithDeadline(
      runtime,
      terrainUpstreamUrl(tile),
      { method: "GET", redirect: "error" },
      route.signal,
      runtime.terrainUpstreamTimeoutMs,
    );
    const upstream = lease.response;
    try {
      if (upstream.status === 200) {
        if (!isPngContentType(upstream.headers.get("Content-Type"))) {
          discardResponseBody(upstream);
          return failureResponse(
            new ProxyFailure(
              "upstream_bad_response",
              502,
              "terrain upstream returned a non-PNG response",
            ),
            context,
          );
        }
        const body = await readResponseBody(
          upstream,
          lease.signal,
          MAX_TERRAIN_BODY_BYTES,
        );
        if (!isValidTerrainPng(body)) {
          return failureResponse(
            new ProxyFailure(
              "upstream_bad_response",
              502,
              "terrain upstream returned a malformed PNG response",
            ),
            context,
          );
        }
        return passThrough(
          upstream,
          terrainCacheControl(upstream.status),
          context,
          body,
        );
      }
      if (upstream.status === 404) {
        // Negative terrain cache entries need only the status. Never retain an
        // upstream HTML/XML error document or let a slow error body outlive the attempt.
        discardResponseBody(upstream);
        return passThrough(upstream, terrainCacheControl(upstream.status), context, null);
      }
      discardResponseBody(upstream);
      return failureResponse(upstreamFailure(upstream), context);
    } finally {
      lease.dispose();
    }
  } catch (error) {
    return failureResponse(
      error instanceof ProxyFailure
        ? error
        : new ProxyFailure("upstream_unreachable", 502, "terrain upstream is unreachable", {
            cause: error,
          }),
      context,
    );
  } finally {
    route.dispose();
  }
}

async function handleOverpass(
  request: Request,
  url: URL,
  env: Env,
  runtime: WorkerRuntime,
  telemetry: Telemetry,
  context: ResponseContext,
): Promise<Response> {
  const parsed = parseCanonicalBbox(url.search);
  if (!parsed.ok) {
    return errorResponse("invalid_bbox", parsed.error, 400, context);
  }

  const requested = enabledFlag(env.OVERPASS_ENABLED);
  const protectionStaged = enabledFlag(env.OVERPASS_PROTECTION_STAGED);
  if (!requested || !protectionStaged) {
    return errorResponse(
      "overpass_disabled",
      "overpass route is disabled pending staged edge protection",
      503,
      context,
      "300",
    );
  }

  const query = buildOverpassQuery(parsed.bounds);
  const route = createRouteSignal(
    request.signal,
    runtime.overpassRouteTimeoutMs,
    runtime,
  );
  const endpoints = [
    { url: OVERPASS_PRIMARY, name: "overpass-primary" as const },
    { url: OVERPASS_MIRROR, name: "overpass-mirror" as const },
  ];
  let lastFailure: ProxyFailure | undefined;

  try {
    for (let index = 0; index < endpoints.length; index++) {
      const endpoint = endpoints[index]!;
      telemetry.upstream = endpoint.name;
      telemetry.retryCount = index;
      try {
        const lease = await fetchWithDeadline(
          runtime,
          endpoint.url,
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ data: query }).toString(),
            redirect: "error",
          },
          route.signal,
          runtime.overpassUpstreamTimeoutMs,
        );
        const upstream = lease.response;
        try {
          if (upstream.status === 200) {
            if (!isJsonContentType(upstream.headers.get("Content-Type"))) {
              discardResponseBody(upstream);
              lastFailure = new ProxyFailure(
                "upstream_bad_response",
                502,
                "overpass upstream returned a non-JSON response",
                { retryable: true },
              );
            } else {
              const body = await readResponseBody(
                upstream,
                lease.signal,
                OVERPASS_MAXSIZE_BYTES,
              );
              if (isValidOverpassJson(body)) {
                return passThrough(upstream, CACHE_OVERPASS_OK, context, body);
              }
              lastFailure = new ProxyFailure(
                "upstream_bad_response",
                502,
                "overpass upstream returned malformed JSON",
                { retryable: true },
              );
            }
          } else {
            discardResponseBody(upstream);
            lastFailure = upstreamFailure(upstream);
            if (!shouldRetryOverpass(upstream.status)) break;
          }
        } finally {
          lease.dispose();
        }
      } catch (error) {
        lastFailure =
          error instanceof ProxyFailure
            ? error
            : new ProxyFailure(
                "upstream_unreachable",
                502,
                "overpass upstream is unreachable",
                { retryable: true, cause: error },
              );
      }

      if (!lastFailure.retryable || route.signal.aborted) break;
    }

    return failureResponse(
      lastFailure ??
        new ProxyFailure("upstream_unreachable", 502, "overpass upstream is unreachable"),
      context,
    );
  } finally {
    route.dispose();
  }
}

function handleHealth(url: URL, env: Env, context: ResponseContext): Response {
  if (url.search !== "") {
    return errorResponse("unknown_query", "health does not accept query parameters", 400, context);
  }
  const terrainEnabled = enabledFlag(env.TERRAIN_ENABLED);
  const overpassRequested = enabledFlag(env.OVERPASS_ENABLED);
  const protectionStaged = enabledFlag(env.OVERPASS_PROTECTION_STAGED);
  const overpassEnabled = overpassRequested && protectionStaged;
  const configurationSafe = !overpassRequested || protectionStaged;

  return jsonResponse(
    {
      ok: configurationSafe,
      service: "strata-proxy",
      build: sanitizeBuildId(env.BUILD_ID),
      limits: {
        maxBboxKm2: MAX_BBOX_KM2,
        maxBboxSpanKm: MAX_BBOX_SPAN_KM,
      },
      routes: {
        terrain: { enabled: terrainEnabled },
        overpass: { enabled: overpassEnabled },
      },
    },
    configurationSafe ? 200 : 503,
    context,
    configurationSafe ? undefined : { "Retry-After": "300" },
  );
}

async function dispatch(
  request: Request,
  env: Env,
  runtime: WorkerRuntime,
  telemetry: Telemetry,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const originAllowed = isAllowedOrigin(origin, allowedOrigins);
  const context: ResponseContext = {
    requestId: telemetry.requestId,
    corsOrigin: originAllowed && origin !== null ? origin : undefined,
  };

  if (!originAllowed) {
    return errorResponse("origin_forbidden", "request origin is not allowed", 403, context);
  }
  if (request.method === "OPTIONS") return handlePreflight(request, url, context);
  if (request.method !== "GET") {
    const response = errorResponse(
      "method_not_allowed",
      "method not allowed",
      405,
      context,
    );
    response.headers.set("Allow", "GET, OPTIONS");
    return response;
  }

  if (url.pathname === "/health") return handleHealth(url, env, context);
  if (url.pathname.startsWith("/terrain/")) {
    return handleTerrain(request, url, env, runtime, telemetry, context);
  }
  if (url.pathname === "/overpass") {
    return handleOverpass(request, url, env, runtime, telemetry, context);
  }
  return errorResponse("not_found", "route not found", 404, context);
}

export function createWorker(
  overrides: Partial<WorkerRuntime> = {},
): ExportedHandler<Env> {
  const runtime: WorkerRuntime = { ...defaultRuntime, ...overrides };
  return {
    async fetch(request, env, _ctx): Promise<Response> {
      const startedAt = runtime.now();
      const telemetry: Telemetry = {
        requestId: runtime.requestId(),
        route: routeName(new URL(request.url).pathname),
        upstream: "none",
        retryCount: 0,
      };
      let response: Response;
      try {
        response = await dispatch(request, env, runtime, telemetry);
      } catch {
        const origin = request.headers.get("Origin");
        const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
        const corsOrigin =
          origin !== null && isAllowedOrigin(origin, allowedOrigins)
            ? origin
            : undefined;
        response = errorResponse(
          "internal_error",
          "proxy request failed",
          502,
          { requestId: telemetry.requestId, corsOrigin },
          "30",
        );
      }
      response.headers.set("X-Request-ID", telemetry.requestId);
      runtime.log({
        event: "proxy_request",
        requestId: telemetry.requestId,
        route: telemetry.route,
        upstream: telemetry.upstream,
        status: response.status,
        durationMs: Math.max(0, runtime.now() - startedAt),
        retryCount: telemetry.retryCount,
      });
      return response;
    },
  };
}

export default createWorker();
