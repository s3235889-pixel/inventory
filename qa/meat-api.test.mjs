// Run with Node 24+: node --test qa/meat-api.test.mjs
// Every key/token is generated only for these tests. No network or database calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createHandler } from '../supabase/functions/meat-inventory-api/handler.ts';

const encoder = new TextEncoder();
const key = await crypto.subtle.importKey(
  'raw', encoder.encode('test-only-not-a-real-secret'),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
);
// In Taiwan this is already November 18.
const NOW = Date.parse('2026-11-17T16:15:00Z');
const base = { action: 'load', date: '2026-11-18' };
const b64 = bytes => Buffer.from(bytes).toString('base64url');
async function sign(payload) {
  const encoded = b64(encoder.encode(JSON.stringify(payload)));
  return encoded + '.' + b64(await crypto.subtle.sign('HMAC', key, encoder.encode(encoded)));
}
const auth = await sign({ store: 2, admin: false, version: 1, exp: NOW + 3600000 });

function fixture(error = null) {
  const calls = [];
  const handler = createHandler({
    key, now: () => NOW,
    async loadDays(...args) {
      calls.push(['load', ...args]);
      return { data: [], error };
    },
    async saveDay(args) {
      calls.push(['save', args]);
      return {
        data: {
          business_date: args.p_date, meats: args.p_meats, note: args.p_note,
          version: 1, updated_at: new Date(NOW).toISOString(),
        },
        error,
      };
    },
  });
  async function request(body = base, token = auth, headers = {}) {
    const response = await handler(new Request('https://example.invalid/meat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }));
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  return { handler, request, calls };
}
function saveBody() {
  const counts = { closing: 8, thaw: 20, extra: 0, waste: 0, target: null };
  return {
    action: 'save', date: '2026-11-18',
    meats: { beef: { ...counts }, pork: { ...counts }, chicken: { ...counts } },
    note: '測試', expected_version: 0, request_id: crypto.randomUUID(),
  };
}

test('木崎登入可讀資料，日期依台灣時區且回應不快取', async () => {
  const { request, calls } = fixture();
  const result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.data.today, '2026-11-18');
  assert.equal(result.data.start, '2026-10-25');
  assert.equal(result.data.end, '2026-11-18');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls[0], ['load', 2, '2026-10-25', '2026-11-18']);
});

test('歷史月份載入包含前七天及月底次日', async () => {
  const result = await fixture().request({ action: 'load', date: '2026-02-28' });
  assert.equal(result.status, 200);
  assert.equal(result.data.start, '2026-01-25');
  assert.equal(result.data.end, '2026-03-01');
});

for (const [name, payload] of [
  ['其他門市', { store: 1, admin: false, exp: NOW + 1 }],
  ['主管', { store: 0, admin: true, exp: NOW + 1 }],
  ['聲稱木崎的主管', { store: 2, admin: true, exp: NOW + 1 }],
  ['非數字門市識別', { store: '2', admin: false, exp: NOW + 1 }],
]) {
  test(`${name}的有效簽章仍不能存取木崎庫存`, async () => {
    const { request, calls } = fixture();
    assert.equal((await request(base, await sign(payload))).status, 403);
    assert.equal(calls.length, 0);
  });
}

for (const [name, token] of [
  ['未登入', ''],
  ['偽造簽章', auth.slice(0, -3) + 'abc'],
  ['損壞格式', 'abc.def'],
  ['缺少到期時間', await sign({ store: 2, admin: false })],
  ['文字到期時間', await sign({ store: 2, admin: false, exp: String(NOW + 100) })],
  ['恰好到期', await sign({ store: 2, admin: false, exp: NOW })],
  ['已過期', await sign({ store: 2, admin: false, exp: NOW - 1 })],
]) {
  test(`${name}回401而不讀取資料`, async () => {
    const { request, calls } = fixture();
    assert.equal((await request(base, token)).status, 401);
    assert.equal(calls.length, 0);
  });
}

for (const [name, date] of [
  ['不存在日期', '2026-02-30'], ['未來日期', '2026-11-19'],
  ['過早日期', '1899-12-31'], ['不完整格式', '2026-1-01'],
  ['文字', 'invalid'], ['空值', null], ['數字', 22],
]) {
  test(`拒絕${name}的盤點日期`, async () => {
    const { request, calls } = fixture();
    assert.equal((await request({ action: 'load', date })).status, 400);
    assert.equal(calls.length, 0);
  });
}

test('三種肉一次送至RPC，門市固定為木崎', async () => {
  const { request, calls } = fixture();
  const result = await request(saveBody());
  assert.equal(result.status, 200);
  assert.equal(result.data.record.meats.beef.closing, 8);
  assert.equal(calls.at(-1)[1].p_store_id, 2);
  assert.equal(Object.keys(calls.at(-1)[1].p_meats).length, 3);
});

for (const [name, value] of [
  ['空值', null], ['空字串', ''], ['負數', -1], ['兩位小數', 0.01],
  ['超過上限', 10001], ['數字字串', '3'], ['布林值', true],
]) {
  test(`冷藏份數${name}不能默默轉成零或其他數值`, async () => {
    const { request, calls } = fixture();
    const body = saveBody();
    body.meats.beef.closing = value;
    assert.equal((await request(body)).status, 400);
    assert.equal(calls.length, 0);
  });
}

for (const [name, mutate] of [
  ['漏填雞胸肉', body => { delete body.meats.chicken; }],
  ['多餘肉類', body => { body.meats.turkey = body.meats.beef; }],
  ['未知盤點欄位', body => { body.meats.beef.unexpected = 1; }],
  ['需求空字串', body => { body.meats.beef.target = ''; }],
  ['過長備註', body => { body.note = 'a'.repeat(501); }],
  ['字串版本', body => { body.expected_version = '0'; }],
  ['負版本', body => { body.expected_version = -1; }],
  ['小數版本', body => { body.expected_version = 0.1; }],
  ['損壞請求識別碼', body => { body.request_id = 'wrong'; }],
  ['試圖指定另一門市', body => { body.store_id = 3; }],
]) {
  test(`拒絕${name}而不寫入`, async () => {
    const { request, calls } = fixture();
    const body = saveBody();
    mutate(body);
    assert.equal((await request(body)).status, 400);
    assert.equal(calls.length, 0);
  });
}

test('損壞JSON回400', async () => {
  assert.equal((await fixture().request('{bad json')).status, 400);
});
test('非GitHub Pages來源回403', async () => {
  const { request, calls } = fixture();
  assert.equal((await request(base, auth, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal(calls.length, 0);
});
test('實際本文超過32KB回413', async () => {
  assert.equal((await fixture().request('x'.repeat(32769))).status, 413);
});

for (const [code, status] of [['40001', 409], ['23505', 409], ['22023', 400], ['XX000', 500]]) {
  test(`RPC ${code}正確回${status}，內部錯誤不外洩`, async () => {
    const error = { code, message: code === '22023' ? '盤點數量錯誤' : 'private sql detail' };
    const result = await fixture(error).request(saveBody());
    assert.equal(result.status, status);
    assert.equal(JSON.stringify(result.data).includes('private sql detail'), false);
  });
}

for (const [method, status] of [['GET', 405], ['OPTIONS', 204]]) {
  test(`${method}回${status}`, async () => {
    const { handler, calls } = fixture();
    const response = await handler(new Request('https://example.invalid/meat', { method }));
    assert.equal(response.status, status);
    assert.equal(calls.length, 0);
  });
}

test('Edge入口TypeScript可解析', () => {
  const source = readFileSync(new URL('../supabase/functions/meat-inventory-api/index.ts', import.meta.url), 'utf8');
  assert.equal(typeof stripTypeScriptTypes(source), 'string');
});
