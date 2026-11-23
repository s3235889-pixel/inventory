// Node 24+, all tokens/keys are test-only and all data/storage calls are in-memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from '../supabase/functions/delivery-api/handler.ts';
import { DELIVERY_ORIGINS, DistanceError } from '../supabase/functions/delivery-api/distance.ts';

const encoder = new TextEncoder();
const key = await crypto.subtle.importKey('raw', encoder.encode('delivery-tests-only'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const NOW = Date.parse('2026-11-20T16:15:00Z');
const ID = '23701be8-5307-4b4b-ab66-a9eb60ec56d1';
const REQUEST = 'b73e002b-1889-4bf2-b36b-cd5d674c06d8';
const JPEG = new Uint8Array([255, 216, 255, 224, 0, 16, 255, 217]);
const b64 = value => Buffer.from(value).toString('base64url');
async function sign(payload) {
  const data = b64(encoder.encode(JSON.stringify(payload)));
  return `${data}.${b64(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))}`;
}
const TOKENS = { 1: await sign({ store: 1, admin: false, exp: NOW + 60000 }), 2: await sign({ store: 2, admin: false, exp: NOW + 60000 }) };
function saveBody(changes = {}) {
  return { action: 'save', id: ID, request_id: REQUEST, expected_version: 0, unit_name: ' 測試公司 ',
    address: ' 屏東縣潮州鎮測試路1號 ', courier: ' 外送測試員 ', delivered_at: '2026-11-20T16:00:00.000Z',
    amount: 1250.5, distance_km: 3.25, remove_photo: false, ...changes };
}
function attachBody(changes = {}) {
  return { action: 'attach_photo', id: ID, request_id: REQUEST, expected_version: 1, ...changes };
}
function attachedRecord(args, attached = true) {
  const { unit_name, address, courier, delivered_at, amount, distance_km } = saveBody();
  return { id: args.p_id, unit_name, address, courier, delivered_at, amount, distance_km,
    has_photo: attached, version: args.p_expected_version + (attached ? 1 : 0), updated_at: new Date(NOW).toISOString() };
}
function attachmentResult(args) {
  return { data: { record: attachedRecord(args, !!args.p_photo_path), photo_path: args.p_photo_path,
    ready_for_upload: !args.p_photo_path }, error: null };
}
function fixture(overrides = {}) {
  const calls = [];
  const base = {
    key, now: () => NOW,
    async loadRecords(...args) { calls.push(['load', ...args]); return { data: { records: [], total_count: 51, total_amount: 1500.5, total_distance_km: 20.5 }, error: null }; },
    async saveRecord(args) {
      calls.push(['save', args]);
      return { data: { record: { id: args.p_id, ...args.p_record, has_photo: !!args.p_photo_path, version: args.p_expected_version + 1, updated_at: new Date(NOW).toISOString() },
        photo_path: args.p_photo_path, unused_photo_paths: [] }, error: null };
    },
    async attachRecordPhoto(args) { calls.push(['attach', args]); return attachmentResult(args); },
    async deleteRecord(...args) { calls.push(['delete', ...args]); return { data: { ok: true, photo_path: null }, error: null }; },
    async photoPath(...args) { calls.push(['photo', ...args]); return { data: { photo_path: `${args[0]}/${args[1]}/private.jpg` }, error: null }; },
    async uploadPhoto(...args) { calls.push(['upload', ...args]); return { error: null }; },
    async removePhotos(paths) { calls.push(['remove', paths]); return { error: null }; },
    async signPhoto(...args) { calls.push(['sign', ...args]); return { data: { signedUrl: 'https://example.invalid/private?token=test' }, error: null }; },
  };
  const dependencies = { ...base };
  for (const [name, value] of Object.entries(overrides)) dependencies[name] = typeof value === 'function' ? (...args) => value(...args, calls) : value;
  const handler = createHandler(dependencies);
  async function request(body = { action: 'load', month: '2026-11', page: 0 }, { token = TOKENS[1], headers = {}, photo = null, multipart = false } = {}) {
    let encoded;
    if (multipart || photo) {
      encoded = new FormData();
      encoded.set('payload', typeof body === 'string' ? body : JSON.stringify(body));
      if (photo) encoded.set('photo', photo);
    } else { encoded = typeof body === 'string' ? body : JSON.stringify(body); headers = { 'Content-Type': 'application/json', ...headers }; }
    const response = await handler(new Request('https://example.invalid/delivery', { method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: encoded }));
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  return { handler, request, calls };
}

test('預填屏東縣本身不是完整地址，存檔前拒絕且不碰資料庫或照片', async () => {
  const { request, calls } = fixture();
  for (const address of ['屏東縣', ' 屏 東 縣 ']) {
    const result = await request(saveBody({ address }), { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) });
    assert.equal(result.status, 400);
    assert.match(result.data.error, /完整外送地址/);
  }
  assert.deepEqual(calls, []);
  assert.equal((await request(saveBody({ address: '手動填寫特殊地址' }))).status, 200);
});

for (const store of [1, 2]) {
  test(`門市${store}可補傳無照片紀錄，先檢查再上傳且不修改六欄`, async () => {
    const { request, calls } = fixture();
    const result = await request(attachBody(), { token: TOKENS[store], photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) });
    assert.equal(result.status, 200);
    assert.equal(result.data.record.has_photo, true);
    assert.equal(result.data.record.version, 2);
    assert.deepEqual(Object.keys(result.data), ['record']);
    assert.deepEqual(calls.map(call => call[0]), ['attach', 'upload', 'attach']);
    const before = calls[0][1], commit = calls[2][1];
    assert.deepEqual(Object.keys(before).sort(), ['p_expected_version', 'p_id', 'p_photo_hash', 'p_photo_path', 'p_request_id', 'p_store_id']);
    assert.equal(before.p_store_id, store);
    assert.equal(before.p_photo_path, null);
    assert.match(before.p_photo_hash, /^[0-9a-f]{64}$/);
    assert.equal(commit.p_photo_hash, before.p_photo_hash);
    assert.equal(commit.p_photo_path, calls[1][1]);
    assert.ok(commit.p_photo_path.startsWith(`${store}/${ID}/`));
    assert.ok(commit.p_photo_path.endsWith(`-${before.p_photo_hash}.jpg`));
    assert.equal(JSON.stringify(result.data).includes(commit.p_photo_path), false);
  });
}

test('補傳僅接受識別、版本及一張有效照片，不能夾帶業務欄位或路徑', async () => {
  const { request, calls } = fixture();
  for (const changes of [{ store_id: 2 }, { address: '新地址' }, { amount: 0 }, { photo_path: 'other/path' },
    { remove_photo: true }, { id: 'invalid' }, { request_id: '' }, { expected_version: 0 }, { expected_version: '1' }]) {
    assert.equal((await request(attachBody(changes), { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) })).status, 400);
  }
  assert.equal((await request(attachBody())).status, 400);
  for (const photo of [new File([], 'empty.jpg', { type: 'image/jpeg' }),
    new File(['not-an-image'], 'fake.jpg', { type: 'image/jpeg' }), new File([JPEG], 'mismatch.png', { type: 'image/png' })]) {
    assert.ok([400, 415].includes((await request(attachBody(), { photo })).status));
  }
  assert.deepEqual(calls, []);
});

test('補傳先驗證登入與門市，未登入/其他門市角色/主管不查資料也不上傳', async () => {
  const { request, calls } = fixture();
  for (const [token, status] of [['', 401], ['forged.token', 401],
    [await sign({ store: 3, admin: false, exp: NOW + 60000 }), 403], [await sign({ store: 1, admin: true, exp: NOW + 60000 }), 403]]) {
    assert.equal((await request(attachBody(), { token, photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) })).status, status);
  }
  assert.deepEqual(calls, []);
});

for (const [code, status, label] of [['55000', 403, '已有單據'], ['40001', 409, '舊版本'], ['P0002', 404, '不存在或跨店']]) {
  test(`補傳${label}在預查即拒絕，不上傳或清理照片`, async () => {
    const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
      calls.push(['attach', args]); return { data: null, error: { code } };
    } });
    const result = await request(attachBody(), { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) });
    assert.equal(result.status, status);
    if (code === '55000') assert.equal(result.data.code, 'photo_locked');
    assert.deepEqual(calls.map(call => call[0]), ['attach']);
  });
}

test('補傳已commit但回覆遺失時保留照片，相同請求重試由預查確認且不重上傳', async () => {
  let committed;
  const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
    calls.push(['attach', args]);
    if (committed) {
      assert.equal(args.p_request_id, committed.request);
      assert.equal(args.p_photo_hash, committed.hash);
      return { data: committed.data, error: null };
    }
    if (!args.p_photo_path) return attachmentResult(args);
    committed = { request: args.p_request_id, hash: args.p_photo_hash, data: attachmentResult(args).data };
    throw new Error('lost after COMMIT');
  } });
  const send = () => request(attachBody(), { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) });
  assert.equal((await send()).status, 503);
  assert.equal(calls.filter(call => call[0] === 'remove').length, 0);
  const result = await send();
  assert.equal(result.status, 200);
  assert.equal(result.data.record.has_photo, true);
  assert.equal(calls.filter(call => call[0] === 'upload').length, 1);
  assert.equal(calls.filter(call => call[0] === 'remove').length, 0);
});

test('補傳未知DB錯誤或空確認均保留本次物件，不會清除可能已commit單據', async () => {
  for (const result of [{ data: null, error: { code: 'PGRST000' } }, { data: null, error: null }]) {
    const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
      calls.push(['attach', args]); return args.p_photo_path ? result : attachmentResult(args);
    } });
    assert.equal((await request(attachBody(), { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) })).status, 503);
    assert.deepEqual(calls.map(call => call[0]), ['attach', 'upload', 'attach']);
  }
});

for (const code of ['08007', '40003']) {
  test(`SQLSTATE ${code}結果不明時，新增與補傳都保留已上傳照片`, async () => {
    const failure = { data: null, error: { code } };
    const save = fixture({ saveRecord: async (args, calls) => { calls.push(['save', args]); return failure; } });
    const attach = fixture({ attachRecordPhoto: async (args, calls) => {
      calls.push(['attach', args]); return args.p_photo_path ? failure : attachmentResult(args);
    } });
    for (const [client, body] of [[save, saveBody()], [attach, attachBody()]]) {
      const result = await client.request(body, { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) });
      assert.equal(result.status, 503);
      assert.equal(client.calls.filter(call => call[0] === 'upload').length, 1);
      assert.equal(client.calls.some(call => call[0] === 'remove'), false, 'unknown outcome must never remove a possibly committed photo');
    }
  });
}

test('補傳在預查後遭並發鎖定只清本次新物件，回photo_locked而非登入錯誤', async () => {
  const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
    calls.push(['attach', args]); return args.p_photo_path ? { data: null, error: { code: '55000' } } : attachmentResult(args);
  } });
  const result = await request(attachBody(), { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) });
  assert.equal(result.status, 403);
  assert.equal(result.data.code, 'photo_locked');
  assert.deepEqual(calls.map(call => call[0]), ['attach', 'upload', 'attach', 'remove']);
  assert.deepEqual(calls[3][1], [calls[1][1]]);
});

test('並發相同補傳只保留已commit物件，清理列表不能刪既有單據', async () => {
  const preflights = [];
  let committed;
  const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
    calls.push(['attach', args]);
    if (!args.p_photo_path) return await new Promise(resolve => {
      preflights.push(() => resolve(attachmentResult(args)));
      if (preflights.length === 2) preflights.forEach(release => release());
    });
    if (!committed) committed = attachmentResult(args).data;
    return { data: { ...committed, unused_photo_paths: ['earlier/committed/receipt.jpg'] }, error: null };
  } });
  const results = await Promise.all([1, 2].map(() => request(attachBody(), { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) })));
  assert.ok(results.every(result => result.status === 200 && result.data.record.has_photo));
  const paths = calls.filter(call => call[0] === 'upload').map(call => call[1]);
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1]);
  assert.deepEqual(calls.filter(call => call[0] === 'remove').map(call => call[1]), [[paths.find(path => path !== committed.photo_path)]]);
});

test('補傳改request或bytes被鎖定，照片上傳失敗不呼叫commit', async () => {
  let saved;
  const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
    calls.push(['attach', args]);
    if (saved && (saved.request !== args.p_request_id || saved.hash !== args.p_photo_hash)) return { data: null, error: { code: '55000' } };
    if (args.p_photo_path) saved = { request: args.p_request_id, hash: args.p_photo_hash, data: attachmentResult(args).data };
    return saved ? { data: saved.data, error: null } : attachmentResult(args);
  } });
  assert.equal((await request(attachBody(), { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) })).status, 200);
  for (const [body, bytes] of [[attachBody({ request_id: crypto.randomUUID() }), JPEG], [attachBody(), new Uint8Array([...JPEG, 1])]]) {
    const result = await request(body, { photo: new File([bytes], 'receipt.jpg', { type: 'image/jpeg' }) });
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'photo_locked');
  }
  assert.equal(calls.filter(call => call[0] === 'upload').length, 1);
  const brokenUpload = fixture({ uploadPhoto: async (...args) => { args.at(-1).push(['upload']); return { error: { message: 'unavailable' } }; } });
  assert.equal((await brokenUpload.request(attachBody(), { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) })).status, 503);
  assert.deepEqual(brokenUpload.calls.map(call => call[0]), ['attach', 'upload']);
});
function distanceFixture(calculate) {
  const distanceCalls = [];
  const distance = {
    info: store => ({ available: true, origin_address: DELIVERY_ORIGINS[store], mode: 'scooter', provider: 'geoapify' }),
    async calculate(...args) {
      distanceCalls.push(args);
      if (calculate) return await calculate(...args);
      const [store, address] = args;
      return { distance_km: 3.25, address, matched_address: address, origin_address: DELIVERY_ORIGINS[store],
        mode: 'scooter', provider: 'geoapify', estimated: true };
    },
  };
  return { ...fixture({ distance }), distanceCalls };
}

for (const store of [1, 2]) {
  test(`門市${store}距離action只用已驗證門市，回應echo地址且不碰DB或Storage`, async () => {
    const { request, calls, distanceCalls } = distanceFixture();
    const address = '屏東縣潮州鎮測試路99號';
    const result = await request({ action: 'distance', address: ` ${address} ` }, { token: TOKENS[store] });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { distance_km: 3.25, address, matched_address: address,
      origin_address: DELIVERY_ORIGINS[store], mode: 'scooter', provider: 'geoapify', estimated: true });
    assert.deepEqual(distanceCalls[0].slice(0, 2), [store, address]);
    assert.match(distanceCalls[0][2], /^[0-9a-f]{64}$/);
    assert.notEqual(distanceCalls[0][2], TOKENS[store]);
    assert.deepEqual(calls, []);
    const loaded = await request(undefined, { token: TOKENS[store] });
    assert.deepEqual(loaded.data.distance_service, { available: true, origin_address: DELIVERY_ORIGINS[store], mode: 'scooter', provider: 'geoapify' });
    assert.equal(distanceCalls.length, 1, 'load must not request a route');
  });
}
test('沒有地圖設定時距離回503，查詢/新增/看照片照常使用', async () => {
  const { request, calls } = fixture();
  const result = await request({ action: 'distance', address: '屏東縣潮州鎮測試路99號' });
  assert.equal(result.status, 503);
  assert.equal(result.data.code, 'distance_unavailable');
  assert.match(result.data.error, /手動/);
  assert.deepEqual(calls, []);
  const loaded = await request();
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.data.distance_service, { available: false, origin_address: DELIVERY_ORIGINS[1], mode: 'scooter', provider: 'geoapify' });
  assert.equal((await request(saveBody())).status, 200);
  assert.equal((await request({ action: 'photo', id: ID })).status, 200);
});
test('距離查詢不得指定其他門市/起點/模式/金鑰/任意URL或混入照片', async () => {
  const { request, calls, distanceCalls } = distanceFixture();
  for (const changes of [{ store_id: 2 }, { origin_address: '另一門市' }, { mode: 'drive' },
    { apiKey: 'browser-key' }, { url: 'http://internal.invalid/' }, { lat: 22.5, lon: 120.5 }]) {
    assert.equal((await request({ action: 'distance', address: '屏東縣潮州鎮測試路99號', ...changes })).status, 400);
  }
  assert.equal((await request({ action: 'distance', address: '屏東縣潮州鎮測試路99號' },
    { photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) })).status, 400);
  assert.deepEqual(calls, []);
  assert.deepEqual(distanceCalls, []);
});
test('距離地址型別/長度/控制字元先驗證，未登入或跨店角色不呼叫provider', async () => {
  const { request, calls, distanceCalls } = distanceFixture();
  for (const address of ['', null, 123, '路'.repeat(301), '測試\u0000地址']) {
    const result = await request({ action: 'distance', address });
    assert.equal(result.status, 422);
    assert.equal(result.data.code, 'distance_address_invalid');
  }
  const body = { action: 'distance', address: '屏東縣潮州鎮測試路99號' };
  assert.equal((await request(body, { token: '' })).status, 401);
  assert.equal((await request(body, { token: await sign({ store: 3, admin: false, exp: NOW + 60000 }) })).status, 403);
  assert.equal((await request(body, { token: await sign({ store: 1, admin: true, exp: NOW + 60000 }) })).status, 403);
  assert.deepEqual(calls, []);
  assert.deepEqual(distanceCalls, []);
});
for (const [status, code] of [[422, 'distance_address_invalid'], [422, 'distance_no_route'], [429, 'distance_rate_limited'], [503, 'distance_unavailable']]) {
  test(`地圖錯誤${code}保留獨立code，不當成登入403`, async () => {
    const { request, calls } = distanceFixture(() => { throw new DistanceError('請確認地址或手動輸入公里數。', status, code, status === 429 ? 20 : undefined); });
    const result = await request({ action: 'distance', address: '屏東縣潮州鎮測試路99號' });
    assert.equal(result.status, status);
    assert.equal(result.data.code, code);
    if (status === 429) {
      assert.equal(result.headers.get('retry-after'), '20');
      assert.match(result.headers.get('access-control-expose-headers'), /Retry-After/);
    }
    assert.deepEqual(calls, []);
  });
}
test('未知地圖錯誤不回傳provider URL或secret', async () => {
  const { request } = distanceFixture(() => { throw new Error('https://api.geoapify.com/?apiKey=private-test-key'); });
  const result = await request({ action: 'distance', address: '屏東縣潮州鎮測試路99號' });
  assert.equal(result.status, 503);
  assert.equal(result.data.code, 'distance_unavailable');
  assert.equal(JSON.stringify(result.data).includes('private-test-key'), false);
});

for (const store of [1, 2]) {
  test(`門市${store}登入後只把自己的識別送至資料庫`, async () => {
    const { request, calls } = fixture();
    const loaded = await request(undefined, { token: TOKENS[store] });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.data.store_id, store);
    assert.equal(loaded.data.has_more, true);
    assert.equal(loaded.data.page_size, 50);
    assert.equal(loaded.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls[0], ['load', store, '2026-11', 0]);
    const saved = await request(saveBody(), { token: TOKENS[store], multipart: true });
    assert.equal(saved.status, 200);
    assert.equal(calls.at(-1)[1].p_store_id, store);
    assert.equal(saved.data.record.unit_name, '測試公司');
    assert.equal(saved.data.record.amount, 1250.5);
    assert.equal(saved.data.record.has_photo, false);
  });
}
for (const [name, payload] of [
  ['東港', { store: 3, admin: false, exp: NOW + 1 }],
  ['其他分店', { store: 6, admin: false, exp: NOW + 1 }],
  ['主管', { store: 0, admin: true, exp: NOW + 1 }],
  ['聲稱潮州的主管', { store: 1, admin: true, exp: NOW + 1 }],
  ['文字門市ID', { store: '2', admin: false, exp: NOW + 1 }],
  ['缺少門市角色', { store: 2, exp: NOW + 1 }],
]) {
  test(`${name}即使簽章有效仍回403且不接觸資料或照片`, async () => {
    const { request, calls } = fixture();
    assert.equal((await request(saveBody(), { token: await sign(payload), photo: new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' }) })).status, 403);
    assert.equal(calls.length, 0);
  });
}
for (const [name, token] of [
  ['未登入', ''], ['偽造', TOKENS[1].slice(0, -3) + 'abc'], ['格式損壞', 'wrong.token'],
  ['到期', await sign({ store: 1, admin: false, exp: NOW })], ['沒有到期值', await sign({ store: 1, admin: false })],
]) {
  test(`${name}回401且不查資料`, async () => {
    const { request, calls } = fixture();
    assert.equal((await request(undefined, { token })).status, 401);
    assert.equal(calls.length, 0);
  });
}

for (const [name, change] of [
  ['空白單位', { unit_name: '\n　\t' }], ['過長地址', { address: '路'.repeat(301) }],
  ['空白人員', { courier: '' }], ['負金額', { amount: -1 }], ['未填金額', { amount: '' }],
  ['金額字串', { amount: '1250' }], ['過高金額', { amount: 100000000 }],
  ['金額三位小數', { amount: 1.005 }], ['負距離', { distance_km: -0.01 }],
  ['距離三位小數', { distance_km: 0.001 }], ['空距離', { distance_km: null }],
  ['不存在日期', { delivered_at: '2026-02-30T00:00:00.000Z' }],
  ['沒有時區', { delivered_at: '2026-11-20T10:30' }], ['24時日期', { delivered_at: '2026-11-20T24:00:00Z' }],
  ['損壞識別', { id: '../another' }], ['版本字串', { expected_version: '1' }], ['負版本', { expected_version: -1 }],
  ['自己選門市', { store_id: 2 }], ['自己指定照片路徑', { photo_path: '2/another' }],
]) {
  test(`拒絕${name}且不寫入`, async () => {
    const { request, calls } = fixture();
    assert.equal((await request(saveBody(change), { multipart: true })).status, 400);
    assert.equal(calls.length, 0);
  });
}
test('未來外送時間和台灣1900年起點均可記錄，下一年9999上界不接受', async () => {
  const { request } = fixture();
  assert.equal((await request(saveBody({ delivered_at: '2027-01-01T04:30:00Z' }))).status, 200);
  assert.equal((await request(saveBody({ delivered_at: '1899-12-31T16:00:00Z' }))).status, 200);
  assert.equal((await request(saveBody({ delivered_at: '9999-12-31T16:00:00Z' }))).status, 400);
});
test('分頁、月份、額外門市欄位都會驗證', async () => {
  for (const body of [{ action: 'load', month: '2026-13' }, { action: 'load', month: '1899-12' },
    { action: 'load', month: '2026-01', page: -1 }, { action: 'load', month: '2026-01', store_id: 2 }]) {
    assert.equal((await fixture().request(body)).status, 400);
  }
  const result = await fixture().request({ action: 'load', month: '2026-11', page: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.data.has_more, false);
});

test('JPEG、PNG、WebP檔頭和MIME都正確才上傳，檔名不影響私有路徑', async () => {
  for (const [bytes, mime, ext] of [[JPEG, 'image/jpeg', 'jpg'],
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]), 'image/png', 'png'],
    [encoder.encode('RIFF1234WEBPdata'), 'image/webp', 'webp']]) {
    const { request, calls } = fixture();
    const result = await request(saveBody(), { photo: new File([bytes], '../../other-store.jpg', { type: mime }) });
    assert.equal(result.status, 200);
    assert.equal(result.data.record.has_photo, true);
    const upload = calls.find(call => call[0] === 'upload');
    assert.match(upload[1], new RegExp(`^1/${ID}/[0-9a-f-]{36}-[0-9a-f]{64}\\.${ext}$`));
    assert.equal(upload[3], mime);
    assert.equal(calls.some(call => call[0] === 'remove'), false);
    assert.equal(JSON.stringify(result.data).includes('photo_path'), false);
  }
});
test('假JPG、SVG、MIME不符、空照片均不接觸儲存', async () => {
  for (const file of [new File(['<svg/>'], 'a.jpg', { type: 'image/jpeg' }),
    new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }),
    new File([JPEG], 'a.png', { type: 'image/png' }), new File([], 'empty.jpg', { type: 'image/jpeg' })]) {
    const { request, calls } = fixture();
    assert.ok([400, 415].includes((await request(saveBody(), { photo: file })).status));
    assert.equal(calls.length, 0);
  }
});
for (const [name, changes, withPhoto] of [
  ['舊頁文字編輯', { expected_version: 1, unit_name: '變更單位' }, false],
  ['舊頁照片更換或補傳', { expected_version: 1 }, true],
  ['移除照片', { remove_photo: true }, false],
  ['同時傳入新圖與移除照片', { remove_photo: true }, true],
]) {
  test(`${name}在照片或資料寫入前回403 record_locked`, async () => {
    const { request, calls } = fixture();
    const result = await request(saveBody(changes), { photo: withPhoto ? new File([JPEG], 'a.jpg', { type: 'image/jpeg' }) : null });
    assert.equal(result.status, 403);
    assert.deepEqual(result.data, { error: '外送紀錄上傳後僅供查詢，不可編輯或刪除', code: 'record_locked' });
    assert.deepEqual(calls, []);
  });
}
test('一般讀取不能混入上傳', async () => {
  const { request, calls } = fixture();
  assert.equal((await request({ action: 'load', month: '2026-11' }, { photo: new File([JPEG], 'a.jpg', { type: 'image/jpeg' }) })).status, 400);
  assert.deepEqual(calls, []);
});
test('實際本文超標、偽宣告超大本文及損壞multipart都拒絕', async () => {
  assert.equal((await fixture().request('x'.repeat(32769))).status, 413);
  assert.equal((await fixture().request(undefined, { headers: { 'Content-Length': '99999999' } })).status, 413);
  assert.equal((await fixture().request('bad', { headers: { 'Content-Type': 'multipart/form-data; boundary=absent' } })).status, 400);
  assert.equal((await fixture().request('{bad json')).status, 400);
});
test('照片上傳失敗時不提交外送資料', async () => {
  const { request, calls } = fixture({ uploadPhoto: async () => ({ error: { message: 'storage failed' } }) });
  assert.equal((await request(saveBody(), { photo: new File([JPEG], 'a.jpg', { type: 'image/jpeg' }) })).status, 503);
  assert.equal(calls.some(call => call[0] === 'save'), false);
});
for (const [code, status] of [['40001', 409], ['55000', 403]]) {
  test(`DB明確拒絕交易${code}只清除本次嘗試的新照片`, async () => {
    const { request, calls } = fixture({ saveRecord: async () => ({ data: null, error: { code, message: 'internal details' } }) });
    const result = await request(saveBody(), { photo: new File([JPEG], 'a.jpg', { type: 'image/jpeg' }) });
    assert.equal(result.status, status);
    assert.deepEqual(calls.find(call => call[0] === 'remove')[1], [calls.find(call => call[0] === 'upload')[1]]);
    assert.equal(JSON.stringify(result.data).includes('internal details'), false);
    if (code === '55000') assert.deepEqual(result.data, { error: '外送紀錄上傳後僅供查詢，不可編輯或刪除', code: 'record_locked' });
  });
}
test('DB結果不明時保留照片，避免誤刪可能已提交的單據', async () => {
  for (const saveRecord of [async () => { throw Error('network'); }, async () => ({ data: null, error: { message: 'transport' } }), async () => ({ data: null, error: null })]) {
    const { request, calls } = fixture({ saveRecord });
    assert.equal((await request(saveBody(), { photo: new File([JPEG], 'a.jpg', { type: 'image/jpeg' }) })).status, 503);
    assert.equal(calls.some(call => call[0] === 'remove'), false);
  }
});
test('同內容重送的指紋相同但照片路徑不同，不能互相刪掉照片', async () => {
  const { request, calls } = fixture();
  for (let i = 0; i < 2; i++) await request(saveBody(), { photo: new File([JPEG], 'a.jpg', { type: 'image/jpeg' }) });
  const args = calls.filter(call => call[0] === 'save').map(call => call[1]);
  assert.equal(args[0].p_request_fingerprint, args[1].p_request_fingerprint);
  assert.notEqual(args[0].p_photo_path, args[1].p_photo_path);
});
test('RPC確認重送已有保存時清除本次多餘上傳；清除故障不抹消成功', async () => {
  const { request, calls } = fixture({
    saveRecord: async args => ({ data: { record: { id: args.p_id, ...args.p_record, has_photo: true, version: 1, updated_at: new Date(NOW).toISOString() }, photo_path: '1/already-committed.jpg', unused_photo_paths: [] }, error: null }),
    removePhotos: async (paths, calls) => { calls.push(['remove', paths]); throw Error('cleanup unavailable'); },
  });
  assert.equal((await request(saveBody(), { photo: new File([JPEG], 'a.jpg', { type: 'image/jpeg' }) })).status, 200);
  assert.deepEqual(calls.find(call => call[0] === 'remove')[1], [calls.find(call => call[0] === 'upload')[1]]);
});
test('RPC回傳清理清單也不能刪除任何既有照片', async () => {
  const committedPath = `1/${ID}/committed.jpg`;
  for (const retry of [false, true]) {
    const { request, calls } = fixture({
      saveRecord: async args => ({ data: {
        record: { id: args.p_id, ...args.p_record, has_photo: true, version: 1, updated_at: new Date(NOW).toISOString() },
        photo_path: retry ? committedPath : args.p_photo_path,
        unused_photo_paths: [committedPath, '1/another-committed-photo.jpg'],
      }, error: null }),
    });
    assert.equal((await request(saveBody(), { photo: new File([JPEG], 'a.jpg', { type: 'image/jpeg' }) })).status, 200);
    const removals = calls.filter(call => call[0] === 'remove');
    assert.deepEqual(removals, retry ? [['remove', [calls.find(call => call[0] === 'upload')[1]]]] : []);
  }
});
test('單據簽名使用登入門市查出路徑，只簽五分鐘，不能傳入任意物件路徑', async () => {
  const { request, calls } = fixture();
  assert.equal((await request({ action: 'photo', id: ID }, { token: TOKENS[2] })).status, 200);
  assert.deepEqual(calls[0], ['photo', 2, ID]);
  assert.deepEqual(calls[1], ['sign', `2/${ID}/private.jpg`, 300]);
  assert.equal((await request({ action: 'photo', id: ID, path: '1/secret' })).status, 400);
  assert.equal((await fixture({ photoPath: async () => ({ data: null, error: null }) }).request({ action: 'photo', id: ID })).status, 404);
});
for (const store of [1, 2]) {
  test(`門市${store}刪除要求回403 record_locked且不碰資料庫或照片`, async () => {
    const { request, calls } = fixture();
    for (const expected_version of [1, 3]) {
      const result = await request({ action: 'delete', id: ID, expected_version }, { token: TOKENS[store] });
      assert.equal(result.status, 403);
      assert.deepEqual(result.data, { error: '外送紀錄上傳後僅供查詢，不可編輯或刪除', code: 'record_locked' });
      assert.deepEqual(calls, []);
    }
  });
}
test('禁止刪除仍先驗證登入與門市，錯誤請求同樣不碰資料庫或照片', async () => {
  const { request, calls } = fixture();
  const body = { action: 'delete', id: ID, expected_version: 1 };
  assert.equal((await request(body, { token: '' })).status, 401);
  const denied = await request(body, { token: await sign({ store: 3, admin: false, exp: NOW + 60000 }) });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, undefined);
  assert.equal((await request({ ...body, id: '../another' })).status, 400);
  assert.equal((await request({ ...body, expected_version: 0 })).status, 400);
  assert.equal((await request({ ...body, store_id: 2 })).status, 400);
  assert.deepEqual(calls, []);
});
test('非既有網站Origin拒絕，OPTIONS可正常通過', async () => {
  const { request, handler, calls } = fixture();
  assert.equal((await request(undefined, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await handler(new Request('https://example.invalid', { method: 'OPTIONS' }))).status, 204);
});
