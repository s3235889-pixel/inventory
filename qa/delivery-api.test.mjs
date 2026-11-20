// Node 24+, all tokens/keys are test-only and all data/storage calls are in-memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from '../supabase/functions/delivery-api/handler.ts';

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
