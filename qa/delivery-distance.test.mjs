// All HTTP responses are mocked. No key or customer address leaves this process.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createDistanceService, DELIVERY_ORIGINS, DistanceError } from '../supabase/functions/delivery-api/distance.ts';

const KEY = 'distance-tests-only-not-a-real-key';
const DESTINATION = '屏東縣潮州鎮測試路99號';
const NOW = 1795190400000;
function geocodeAddress(url) {
  if (url.pathname !== '/v1/geocode/search') return '';
  const params = url.searchParams;
  return `屏東縣${params.get('city')}${params.get('street')}${params.get('housenumber')}號`;
}
function location(address) {
  const store = Number(Object.entries(DELIVERY_ORIGINS).find(([, value]) => value === address)?.[0] || 0);
  return {
    country_code: 'tw', county: '屏東縣', city: '潮州鎮', result_type: 'building', housenumber: /([\d之-]+)號/.exec(address)?.[1] || '99',
    street: store === 1 ? '文化路' : store === 2 ? '東華路' : '測試路',
    lat: store === 1 ? 22.55 : store === 2 ? 22.56 : 22.57,
    lon: store === 1 ? 120.54 : store === 2 ? 120.55 : 120.56,
    formatted: address,
    rank: { confidence: 1, confidence_city_level: 1, confidence_street_level: 1, match_type: 'full_match' },
  };
}
function route() {
  return { distance: 3245, distance_units: 'Meters', country_code: ['tw'], admin_areas: [{ country_code: 'tw' }],
    legs: [{ country_code: ['tw'], steps: [] }], ferry: false };
}
function fixture(options = {}) {
  const calls = [];
  const diagnostics = [];
  let time = NOW;
  const fetcher = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (options.response) {
      const response = await options.response(url, init);
      if (response) return response;
    }
    if (url.pathname === '/v1/geocode/search') {
      const address = geocodeAddress(url);
      const result = { ...location(address), street: url.searchParams.get('street'),
        city: url.searchParams.get('city'), housenumber: url.searchParams.get('housenumber') };
      return Response.json({ results: options.geocode ? options.geocode(result, address) : [result] });
    }
    assert.equal(url.pathname, '/v1/routing');
    return Response.json({ results: options.route ? options.route(route()) : [route()] });
  };
  const service = createDistanceService({ apiKey: options.apiKey ?? KEY, fetcher, now: () => time,
    timeoutMs: options.timeoutMs, cacheMaxEntries: options.cacheMaxEntries,
    onDiagnostic: event => { diagnostics.push(event); options.onDiagnostic?.(event); } });
  return { service, calls, diagnostics, advance: ms => { time += ms; },
    calculate: (address = DESTINATION, store = 1, session = 'session-hash-test-only') => service.calculate(store, address, session) };
}
async function rejectsCode(promise, code, status) {
  await assert.rejects(promise, error => error instanceof DistanceError && error.code === code && error.status === status);
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await nextTurn(); }
  assert.fail('mock did not reach the expected state');
}

test('缺少金鑰時不呼叫provider，metadata保留兩店固定起點', async () => {
  const { service, calls, calculate } = fixture({ apiKey: '' });
  for (const store of [1, 2]) assert.deepEqual(service.info(store), {
    available: false, origin_address: DELIVERY_ORIGINS[store], mode: 'scooter', provider: 'geoapify',
  });
  await rejectsCode(calculate(), 'distance_unavailable', 503);
  assert.deepEqual(calls, []);
});
test('同一warm instance新增或輪換secret後會重新讀取，不鎖死unavailable', async () => {
  let key = '';
  const { service, calls, calculate } = fixture({ apiKey: () => key });
  assert.equal(service.info(1).available, false);
  await rejectsCode(calculate(), 'distance_unavailable', 503);
  key = KEY;
  assert.equal(service.info(1).available, true);
  assert.equal((await calculate()).distance_km, 3.25);
  key = 'rotated-distance-tests-only-key';
  assert.equal((await calculate()).distance_km, 3.25);
  assert.equal(calls.length, 6);
  assert.ok(calls.slice(3).every(call => call.url.searchParams.get('apiKey') === key));
  key = '';
  assert.equal(service.info(1).available, false);
  await rejectsCode(calculate(), 'distance_unavailable', 503);
});
for (const store of [1, 2]) {
  test(`門市${store}使用固定起點、scooter與公尺，換算單程公里兩位小數`, async () => {
    const { calculate, calls } = fixture();
    const result = await calculate(` ${DESTINATION} `, store);
    assert.deepEqual(result, { distance_km: 3.25, address: DESTINATION, matched_address: DESTINATION,
      origin_address: DELIVERY_ORIGINS[store], mode: 'scooter', provider: 'geoapify', estimated: true });
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.url.origin === 'https://api.geoapify.com' && call.init.redirect === 'error'));
    const geocodes = calls.filter(call => call.url.pathname === '/v1/geocode/search');
    assert.deepEqual(new Set(geocodes.map(call => geocodeAddress(call.url))), new Set([DELIVERY_ORIGINS[store], DESTINATION]));
    for (const { url } of geocodes) {
      assert.deepEqual([...url.searchParams.keys()].sort(), ['apiKey', 'city', 'country', 'filter', 'format', 'housenumber', 'lang', 'limit', 'street']);
      assert.equal(url.searchParams.get('country'), 'Taiwan');
      assert.equal(url.searchParams.get('city'), '潮州鎮');
      assert.equal(url.searchParams.get('text'), null);
      assert.equal(url.searchParams.get('state'), null);
    }
    assert.ok(geocodes.every(call => call.url.searchParams.get('filter') === 'countrycode:tw' && call.url.searchParams.get('lang') === 'zh'));
    const routing = calls.find(call => call.url.pathname === '/v1/routing').url.searchParams;
    assert.equal(routing.get('mode'), 'scooter');
    assert.equal(routing.get('units'), 'metric');
    assert.equal(routing.get('details'), 'admin_areas');
    assert.equal(routing.get('avoid'), 'ferries');
    assert.equal(routing.get('waypoints'), store === 1 ? '22.55,120.54|22.57,120.56' : '22.56,120.55|22.57,120.56');
    assert.equal(JSON.stringify(result).includes(KEY), false);
  });
}
for (const [label, mutate] of [
  ['錯誤國別', value => ({ ...value, country_code: 'cn' })],
  ['僅匹配街道', value => ({ ...value, result_type: 'street' })],
  ['沒有門牌', value => ({ ...value, housenumber: undefined })],
  ['門牌不符', value => ({ ...value, housenumber: '100' })],
  ['沒有街名', value => ({ ...value, street: '' })],
  ['同門牌不同路', value => ({ ...value, street: '其他路' })],
  ['不同縣市', value => ({ ...value, county: '高雄市' })],
  ['不同鄉鎮', value => ({ ...value, city: '東港鎮' })],
  ['信心不足', value => ({ ...value, rank: { ...value.rank, confidence: 0.94 } })],
  ['城市信心不足', value => ({ ...value, rank: { ...value.rank, confidence_city_level: 0.6 } })],
  ['建物信心不足', value => ({ ...value, rank: { ...value.rank, confidence_building_level: 0 } })],
  ['只匹配城市', value => ({ ...value, rank: { ...value.rank, match_type: 'match_by_city_or_disrict' } })],
  ['錯誤座標', value => ({ ...value, lat: 40 })],
]) {
  test(`拒絕${label}，不呼叫routing也不編造距離`, async () => {
    const { calculate, calls } = fixture({ geocode: (value, address) => [address === DESTINATION ? mutate(value) : value] });
    await rejectsCode(calculate(), 'distance_address_invalid', 422);
    assert.equal(calls.some(call => call.url.pathname === '/v1/routing'), false);
  });
}
test('兩個高信心門牌結果視為歧義，重複同一座標結果可去重', async () => {
  const ambiguous = fixture({ geocode: (value, address) => address === DESTINATION ? [value, { ...value, lon: value.lon + 0.01 }] : [value] });
  await rejectsCode(ambiguous.calculate(), 'distance_address_invalid', 422);
  const duplicate = fixture({ geocode: value => [value, { ...value }] });
  assert.equal((await duplicate.calculate()).distance_km, 3.25);
});
test('不完整門牌與多個門牌在provider呼叫前拒絕', async () => {
  const { calculate, calls } = fixture();
  for (const address of ['', '25號', '潮州鎮文化路25號', '屏東縣潮州鎮測試路', '屏東縣潮州鎮測試路99號或100號', `${DESTINATION}\u0000`]) {
    await rejectsCode(calculate(address), 'distance_address_invalid', 422);
  }
  assert.deepEqual(calls, []);
});
test('未支援巷號或道路與門牌間夾雜文字不能被忽略', async () => {
  const { calculate, calls } = fixture();
  for (const address of ['屏東縣潮州鎮文化路十巷42號', '屏東縣潮州鎮文化路xxx42號', '屏東縣潮州鎮文化路10巷二弄42號']) {
    await rejectsCode(calculate(address), 'distance_address_invalid', 422);
  }
  assert.deepEqual(calls, []);
});
test('合法數字巷弄緊接門牌可查詢，門牌後樓層不改變起終點', async () => {
  const address = '屏東縣潮州鎮測試路10巷2弄42之1號3樓';
  const { calculate, calls } = fixture();
  const result = await calculate(address);
  assert.equal(result.address, address);
  assert.equal(result.distance_km, 3.25);
  const destination = calls.find(call => call.url.searchParams.get('street') === '測試路10巷2弄').url.searchParams;
  assert.equal(destination.get('housenumber'), '42-1');
  assert.equal(destination.get('city'), '潮州鎮');
  assert.equal(destination.get('text'), null);
  assert.equal(destination.toString().includes(encodeURIComponent('3樓')), false);
});
test('門市起點匹配失敗回503且不錯用另一家門市', async () => {
  const { calculate, calls } = fixture({ geocode: (value, address) => address === DELIVERY_ORIGINS[1] ? [] : [value] });
  await rejectsCode(calculate(), 'distance_unavailable', 503);
  assert.equal(calls.some(call => geocodeAddress(call.url) === DELIVERY_ORIGINS[2]), false);
});
for (const [label, mutate, code, status] of [
  ['沒有路線', () => [], 'distance_no_route', 422],
  ['路線跨國', value => [{ ...value, country_code: ['tw', 'cn'] }], 'distance_no_route', 422],
  ['行政區不在台灣', value => [{ ...value, admin_areas: [{ country_code: 'cn' }] }], 'distance_no_route', 422],
  ['路段跨國', value => [{ ...value, legs: [{ country_code: ['cn'], steps: [] }] }], 'distance_no_route', 422],
  ['缺少路線國別', value => [{ ...value, country_code: undefined }], 'distance_no_route', 422],
  ['渡輪', value => [{ ...value, ferry: true }], 'distance_no_route', 422],
  ['路段渡輪', value => [{ ...value, legs: [{ country_code: ['tw'], steps: [{ ferry: true }] }] }], 'distance_no_route', 422],
  ['錯誤英里單位', value => [{ ...value, distance_units: 'Miles' }], 'distance_unavailable', 503],
  ['負距離', value => [{ ...value, distance: -1 }], 'distance_unavailable', 503],
  ['非數字距離', value => [{ ...value, distance: '3245' }], 'distance_unavailable', 503],
  ['超出欄位上限', value => [{ ...value, distance: 100000000 }], 'distance_unavailable', 503],
  ['不同位置卻回傳零距離', value => [{ ...value, distance: 0 }], 'distance_no_route', 422],
]) {
  test(`拒絕${label}，不以直線距離代替`, async () => {
    await rejectsCode(fixture({ route: mutate }).calculate(), code, status);
  });
}
test('公尺單位的大小寫差異都換算為相同公里數', async () => {
  for (const unit of ['Meters', 'meters', 'METERS', 'mEtErS']) {
    const { calculate, diagnostics } = fixture({ route: value => [{ ...value, distance_units: unit }] });
    assert.equal((await calculate()).distance_km, 3.25);
    assert.deepEqual(diagnostics, []);
  }
});
test('英里、其他與缺失單位仍拒絕，診斷僅記白名單enum', async () => {
  for (const unit of ['Miles', 'miles', 'km', 'Kilometers', 'meter', 'm', undefined, null, 42, `meters ${KEY}`]) {
    const { calculate, diagnostics } = fixture({ route: value => [{ ...value, distance_units: unit }] });
    await rejectsCode(calculate(), 'distance_unavailable', 503);
    const shape = diagnostics.find(event => event.phase === 'route').route_shape;
    assert.equal(shape.unit, typeof unit === 'string' && unit.toLowerCase() === 'miles' ? 'miles'
      : unit === undefined || unit === null ? 'missing' : 'other');
    assert.equal(JSON.stringify(diagnostics).includes(KEY), false);
  }
});
test('路線schema診斷只保留型別、布林與有上限計數，不複製provider資料', async () => {
  const malformed = { results: [{ distance: KEY, distance_units: `https://example.invalid/${KEY}`,
    legs: Array(1001).fill(null), geometry: { coordinates: [[120.55, 22.56]] },
    properties: { address: DESTINATION, apiKey: KEY }, instructions: DESTINATION }] };
  const { calculate, diagnostics } = fixture({ response: url => url.pathname === '/v1/routing' ? Response.json(malformed) : null });
  await rejectsCode(calculate(), 'distance_unavailable', 503);
  assert.deepEqual(diagnostics, [{ store_id: 1, phase: 'route', reason: 'route_validation', route_shape: {
    results_array: true, results_count: 1, route_object: true, unit: 'other', distance_type: 'string',
    distance_finite: false, distance_in_range: false, legs_array: true, legs_count: 1000, first_leg_object: false,
  } }]);
  for (const value of [KEY, DESTINATION, 'https://', '120.55', '22.56', 'coordinates', 'instructions']) assert.equal(JSON.stringify(diagnostics).includes(value), false);
  const absent = fixture({ response: url => url.pathname === '/v1/routing' ? Response.json({ features: [{ properties: malformed.results[0] }] }) : null });
  await rejectsCode(absent.calculate(), 'distance_unavailable', 503);
  assert.equal(absent.diagnostics[0].route_shape.results_array, false);
  assert.equal(absent.diagnostics[0].route_shape.results_count, 0);
  assert.equal(absent.diagnostics[0].route_shape.route_object, false);
});
test('provider權限/內部/格式錯誤都不洩漏key或原始錯誤，也不回登入403', async () => {
  for (const status of [401, 403, 500]) {
    const { calculate } = fixture({ response: url => url.pathname === '/v1/routing'
      ? new Response(`internal ${KEY} ${DESTINATION}`, { status }) : null });
    await assert.rejects(calculate(), error => error.status === 503 && error.code === 'distance_unavailable'
      && !error.message.includes(KEY) && !error.message.includes(DESTINATION));
  }
  for (const response of [() => { throw new Error(`URL secret ${KEY}`); }, () => new Response(`invalid JSON ${KEY}`),
    () => new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } })]) {
    await rejectsCode(fixture({ response }).calculate(), 'distance_unavailable', 503);
  }
});
test('provider配額限制以429回傳安全重試秒數', async () => {
  const { calculate } = fixture({ response: () => new Response('quota', { status: 429, headers: { 'retry-after': '120' } }) });
  await assert.rejects(calculate(), error => error.status === 429 && error.code === 'distance_rate_limited' && error.retryAfter === 60);
});
test('同一總deadline涵蓋fetch與回應串流，不會永遠等待', async () => {
  for (const stream of [false, true]) {
    const { calculate, calls } = fixture({ timeoutMs: 15, response: url => {
      if (url.pathname !== '/v1/routing') return null;
      return stream ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) : new Promise(() => {});
    } });
    await rejectsCode(calculate(), 'distance_unavailable', 503);
    assert.ok(calls.every(call => call.init.signal.aborted));
  }
});
test('短TTL快取按門市分開，回應echo本次地址以供前端防止舊結果', async () => {
  const { calculate, calls, advance } = fixture();
  await calculate();
  const alternate = '屏東縣潮州鎮測試路９９號';
  const cached = await calculate(` ${alternate} `);
  assert.equal(cached.address, alternate);
  assert.equal(calls.length, 3);
  await calculate(DESTINATION, 2);
  assert.equal(calls.length, 6);
  advance(5 * 60 * 1000 + 1);
  await calculate();
  assert.equal(calls.length, 8, 'route expired while verified origin stayed cached');
});
test('快取筆數有上限，淘汰後重新查詢，不持續累積地址', async () => {
  const { calculate, calls } = fixture({ cacheMaxEntries: 2 });
  for (const number of [99, 100, 101, 99]) await calculate(`屏東縣潮州鎮測試路${number}號`);
  assert.equal(calls.filter(call => call.url.pathname === '/v1/routing').length, 4);
});
test('每token與每門市皆有best-effort節流，其他門市不共用額度', async () => {
  const perToken = fixture();
  for (let i = 0; i < 12; i++) await perToken.calculate();
  await rejectsCode(perToken.calculate(), 'distance_rate_limited', 429);
  assert.equal(perToken.calls.length, 3);
  perToken.advance(60001);
  await perToken.calculate();
  const perStore = fixture();
  for (let i = 0; i < 30; i++) await perStore.calculate(DESTINATION, 1, `session-${i}`);
  await rejectsCode(perStore.calculate(DESTINATION, 1, 'fresh-session'), 'distance_rate_limited', 429);
  assert.equal((await perStore.calculate(DESTINATION, 2, 'fresh-session')).distance_km, 3.25);
});
test('相同路線並行合併，異路線同店最多兩個並行', async () => {
  const releases = [];
  const { calculate, calls } = fixture({ response: url => url.pathname === '/v1/routing'
    ? new Promise(resolve => releases.push(() => resolve(Response.json({ results: [route()] })))) : null });
  const first = calculate();
  const same = calculate();
  const second = calculate('屏東縣潮州鎮測試路100號');
  try {
    await until(() => releases.length === 2);
    await rejectsCode(calculate('屏東縣潮州鎮測試路101號'), 'distance_rate_limited', 429);
    assert.equal(calls.filter(call => call.url.pathname === '/v1/routing').length, 2);
  } finally { for (const release of releases) release(); }
  assert.equal((await first).distance_km, 3.25);
  assert.equal((await same).distance_km, 3.25);
  assert.equal((await second).distance_km, 3.25);
});

test('診斷分辨輸入解析、無候選、候選驗證，客戶資料不出現在事件', async () => {
  const invalid = fixture();
  await rejectsCode(invalid.calculate('私密客戶25號'), 'distance_address_invalid', 422);
  assert.deepEqual(invalid.diagnostics, [{ store_id: 1, phase: 'input', reason: 'address_parse' }]);
  for (const empty of [true, false]) {
    const { calculate, diagnostics } = fixture({ geocode: (value, address) => address === DESTINATION
      ? empty ? [] : [{ ...value, rank: { ...value.rank, confidence: 0.5 } }] : [value] });
    await rejectsCode(calculate(DESTINATION, 1, 'private-session-token'), 'distance_address_invalid', 422);
    const event = diagnostics.find(value => value.phase === 'destination');
    assert.equal(event.reason, empty ? 'no_candidates' : 'candidate_validation');
    assert.equal(event.candidate_count, empty ? 0 : 1);
    assert.equal(event.public_address_store, undefined);
    for (const candidate of event.candidates) {
      assert.equal(candidate.fields, undefined);
      assert.ok(Object.values(candidate.checks).every(value => typeof value === 'boolean'));
    }
    const logged = JSON.stringify(diagnostics);
    for (const secret of [DESTINATION, '測試路', 'private-session-token', KEY, 'api.geoapify.com']) assert.equal(logged.includes(secret), false);
  }
});
test('診斷只有完全相同的公開門市地址可記必要候選欄位', async () => {
  const address = DELIVERY_ORIGINS[2];
  const { calculate, diagnostics } = fixture({ geocode: (value, text) => [text === address
    ? { ...value, rank: { ...value.rank, confidence: 0.5 } } : value] });
  await rejectsCode(calculate(address), 'distance_address_invalid', 422);
  const event = diagnostics.find(value => value.phase === 'destination');
  assert.equal(event.public_address_store, 2);
  assert.equal(event.candidates[0].fields.housenumber, '25');
  assert.equal(event.candidates[0].fields.street, '東華路');
  assert.equal(event.candidates[0].fields.admin.county, '屏東縣');
  assert.equal(event.candidates[0].fields.rank.confidence, 0.5);
  assert.equal(event.candidates[0].checks.confidence, false);
  assert.equal(JSON.stringify(event).includes(address), false, 'raw full address is never copied');
  assert.deepEqual(Object.keys(event.candidates[0].fields).sort(), ['admin', 'country_code', 'housenumber', 'rank', 'result_type', 'street']);
  const privateVariant = fixture({ geocode: (value, text) => text === address ? [] : [value] });
  await rejectsCode(privateVariant.calculate(`${address}3樓`), 'distance_address_invalid', 422);
  assert.equal(privateVariant.diagnostics.find(value => value.phase === 'destination').public_address_store, undefined);
});
test('公開地址診斷仍移除key及URL，限制字串與候選數，不複製provider原始物件', async () => {
  const address = DELIVERY_ORIGINS[2];
  const { calculate, diagnostics } = fixture({ geocode: (value, text) => text === address
    ? Array.from({ length: 10 }, () => ({ ...value, housenumber: KEY, street: `private ${KEY}`,
      county: 'https://example.invalid/private', city: 'api.geoapify.com/private', district: '字'.repeat(1000),
      formatted: 'private-full-address', extra_secret: KEY, rank: { confidence: 0.5, match_type: `private ${KEY}` } })) : [value] });
  await rejectsCode(calculate(address), 'distance_address_invalid', 422);
  const event = diagnostics.find(value => value.phase === 'destination');
  assert.equal(event.candidate_count, 10);
  assert.equal(event.candidates.length, 5);
  assert.equal(event.candidates[0].fields.admin.district.length, 40);
  const logged = JSON.stringify(event);
  for (const secret of [KEY, 'https://', 'example.invalid', 'api.geoapify.com', 'private-full-address', 'extra_secret', 'lat', 'lon']) {
    assert.equal(logged.includes(secret), false);
  }
  assert.ok(new TextEncoder().encode(logged).length < 8192);
});
test('HTTP診斷僅記狀態與stage，不記body/URL；診斷sink失敗不改變原錯誤', async () => {
  const { calculate, diagnostics } = fixture({ response: url => geocodeAddress(url) === DESTINATION
    ? new Response(`raw error ${KEY} ${DESTINATION}`, { status: 400 }) : null,
    onDiagnostic: () => { throw new Error('sink unavailable'); } });
  await rejectsCode(calculate(), 'distance_address_invalid', 422);
  assert.deepEqual(diagnostics, [{ store_id: 1, phase: 'destination', reason: 'http_error', http_status: 400 }]);
});

test('structured全欄吻合但信心零仍拒絕，不追加fallback；公開候選僅記間距數值', async () => {
  const address = DELIVERY_ORIGINS[2];
  const { calculate, calls, diagnostics } = fixture({ geocode: (value, text) => text === address
    ? [value, { ...value, lon: value.lon + 0.001 }].map(candidate => ({ ...candidate, rank: {
      match_type: 'full_match', confidence: 0, confidence_city_level: 0, confidence_street_level: 0, confidence_building_level: 0,
    } })) : [value] });
  await rejectsCode(calculate(address), 'distance_address_invalid', 422);
  assert.equal(calls.length, 2, 'only one request per address, with no free-form fallback or route');
  assert.ok(calls.every(call => call.url.pathname === '/v1/geocode/search' && !call.url.searchParams.has('text')));
  const event = diagnostics.find(value => value.phase === 'destination');
  assert.equal(event.reason, 'candidate_validation');
  assert.equal(event.public_address_store, 2);
  assert.ok(event.separation_m > 100 && event.separation_m < 105);
  assert.equal(event.separation_m, Math.round(event.separation_m * 10) / 10);
  for (const candidate of event.candidates) {
    for (const field of ['country', 'type', 'house', 'street', 'county', 'district', 'match_type', 'coordinates']) assert.equal(candidate.checks[field], true);
    assert.equal(candidate.checks.confidence, false);
    assert.equal(candidate.checks.component_confidence, false);
  }
  const logged = JSON.stringify(event);
  for (const privateValue of ['"lat"', '"lon"', '22.56', '120.55', KEY, 'api.geoapify.com']) assert.equal(logged.includes(privateValue), false);
});
