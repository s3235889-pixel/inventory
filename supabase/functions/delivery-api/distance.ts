// Geoapify is called only by the Edge Function. Never log request URLs, keys,
// tokens, or customer addresses. This service does not access the DB or Storage.
// Official contracts: https://apidocs.geoapify.com/docs/geocoding/
//                     https://apidocs.geoapify.com/docs/routing/
export const DELIVERY_ORIGINS: Readonly<Record<number, string>> = Object.freeze({
  1: '屏東縣潮州鎮文化路42號',
  2: '屏東縣潮州鎮東華路25號',
});
const MODE = 'scooter' as const;
const PROVIDER = 'geoapify' as const;
const MIN_CONFIDENCE = 0.95;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const ORIGIN_TTL_MS = 15 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const TOKEN_LIMIT = 12;
const STORE_LIMIT = 30;
const encoder = new TextEncoder();

export type DistanceServiceInfo = {
  available: boolean; origin_address: string; mode: typeof MODE; provider: typeof PROVIDER;
};
export type DistanceResult = {
  distance_km: number; address: string; matched_address: string;
  origin_address: string; mode: typeof MODE; provider: typeof PROVIDER; estimated: true;
};
export type DistanceService = {
  info: (store: number) => DistanceServiceInfo;
  calculate: (store: number, address: string, sessionKey: string) => Promise<DistanceResult>;
};
type DistanceCode = 'distance_unavailable' | 'distance_address_invalid' | 'distance_no_route' | 'distance_rate_limited';
export class DistanceError extends Error {
  status: 422 | 429 | 503;
  code: DistanceCode;
  retryAfter?: number;
  constructor(message: string, status: 422 | 429 | 503, code: DistanceCode, retryAfter?: number) {
    super(message); this.name = 'DistanceError'; this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}
type Options = {
  apiKey?: string | (() => string | undefined);
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheMaxEntries?: number;
  onDiagnostic?: (event: DistanceDiagnostic) => void;
};
type DiagnosticPhase = 'input' | 'origin' | 'destination' | 'route' | 'pipeline';
type DiagnosticReason = 'address_parse' | 'no_candidates' | 'candidate_validation' | 'ambiguous_candidates'
  | 'http_error' | 'transport_error' | 'response_shape' | 'response_size' | 'response_body'
  | 'deadline' | 'route_validation' | 'sensitive_provider_value';
type DiagnosticContext = { store_id: number; phase: DiagnosticPhase };
type DiagnosticCandidate = { checks: Record<string, boolean>; fields?: Record<string, unknown> };
type RouteShape = {
  results_array: boolean; results_count: number; route_object: boolean;
  unit: 'meters' | 'miles' | 'missing' | 'other'; distance_type: 'number' | 'string' | 'missing' | 'other';
  distance_finite: boolean; distance_in_range: boolean;
  legs_array: boolean; legs_count: number; first_leg_object: boolean;
};
export type DistanceDiagnostic = DiagnosticContext & {
  reason: DiagnosticReason; http_status?: number; candidate_count?: number;
  public_address_store?: number; candidates?: DiagnosticCandidate[]; separation_m?: number; route_shape?: RouteShape;
};
type Location = { lat: number; lon: number; formatted: string };
type AddressParts = { county: string; district: string; street: string; house: string };
type Cached<T> = { value: T; expires: number };
type CachedRoute = Pick<DistanceResult, 'distance_km' | 'matched_address'>;
type RateWindow = { count: number; expires: number };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function unavailable(message = '暫時無法自動計算機車距離，請稍後重試，或手動輸入公里數。'): DistanceError {
  return new DistanceError(message, 503, 'distance_unavailable');
}
function invalidAddress(message = '無法確認完整的臺灣外送地址，請補上縣市、道路與數字門牌，或手動輸入公里數。'): DistanceError {
  return new DistanceError(message, 422, 'distance_address_invalid');
}
function noRoute(): DistanceError {
  return new DistanceError('找不到可確認的臺灣機車道路路線，請確認地址，或手動輸入公里數。', 422, 'distance_no_route');
}
function limited(seconds: number): DistanceError {
  return new DistanceError('距離查詢較頻繁，請稍候再試，或手動輸入公里數。', 429, 'distance_rate_limited', seconds);
}
function normalizedAddress(address: string): string {
  return address.normalize('NFKC').replace(/\s+/g, ' ').trim();
}
function houseNumber(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').replace(/\s|號/g, '').replace(/之/g, '-');
  if (!/^\d+(?:-\d+)*$/.test(normalized)) return null;
  return normalized.split('-').map(part => String(Number(part))).join('-');
}
function requestedHouse(address: string): string | null {
  const value = normalizedAddress(address);
  const matches = [...value.matchAll(/(\d+(?:[-之]\d+)*)號(?:之(\d+))?/g)];
  if (matches.length === 1) return houseNumber(matches[0][1] + (matches[0][2] ? `-${matches[0][2]}` : ''));
  const english = /\bno\.?\s*(\d+(?:-\d+)*)\b/i.exec(value);
  return matches.length === 0 && english ? houseNumber(english[1]) : null;
}
function canonicalComponent(value: unknown): string {
  if (typeof value !== 'string') return '';
  const equivalents: Record<string, string> = { '臺': '台', '县': '縣', '乡': '鄉', '镇': '鎮', '区': '區', '东': '東', '华': '華', '号': '號' };
  return value.normalize('NFKC').replace(/\s/g, '').replace(/[臺县乡镇区东华号]/g, char => equivalents[char]);
}
function addressParts(address: string): AddressParts | null {
  // Support clear, common Chinese street addresses. Unusual/rural forms remain
  // manual rather than guessing a different town, road, lane or house number.
  const text = canonicalComponent(address).replace(/^\d{3,6}/, '').replace(/^(?:中華民國)?台灣(?:省)?/, '');
  const administration = /^([\p{Script=Han}]{2,5}[縣市])([\p{Script=Han}]{1,6}[鄉鎮市區])/u.exec(text);
  if (!administration) return null;
  const rest = text.slice(administration[0].length).replace(/^[\p{Script=Han}]{1,8}[里村]/u, '').replace(/^\d+鄰/, '');
  const street = /^([\p{Script=Han}\d]{1,30}?(?:大道|路|街)(?:[一二三四五六七八九十百\d]+段)?(?:\d+巷)?(?:\d+弄)?)/u.exec(rest)?.[1];
  if (!street) return null;
  // Do not silently skip an unsupported lane or other text between the road
  // and house, e.g. 文化路十巷42號 must not become 文化路42號.
  const immediateHouse = /^(\d+(?:[-之]\d+)*)號(?:之(\d+))?/.exec(rest.slice(street.length));
  const house = immediateHouse ? houseNumber(immediateHouse[1] + (immediateHouse[2] ? `-${immediateHouse[2]}` : '')) : null;
  return house && requestedHouse(text) === house
    ? { county: administration[1], district: administration[2], street, house } : null;
}
function confidence(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_CONFIDENCE && value <= 1;
}
function countryTW(value: unknown): boolean { return typeof value === 'string' && value.toLowerCase() === 'tw'; }
function countriesTW(value: unknown): boolean { return Array.isArray(value) && value.length > 0 && value.every(countryTW); }
function diagnosticString(value: unknown, key: string, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Inspect the complete string before truncating; never copy URLs or a key
  // echoed inside provider fields into logs, even for public-address probes.
  if ((key && value.includes(key)) || /https?:|:\/\/|apiKey\s*=|^\s*(?:www\.|\/)|[a-z0-9-]+\.[a-z]{2,}(?:[\/:?#]|$)/i.test(value)) return '[redacted]';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}
function candidateSeparationMeters(values: unknown[]): number | undefined {
  // Public-store diagnostics only: report candidate disagreement, never raw
  // coordinates. This is not used as a route or as a substitute for confidence.
  const points = values.slice(0, 5).filter((value): value is Record<string, number> => object(value)
    && typeof value.lat === 'number' && Number.isFinite(value.lat) && value.lat >= 20 && value.lat <= 27
    && typeof value.lon === 'number' && Number.isFinite(value.lon) && value.lon >= 116 && value.lon <= 124);
  if (points.length < 2) return undefined;
  const radians = Math.PI / 180;
  let maximum = 0;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const a = points[i], b = points[j];
    const arc = Math.sin((a.lat - b.lat) * radians / 2) ** 2
      + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin((a.lon - b.lon) * radians / 2) ** 2;
    maximum = Math.max(maximum, 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, arc))));
  }
  return Math.round(maximum * 10) / 10;
}
function geocodeDiagnostic(data: unknown, address: string, key: string, context: DiagnosticContext): DistanceDiagnostic {
  const requested = addressParts(address);
  if (!requested) return { ...context, reason: 'address_parse' };
  if (!object(data) || !Array.isArray(data.results)) return { ...context, reason: 'response_shape' };
  // Exact equality is intentional: added floors, notes, alternate spellings or
  // customer addresses must never enable detailed candidate logging.
  const publicStore = Number(Object.entries(DELIVERY_ORIGINS).find(([, value]) => value === address)?.[0] || 0);
  const candidates: DiagnosticCandidate[] = data.results.slice(0, 5).map(value => {
    const result = object(value) ? value : {};
    const rank = object(result.rank) ? result.rank : {};
    const administration = ['state', 'county', 'city', 'district', 'suburb', 'town', 'municipality']
      .map(field => canonicalComponent(result[field]));
    const candidate: DiagnosticCandidate = { checks: {
      object: object(value), rank: object(result.rank), country: countryTW(result.country_code),
      type: ['building', 'amenity'].includes(String(result.result_type)),
      house: houseNumber(result.housenumber) === requested.house,
      street: canonicalComponent(result.street) === requested.street,
      county: administration.includes(requested.county), district: administration.includes(requested.district),
      confidence: confidence(rank.confidence), match_type: ['full_match', 'match_by_building'].includes(String(rank.match_type)),
      component_confidence: ['confidence_city_level', 'confidence_street_level', 'confidence_building_level']
        .every(field => rank[field] === undefined || confidence(rank[field])),
      coordinates: typeof result.lat === 'number' && Number.isFinite(result.lat) && result.lat >= 20 && result.lat <= 27
        && typeof result.lon === 'number' && Number.isFinite(result.lon) && result.lon >= 116 && result.lon <= 124,
      formatted: typeof result.formatted === 'string' && !!result.formatted.trim() && result.formatted.length <= 600
        && !/[\u0000-\u001f\u007f]/.test(result.formatted),
    } };
    if (publicStore) {
      const admin: Record<string, string> = {};
      for (const field of ['state', 'county', 'city', 'district', 'suburb', 'town', 'municipality']) {
        const text = diagnosticString(result[field], key, 40);
        if (text !== undefined) admin[field] = text;
      }
      const scores: Record<string, number | string> = {};
      for (const field of ['confidence', 'confidence_city_level', 'confidence_street_level', 'confidence_building_level']) {
        if (typeof rank[field] === 'number' && Number.isFinite(rank[field]) && rank[field] >= 0 && rank[field] <= 1) scores[field] = rank[field];
      }
      const match = diagnosticString(rank.match_type, key, 32);
      if (match !== undefined) scores.match_type = match;
      candidate.fields = {
        country_code: diagnosticString(result.country_code, key, 8), result_type: diagnosticString(result.result_type, key, 24),
        housenumber: diagnosticString(result.housenumber, key, 24), street: diagnosticString(result.street, key, 64), admin, rank: scores,
      };
    }
    return candidate;
  });
  const accepted = candidates.filter(candidate => Object.values(candidate.checks).every(Boolean)).length;
  const separation = publicStore ? candidateSeparationMeters(data.results) : undefined;
  return { ...context, reason: !data.results.length ? 'no_candidates' : accepted > 1 ? 'ambiguous_candidates' : 'candidate_validation',
    candidate_count: Math.min(data.results.length, 1000), ...(publicStore ? { public_address_store: publicStore } : {}),
    ...(separation !== undefined ? { separation_m: separation } : {}), candidates };
}
function locationFromGeocode(data: unknown, address: string): Location {
  if (!object(data) || !Array.isArray(data.results)) throw unavailable();
  const requested = addressParts(address);
  if (!requested) throw invalidAddress();
  const accepted = new Map<string, Location>();
  for (const result of data.results.slice(0, 5)) {
    if (!object(result) || !object(result.rank) || !countryTW(result.country_code)
      || !['building', 'amenity'].includes(String(result.result_type))
      || houseNumber(result.housenumber) !== requested.house
      || canonicalComponent(result.street) !== requested.street
      || !confidence(result.rank.confidence)
      || !['full_match', 'match_by_building'].includes(String(result.rank.match_type))) continue;
    const administration = ['state', 'county', 'city', 'district', 'suburb', 'town', 'municipality']
      .map(field => canonicalComponent(result[field]));
    if (!administration.includes(requested.county) || !administration.includes(requested.district)) continue;
    // Geoapify may omit per-component scores; when provided they must agree.
    const rank = result.rank;
    if (['confidence_city_level', 'confidence_street_level', 'confidence_building_level']
      .some(key => rank[key] !== undefined && !confidence(rank[key]))) continue;
    if (typeof result.lat !== 'number' || !Number.isFinite(result.lat) || result.lat < 20 || result.lat > 27
      || typeof result.lon !== 'number' || !Number.isFinite(result.lon) || result.lon < 116 || result.lon > 124
      || typeof result.formatted !== 'string' || !result.formatted.trim() || result.formatted.length > 600
      || /[\u0000-\u001f\u007f]/.test(result.formatted)) continue;
    const location = { lat: result.lat, lon: result.lon, formatted: result.formatted.trim() };
    accepted.set(`${location.lat.toFixed(5)},${location.lon.toFixed(5)}`, location);
  }
  if (accepted.size !== 1) throw invalidAddress(accepted.size > 1
    ? '此地址找到多個可能門牌，請補上完整縣市與地址，或手動輸入公里數。' : undefined);
  return [...accepted.values()][0];
}
function routeUnit(value: unknown): RouteShape['unit'] {
  if (value === undefined || value === null) return 'missing';
  if (typeof value !== 'string' || value.length > 6) return 'other';
  const unit = value.toLowerCase();
  return unit === 'meters' || unit === 'miles' ? unit : 'other';
}
function routeShape(data: unknown): RouteShape {
  // Only fixed enums, booleans and bounded counts leave this function. Never
  // copy provider properties, geometry, instructions, or arbitrary unit text.
  const results = object(data) && Array.isArray(data.results) ? data.results : null;
  const first = results?.[0];
  const route = object(first) ? first : {};
  const legs = Array.isArray(route.legs) ? route.legs : null;
  return {
    results_array: results !== null, results_count: Math.min(results?.length || 0, 1000), route_object: object(first),
    unit: routeUnit(route.distance_units),
    distance_type: typeof route.distance === 'number' ? 'number' : typeof route.distance === 'string' ? 'string'
      : route.distance === undefined || route.distance === null ? 'missing' : 'other',
    distance_finite: typeof route.distance === 'number' && Number.isFinite(route.distance),
    distance_in_range: typeof route.distance === 'number' && Number.isFinite(route.distance)
      && route.distance >= 0 && route.distance <= 99999990,
    legs_array: legs !== null, legs_count: Math.min(legs?.length || 0, 1000), first_leg_object: object(legs?.[0]),
  };
}
function routeDistance(data: unknown, origin: Location, destination: Location): number {
  if (!object(data) || !Array.isArray(data.results)) throw unavailable();
  if (!data.results.length) throw noRoute();
  const route = data.results[0];
  // Letter case does not change the unit; all non-meter units still fail.
  if (!object(route) || routeUnit(route.distance_units) !== 'meters'
    || typeof route.distance !== 'number' || !Number.isFinite(route.distance)
    || route.distance < 0 || route.distance > 99999990
    || !Array.isArray(route.legs) || route.legs.length !== 1 || !object(route.legs[0])) throw unavailable();
  // Country filtering geocoding alone is not enough: require the countries of
  // the complete returned road route, requested with details=admin_areas.
  if (!countriesTW(route.country_code) || !countriesTW(route.legs[0].country_code)
    || !Array.isArray(route.admin_areas) || !route.admin_areas.length
    || route.admin_areas.some(area => !object(area) || !countryTW(area.country_code))) throw noRoute();
  if (route.ferry === true || (Array.isArray(route.legs[0].steps) && route.legs[0].steps.some(step => object(step) && step.ferry === true))) throw noRoute();
  if (route.distance === 0 && (Math.abs(origin.lat - destination.lat) > 0.00001 || Math.abs(origin.lon - destination.lon) > 0.00001)) throw noRoute();
  return Math.round(route.distance / 10) / 100;
}

export function createDistanceService(options: Options = {}): DistanceService {
  const fetcher = options.fetcher || fetch;
  const now = options.now || Date.now;
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxEntries = Math.max(1, Math.min(options.cacheMaxEntries ?? 128, 128));
  const routes = new Map<string, Cached<CachedRoute>>();
  const origins = new Map<number, Cached<Location>>();
  const inFlight = new Map<string, Promise<CachedRoute>>();
  const active = new Map<number, number>();
  const tokenWindows = new Map<string, RateWindow>();
  const storeWindows = new Map<number, RateWindow>();
  const cacheKey = crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  let previousKey = '', configurationVersion = 0;
  function diagnostic(event: DistanceDiagnostic) {
    // Logging must neither break routing nor expose an Error/Request object.
    try { options.onDiagnostic?.(event); } catch { /* Keep the original result. */ }
  }
  function configuredKey(): string {
    // Read the getter on every request, so adding/rotating a secret does not
    // permanently leave a warm instance advertising available:false.
    let value: string | undefined;
    try { value = typeof options.apiKey === 'function' ? options.apiKey() : options.apiKey; }
    catch { value = undefined; }
    const key = typeof value === 'string' ? value.trim() : '';
    if (key !== previousKey) {
      previousKey = key; configurationVersion++;
      origins.clear(); routes.clear();
    }
    return key;
  }
  function info(store: number): DistanceServiceInfo {
    return { available: !!configuredKey() && Object.hasOwn(DELIVERY_ORIGINS, store),
      origin_address: DELIVERY_ORIGINS[store] || '', mode: MODE, provider: PROVIDER };
  }
  function takeRate(store: number, sessionKey: string) {
    const time = now();
    for (const [key, value] of tokenWindows) if (value.expires <= time) tokenWindows.delete(key);
    const perStore = storeWindows.get(store);
    const perToken = tokenWindows.get(`${store}/${sessionKey}`);
    const storeWindow = perStore && perStore.expires > time ? perStore : { count: 0, expires: time + RATE_WINDOW_MS };
    const tokenWindow = perToken && perToken.expires > time ? perToken : { count: 0, expires: time + RATE_WINDOW_MS };
    if (storeWindow.count >= STORE_LIMIT || tokenWindow.count >= TOKEN_LIMIT) {
      throw limited(Math.max(1, Math.ceil(((tokenWindow.count >= TOKEN_LIMIT ? tokenWindow : storeWindow).expires - time) / 1000)));
    }
    storeWindow.count++; tokenWindow.count++;
    storeWindows.set(store, storeWindow);
    tokenWindows.set(`${store}/${sessionKey}`, tokenWindow);
    while (tokenWindows.size > 256) tokenWindows.delete(tokenWindows.keys().next().value!);
  }
  async function privateCacheKey(value: string): Promise<string> {
    const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', await cacheKey, encoder.encode(value)));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function requestJson(url: URL, signal: AbortSignal, kind: 'geocode' | 'route', context: DiagnosticContext): Promise<unknown> {
    if (signal.aborted) throw unavailable();
    let response: Response;
    try { response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, signal, redirect: 'error' }); }
    catch { if (!signal.aborted) diagnostic({ ...context, reason: 'transport_error' }); throw unavailable(); }
    if (signal.aborted) throw unavailable();
    if (!response.ok) {
      diagnostic({ ...context, reason: 'http_error', http_status: response.status });
      if (response.status === 429) {
        const retry = Number(response.headers.get('retry-after'));
        throw limited(Number.isFinite(retry) && retry > 0 ? Math.min(Math.ceil(retry), 60) : 30);
      }
      if ([400, 404, 422].includes(response.status)) throw kind === 'route' ? noRoute() : invalidAddress();
      throw unavailable();
    }
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES || !response.body) {
      diagnostic({ ...context, reason: 'response_size' }); throw unavailable();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (signal.aborted) throw unavailable();
        if (done) break;
        length += value.length;
        if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw unavailable(); }
        chunks.push(value);
      }
    } catch { if (!signal.aborted) diagnostic({ ...context, reason: 'response_body' }); throw unavailable(); }
    finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { diagnostic({ ...context, reason: 'response_shape' }); throw unavailable(); }
  }
  async function geocode(address: string, key: string, signal: AbortSignal, context: DiagnosticContext): Promise<Location> {
    const requested = addressParts(address);
    if (!requested) { diagnostic({ ...context, reason: 'address_parse' }); throw invalidAddress(); }
    const url = new URL('https://api.geoapify.com/v1/geocode/search');
    // Structured input avoids a second, free-form Chinese address parser. The
    // provider has no county input; county is still strictly checked below.
    // Do not send text together with these fields, or guess county as state.
    url.search = new URLSearchParams({ housenumber: requested.house, street: requested.street,
      city: requested.district, country: 'Taiwan', filter: 'countrycode:tw', lang: 'zh', limit: '5', format: 'json', apiKey: key }).toString();
    const data = await requestJson(url, signal, 'geocode', context);
    let result: Location;
    try { result = locationFromGeocode(data, address); }
    catch (error) { diagnostic(geocodeDiagnostic(data, address, key, context)); throw error; }
    if (result.formatted.includes(key)) { diagnostic({ ...context, reason: 'sensitive_provider_value' }); throw unavailable(); }
    return result;
  }
  async function calculateFresh(store: number, address: string, key: string, version: number): Promise<CachedRoute> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        diagnostic({ store_id: store, phase: 'pipeline', reason: 'deadline' });
        controller.abort(); reject(unavailable('機車距離計算逾時，請稍後重試，或手動輸入公里數。'));
      }, timeoutMs);
    });
    const work = async (): Promise<CachedRoute> => {
      const cachedOrigin = origins.get(store);
      const getOrigin = cachedOrigin && cachedOrigin.expires > now() ? Promise.resolve(cachedOrigin.value)
        : geocode(DELIVERY_ORIGINS[store], key, controller.signal, { store_id: store, phase: 'origin' }).then(value => {
          if (version === configurationVersion && !controller.signal.aborted) origins.set(store, { value, expires: now() + ORIGIN_TTL_MS });
          return value;
        }).catch(error => {
          if (error instanceof DistanceError && error.status === 429) throw error;
          throw unavailable('門市起點暫時無法確認，請稍後重試，或手動輸入公里數。');
        });
      const [origin, destination] = await Promise.all([getOrigin, geocode(address, key, controller.signal, { store_id: store, phase: 'destination' })]);
      const url = new URL('https://api.geoapify.com/v1/routing');
      url.search = new URLSearchParams({ waypoints: `${origin.lat},${origin.lon}|${destination.lat},${destination.lon}`,
        mode: MODE, type: 'balanced', units: 'metric', format: 'json', details: 'admin_areas', avoid: 'ferries', apiKey: key }).toString();
      const data = await requestJson(url, controller.signal, 'route', { store_id: store, phase: 'route' });
      let distance: number;
      try { distance = routeDistance(data, origin, destination); }
      catch (error) { diagnostic({ store_id: store, phase: 'route', reason: 'route_validation', route_shape: routeShape(data) }); throw error; }
      return { distance_km: distance, matched_address: destination.formatted };
    };
    try { return await Promise.race([work(), deadline]); }
    catch (error) { if (error instanceof DistanceError) throw error; throw unavailable(); }
    finally { clearTimeout(timer!); controller.abort(); }
  }
  async function calculate(store: number, address: string, sessionKey: string): Promise<DistanceResult> {
    const key = configuredKey();
    if (!Object.hasOwn(DELIVERY_ORIGINS, store) || !key) throw unavailable('自動機車距離尚未啟用，請先手動輸入公里數。');
    if (typeof address !== 'string' || !address.trim() || [...address.trim()].length > 300
      || /[\u0000-\u001f\u007f]/.test(address) || !addressParts(address)) {
      diagnostic({ store_id: store, phase: 'input', reason: 'address_parse' }); throw invalidAddress();
    }
    const submittedAddress = address.trim();
    takeRate(store, sessionKey);
    const version = configurationVersion;
    const lookup = await privateCacheKey(`${version}|${store}|${MODE}|${normalizedAddress(submittedAddress)}`);
    for (const [entry, value] of routes) if (value.expires <= now()) routes.delete(entry);
    let result = routes.get(lookup)?.value;
    if (!result) {
      let pending = inFlight.get(lookup);
      if (!pending) {
        if ((active.get(store) || 0) >= 2) throw limited(2);
        active.set(store, (active.get(store) || 0) + 1);
        pending = calculateFresh(store, submittedAddress, key, version).then(value => {
          if (version === configurationVersion) {
            routes.set(lookup, { value, expires: now() + CACHE_TTL_MS });
            while (routes.size > maxEntries) routes.delete(routes.keys().next().value!);
          }
          return value;
        }).finally(() => { inFlight.delete(lookup); active.set(store, (active.get(store) || 1) - 1); });
        inFlight.set(lookup, pending);
      }
      result = await pending;
    }
    // Always echo this caller's address, not the spelling of a cached request.
    return { ...result, address: submittedAddress, origin_address: DELIVERY_ORIGINS[store], mode: MODE, provider: PROVIDER, estimated: true };
  }
  return { info, calculate };
}
