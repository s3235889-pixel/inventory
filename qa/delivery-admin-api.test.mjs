// Node 24+. The signing key is generated locally; every DB/Storage call is fake.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHandler } from '../supabase/functions/delivery-admin-api/handler.ts';
import { DELIVERY_ORIGINS, DistanceError } from '../supabase/functions/delivery-api/distance.ts';

const encoder = new TextEncoder();
const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
const NOW = Date.parse('2026-11-25T06:00:00Z');
const ID = '23701be8-5307-4b4b-ab66-a9eb60ec56d1';
const OTHER_ID = '7a82d41f-57e0-4310-a3fb-c5c22e14c70c';
const REQUEST = 'b73e002b-1889-4bf2-b36b-cd5d674c06d8';
const OTHER_REQUEST = '8ff7f97f-d404-435f-bf53-e38108943518';
const ORIGIN = 'https://s3235889-pixel.github.io';
const JPEG = new Uint8Array([255, 216, 255, 224, 0, 16, 255, 217]);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const WEBP = encoder.encode('RIFF0000WEBP0000');
const b64 = value => Buffer.from(value).toString('base64url');
const hash = async value => Buffer.from(await crypto.subtle.digest('SHA-256', value)).toString('hex');
const PHOTO_HASH = await hash(JPEG);
const pathFor = (store = 1, id = ID) => `${store}/${id}/${REQUEST}-${PHOTO_HASH}.jpg`;
const photo = () => new File([JPEG], 'receipt.jpg', { type: 'image/jpeg' });
async function sign(payload) {
  const data = b64(encoder.encode(JSON.stringify(payload)));
  return `${data}.${b64(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))}`;
}
const CLAIMS = { store: 0, admin: true, version: 3, exp: NOW + 60000 };
const TOKEN = await sign(CLAIMS);
const STORE_TOKENS = [await sign({ store: 1, admin: false, exp: NOW + 60000 }), await sign({ store: 2, admin: false, exp: NOW + 60000 })];
function saveBody(changes = {}) {
  return { action: 'save', store_id: 1, id: ID, request_id: REQUEST, expected_version: 0,
    unit_name: ' 測試單位 ', address: ' 屏東縣潮州鎮測試路1號 ', courier: ' 外送測試員 ',
    delivered_at: '2026-11-25T05:30:00.000Z', amount: 1234.5, distance_km: 3.25, vehicle_type: 'personal', ...changes };
}
function deleteBody(changes = {}) {
  return { action: 'delete', store_id: 1, id: ID, request_id: REQUEST, expected_version: 1, ...changes };
}
function attachBody(changes = {}) { return { ...deleteBody(), action: 'attach_photo', ...changes }; }
function record(changes = {}) {
  return { id: ID, store_id: 1, unit_name: '測試單位', address: '屏東縣潮州鎮測試路1號', courier: '外送測試員',
    delivered_at: '2026-11-25T05:30:00.000Z', amount: 1234.5, distance_km: 3.25, vehicle_type: 'personal',
    has_photo: false, version: 1, updated_at: new Date(NOW).toISOString(), created_at: new Date(NOW - 10000).toISOString(), ...changes };
}
function saveResult(args, changes = {}) {
  return { data: { record: record({ id: args.p_id, store_id: args.p_store_id, ...args.p_record,
    version: args.p_expected_version + 1, has_photo: !!args.p_photo_path }), photo_path: args.p_photo_path, ...changes }, error: null };
}
function attachmentResult(args) {
  const output = record({ id: args.p_id, has_photo: !!args.p_photo_path, version: args.p_expected_version + (args.p_photo_path ? 1 : 0) });
  delete output.store_id; // Existing employee RPC deliberately omits the store.
  delete output.created_at;
  return { data: { record: output, photo_path: args.p_photo_path, ready_for_upload: !args.p_photo_path }, error: null };
}
function fixture(overrides = {}) {
  const calls = [];
  const dependencies = {
    key, now: () => NOW,
    async adminSessionVersion() { calls.push(['auth']); return { data: { session_version: 3 }, error: null }; },
    async loadRecords(...args) { calls.push(['load', ...args]); return { data: { records: [], total_count: 0, total_amount: 0, total_distance_km: 0 }, error: null }; },
    async saveRecord(args) { calls.push(['save', args]); return saveResult(args); },
    async deleteRecord(args) { calls.push(['delete', args]); return { data: { deleted: true, id: args.p_id, store_id: args.p_store_id, version: args.p_expected_version + 1 }, error: null }; },
    async attachRecordPhoto(args) { calls.push(['attach', args]); return attachmentResult(args); },
    async photoPath(store, id) { calls.push(['photo', store, id]); return { data: { photo_path: pathFor(store, id) }, error: null }; },
    async uploadPhoto(...args) { calls.push(['upload', ...args]); return { error: null }; },
    async removePhotos(paths) { calls.push(['remove', paths]); return { error: null }; },
    async signPhoto(...args) { calls.push(['sign', ...args]); return { data: { signedUrl: 'https://example.invalid/private?token=fixture' }, error: null }; },
  };
  for (const [name, value] of Object.entries(overrides)) dependencies[name] = typeof value === 'function' ? (...args) => value(...args, calls) : value;
  const handler = createHandler(dependencies);
  async function request(body = { action: 'load', month: '2026-11', store_id: null }, { token = TOKEN, headers = {}, photo: image = null, multipart = false } = {}) {
    let encoded;
    if (multipart || image) {
      encoded = new FormData();
      encoded.set('payload', typeof body === 'string' ? body : JSON.stringify(body));
      if (image) encoded.set('photo', image);
    } else { encoded = typeof body === 'string' ? body : JSON.stringify(body); headers = { 'Content-Type': 'application/json', ...headers }; }
    const response = await handler(new Request('https://example.invalid/delivery-admin', { method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: encoded }));
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  return { handler, request, calls };
}
const names = calls => calls.map(call => call[0]);
const actions = [
  [{ action: 'load', month: '2026-11', store_id: null }, {}],
  [saveBody(), {}], [deleteBody(), {}], [attachBody(), { photo: photo() }],
  [{ action: 'photo', store_id: 1, id: ID }, {}],
  [{ action: 'distance', store_id: 2, address: '屏東縣潮州鎮測試路1號' }, {}],
];

test('only the existing precise origin is allowed; preflight and method checks need no session', async () => {
  const { handler, request, calls } = fixture();
  const options = await handler(new Request('https://example.invalid', { method: 'OPTIONS', headers: { Origin: ORIGIN } }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(options.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(options.headers.get('cache-control'), 'no-store');
  const get = await handler(new Request('https://example.invalid'));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST, OPTIONS');
  assert.equal((await request(undefined, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.deepEqual(calls, []);
});

test('both genuine employee tokens are forbidden for every action before any DB or storage access', async () => {
  for (const token of [...STORE_TOKENS, await sign({ store: 1, admin: false, exp: NOW - 1 })]) for (const [body, options] of actions) {
    const { request, calls } = fixture();
    const result = await request(body, { ...options, token });
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'admin_required');
    assert.deepEqual(calls, []);
  }
});

test('signed claims must explicitly be admin=true and store=0; request fields cannot elevate identity', async () => {
  for (const claims of [{ admin: false }, { admin: 'true' }, { admin: 1 }, { store: 1 }, { store: 2 }, { store: '0' }, { store: null }]) {
    const { request, calls } = fixture();
    const result = await request(saveBody({ admin: true, store: 0 }), { token: await sign({ ...CLAIMS, ...claims }) });
    assert.equal(result.status, 403);
    assert.deepEqual(calls, []);
  }
});

test('missing, forged, malformed, expired and invalid-version sessions are denied without DB access', async () => {
  const first = TOKEN.split('.')[0];
  const tokens = [null, 'bad', `${first}.${b64(new Uint8Array(32))}`, `${first}.AA`, `e30.${TOKEN.split('.')[1]}`];
  for (const claims of [{ exp: NOW }, { exp: NOW - 1 }, { exp: null }, { exp: '9999999999999' }, { exp: 1.5 },
    { version: null }, { version: undefined }, { version: 0 }, { version: -1 }, { version: '3' }, { version: 1.5 }]) tokens.push(await sign({ ...CLAIMS, ...claims }));
  for (const token of tokens) {
    const { request, calls } = fixture();
    const result = await request(undefined, { token });
    assert.equal(result.status, 401, `token variant rejected`);
    assert.equal(result.data.code, 'admin_session_expired');
    assert.deepEqual(calls, []);
  }
});

test('every action checks the current administrator session version and password changes revoke it', async () => {
  for (const [body, options] of actions) {
    const { request, calls } = fixture({ adminSessionVersion: async calls => {
      calls.push(['auth']); return { data: { session_version: 4 }, error: null };
    } });
    const result = await request(body, options);
    assert.equal(result.status, 401);
    assert.equal(result.data.code, 'admin_session_expired');
    assert.deepEqual(names(calls), ['auth']);
  }
});

test('unavailable session config fails closed as a retryable service error without logging out', async () => {
  for (const result of [{ data: null, error: null }, { data: null, error: { message: 'password_hash SECRET' } },
    { data: { session_version: '3' }, error: null }, { data: { session_version: 0 }, error: null }, new Error('SECRET')]) {
    const { request, calls } = fixture({ adminSessionVersion: async calls => { calls.push(['auth']); if (result instanceof Error) throw result; return result; } });
    const response = await request(saveBody(), { photo: photo() });
    assert.equal(response.status, 503);
    assert.equal(response.data.code, undefined);
    assert.doesNotMatch(JSON.stringify(response.data), /SECRET|password_hash/);
    assert.deepEqual(names(calls), ['auth']);
  }
});

test('adapter queries only session_version and uses dedicated admin RPCs and private non-overwriting uploads', async () => {
  const source = await readFile(new URL('../supabase/functions/delivery-admin-api/index.ts', import.meta.url), 'utf8');
  assert.match(source, /from\('receipt_admin_config'\)\.select\('session_version'\)\.eq\('id', 1\)\.single\(\)/);
  assert.doesNotMatch(source, /select\('\*'\)|select\([^)]*(?:hash|salt|secret)/);
  for (const rpc of ['admin_load_delivery_records', 'admin_save_delivery_record', 'admin_delete_delivery_record']) assert.match(source, new RegExp(`db\\.rpc\\('${rpc}'`));
  assert.match(source, /storage\.from\('delivery-photos'\)/);
  assert.match(source, /upsert: false/);
});

test('month load includes complete rows from only the selected store or both stores and both distance origins', async () => {
  for (const selected of [null, 1, 2]) {
    const rows = (selected ? [selected] : [1, 2]).map(store => record({ store_id: store }));
    const { request, calls } = fixture({ loadRecords: async (store, month, calls) => {
      calls.push(['load', store, month]);
      return { data: { records: rows, total_count: rows.length, total_amount: rows.length * 1234.5, total_distance_km: rows.length * 3.25 }, error: null };
    } });
    const result = await request({ action: 'load', month: '2026-11', store_id: selected });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.records, rows);
    assert.equal(result.data.total_count, rows.length);
    assert.equal(result.data.store_id, selected);
    assert.deepEqual(calls, [['auth'], ['load', selected, '2026-11']]);
    for (const store of [1, 2]) {
      assert.equal(result.data.distance_services[store].origin_address, DELIVERY_ORIGINS[store]);
      assert.equal(result.data.distance_services[store].mode, 'scooter');
    }
  }
});

test('partial, inconsistent and oversized month loads never silently export truncated data', async () => {
  for (const data of [null, { records: [record()], total_count: 2, total_amount: 1, total_distance_km: 1 },
    { records: [record({ store_id: 2 })], total_count: 1, total_amount: 1, total_distance_km: 1 },
    { records: [record({ store_id: 3 })], total_count: 1, total_amount: 1, total_distance_km: 1 }]) {
    const { request } = fixture({ loadRecords: async () => ({ data, error: null }) });
    assert.equal((await request({ action: 'load', month: '2026-11', store_id: 1 })).status, 503);
  }
  const { request } = fixture({ loadRecords: async () => ({ data: { records: Array(10001).fill(record()), total_count: 10001, total_amount: 0, total_distance_km: 0 }, error: null }) });
  const result = await request();
  assert.equal(result.status, 413);
  assert.equal(result.data.code, 'too_many_records');
});

test('month, store and unexpected fields are rejected before data access', async () => {
  for (const body of [
    ...['2026-00', '2026-13', '2026-1', '1899-12', null].map(month => ({ action: 'load', month })),
    ...['1', 0, 3, true].map(store_id => ({ action: 'load', month: '2026-11', store_id })),
    { action: 'load', month: '2026-11', page: 0 }, { action: 'load', month: '2026-11', admin: true },
  ]) {
    const { request, calls } = fixture();
    assert.equal((await request(body)).status, 400);
    assert.deepEqual(names(calls), ['auth']);
  }
});

test('administrator creates for either store with either vehicle and forwards the verified session version', async () => {
  for (const store_id of [1, 2]) for (const vehicle_type of ['personal', 'store']) {
    const { request, calls } = fixture();
    const result = await request(saveBody({ store_id, vehicle_type }));
    assert.equal(result.status, 200);
    assert.equal(result.data.record.store_id, store_id);
    assert.equal(result.data.record.vehicle_type, vehicle_type);
    assert.equal(result.data.record.unit_name, '測試單位');
    assert.equal(result.data.record.address, '屏東縣潮州鎮測試路1號');
    const args = calls.find(call => call[0] === 'save')[1];
    assert.equal(args.p_admin_session_version, 3);
    assert.equal(args.p_store_id, store_id);
    assert.equal(args.p_request_id, REQUEST);
    assert.match(args.p_request_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(args.p_photo_path, null);
  }
});

test('new records require a single valid vehicle; only explicit legacy null is accepted during editing', async () => {
  for (const vehicle_type of [undefined, null, '', 'bike', 'personal ', ['personal', 'store'], true, 0]) {
    const { request, calls } = fixture();
    const response = await request(saveBody({ vehicle_type }), { photo: photo() });
    assert.equal(response.status, 400);
    assert.equal(response.data.code, 'vehicle_type_required');
    assert.deepEqual(names(calls), ['auth']);
  }
  const { request, calls } = fixture();
  const result = await request(saveBody({ expected_version: 3, vehicle_type: null }));
  assert.equal(result.status, 200);
  assert.equal(result.data.record.vehicle_type, null);
  assert.equal(calls[1][1].p_record.vehicle_type, null);
});

test('editing preserves attached receipts and cannot replace or remove them through save', async () => {
  const { request, calls } = fixture({ saveRecord: async (args, calls) => {
    calls.push(['save', args]); const output = saveResult(args); output.data.record.has_photo = true; output.data.photo_path = pathFor(); return output;
  } });
  const response = await request(saveBody({ expected_version: 2, amount: 250 }));
  assert.equal(response.status, 200);
  assert.equal(response.data.record.has_photo, true);
  assert.equal(response.data.record.version, 3);
  assert.equal(response.data.record.amount, 250);
  assert.equal(calls[1][1].p_photo_path, null);
  assert.equal(names(calls).includes('remove'), false);
  const replacement = await request(saveBody({ expected_version: 2 }), { photo: photo() });
  assert.equal(replacement.status, 400);
  assert.equal(replacement.data.code, 'photo_edit_not_allowed');
  assert.equal((await request(saveBody({ expected_version: 2, remove_photo: true }))).status, 400);
  assert.equal(names(calls).filter(name => name === 'save').length, 1);
});

test('save rejects malformed identifiers, precision, dates, partial county and injected identity fields', async () => {
  const invalid = [
    { store_id: 3 }, { store_id: '1' }, { id: '../other' }, { id: null }, { request_id: 'bad' },
    { expected_version: -1 }, { expected_version: '1' }, { expected_version: 1.5 }, { expected_version: 2147483647 },
    { unit_name: '' }, { unit_name: 'x'.repeat(101) }, { address: '屏東縣' }, { address: ' 屏 東 縣 ' },
    { address: 'x'.repeat(301) }, { courier: 'x'.repeat(61) }, { courier: 'a\u0000b' },
    { amount: -0.1 }, { amount: '123' }, { amount: 1.234 }, { amount: 100000000 },
    { distance_km: -1 }, { distance_km: 1.001 }, { distance_km: 100000 },
    { delivered_at: '2026-02-30T05:00:00.000Z' }, { delivered_at: '2026-11-25' },
    { delivered_at: '2026-11-25T13:30:00+08:00' }, { delivered_at: '9999-12-31T16:00:00Z' },
    { admin: true }, { p_admin_session_version: 3 }, { photo_path: pathFor() }, { deleted_at: null },
  ];
  for (const change of invalid) {
    const { request, calls } = fixture();
    assert.equal((await request(saveBody(change), { photo: photo() })).status, 400, JSON.stringify(change));
    assert.deepEqual(names(calls), ['auth']);
  }
});

test('fingerprints are stable across request retries and include store, record, version, data and image bytes', async () => {
  const { request, calls } = fixture();
  for (const changes of [{}, { request_id: OTHER_REQUEST }, { store_id: 2 }, { id: OTHER_ID }, { expected_version: 1 }, { vehicle_type: 'store' }]) assert.equal((await request(saveBody(changes))).status, 200);
  const fingerprints = calls.filter(call => call[0] === 'save').map(call => call[1].p_request_fingerprint);
  assert.equal(fingerprints[0], fingerprints[1]);
  assert.equal(new Set(fingerprints.slice(1)).size, 5);
  for (let n = 0; n < 2; n++) assert.equal((await request(saveBody(), { photo: photo() })).status, 200);
  const uploads = calls.filter(call => call[0] === 'upload');
  const withPhoto = calls.filter(call => call[0] === 'save').slice(-2);
  assert.equal(withPhoto[0][1].p_request_fingerprint, withPhoto[1][1].p_request_fingerprint);
  assert.notEqual(withPhoto[0][1].p_request_fingerprint, fingerprints[0]);
  assert.notEqual(uploads[0][1], uploads[1][1]);
  assert.match(uploads[0][1], new RegExp(`^1/${ID}/[a-f0-9-]{36}-${PHOTO_HASH}\\.jpg$`));
});

test('upload recognizes JPEG, PNG and WebP bytes and rejects MIME spoofing or empty files', async () => {
  for (const [bytes, type, ext] of [[JPEG, 'image/jpeg', 'jpg'], [PNG, 'image/png', 'png'], [WEBP, 'image/webp', 'webp']]) {
    const { request, calls } = fixture();
    assert.equal((await request(saveBody(), { photo: new File([bytes], `x.${ext}`, { type }) })).status, 200);
    const upload = calls.find(call => call[0] === 'upload');
    assert.equal(upload[3], type);
    assert.match(upload[1], new RegExp(`\\.${ext}$`));
  }
  for (const image of [new File([], 'empty.jpg', { type: 'image/jpeg' }), new File([JPEG], 'spoof.png', { type: 'image/png' }),
    new File(['<script>secret</script>'], 'fake.jpg', { type: 'image/jpeg' })]) {
    const { request, calls } = fixture();
    assert.ok([400, 415].includes((await request(saveBody(), { photo: image })).status));
    assert.deepEqual(names(calls), ['auth']);
  }
});

test('malformed, duplicate, extra, oversized and unsupported bodies never reach mutations', async () => {
  const { handler, request, calls } = fixture();
  for (const body of ['{', '[]', 'null']) assert.equal((await request(body)).status, 400);
  assert.equal((await request(saveBody(), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request('x'.repeat(32769))).status, 413);
  assert.equal((await request(saveBody(), { photo: new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' }) })).status, 413);
  for (const variant of ['duplicatePayload', 'duplicatePhoto', 'extra', 'stringPhoto']) {
    const form = new FormData(); form.set('payload', JSON.stringify(saveBody()));
    if (variant === 'duplicatePayload') form.append('payload', JSON.stringify(saveBody()));
    if (variant === 'duplicatePhoto') { form.append('photo', photo()); form.append('photo', photo()); }
    if (variant === 'extra') form.set('admin', 'true');
    if (variant === 'stringPhoto') form.set('photo', 'fake-file');
    const response = await handler(new Request('https://example.invalid', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form }));
    assert.equal(response.status, 400);
  }
  assert.ok(names(calls).every(name => name === 'auth'));
});

test('definitive rollback cleans only the current new-object attempt and sanitizes database errors', async () => {
  const expectations = { '22023': 400, '23502': 400, '23503': 400, '23505': 409, '23514': 400, '40001': 409, '42501': 401, '55000': 409, P0002: 404 };
  for (const [code, status] of Object.entries(expectations)) {
    const { request, calls } = fixture({ saveRecord: async (args, calls) => {
      calls.push(['save', args]); return { data: null, error: { code, message: 'private DB detail SECRET' } };
    } });
    const result = await request(saveBody(), { photo: photo() });
    assert.equal(result.status, status, code);
    assert.doesNotMatch(JSON.stringify(result.data), /SECRET|private DB detail/);
    assert.deepEqual(names(calls), ['auth', 'upload', 'save', 'remove']);
    assert.deepEqual(calls[3][1], [calls[1][1]]);
  }
});

test('unknown commit state, transport failures and incomplete confirmations always retain uploaded photos', async () => {
  for (const outcome of [{ data: null, error: { code: '08007' } }, { data: null, error: { code: '40003' } },
    { data: null, error: { code: 'PGRST001' } }, { data: null, error: { message: 'SECRET transport' } },
    { data: null, error: null }, { data: { record: record(), photo_path: null }, error: null }, new Error('SECRET')]) {
    const { request, calls } = fixture({ saveRecord: async (args, calls) => {
      calls.push(['save', args]); if (outcome instanceof Error) throw outcome; return outcome;
    } });
    const result = await request(saveBody(), { photo: photo() });
    assert.equal(result.status, 503);
    assert.doesNotMatch(JSON.stringify(result.data), /SECRET/);
    assert.deepEqual(names(calls), ['auth', 'upload', 'save']);
  }
});

test('wrong-store or wrong-content success confirmations cannot cause deletion of the uploaded object', async () => {
  for (const committedPath of [pathFor(2), pathFor(1, OTHER_ID), pathFor().replace(PHOTO_HASH, 'f'.repeat(64)), 'invalid']) {
    const { request, calls } = fixture({ saveRecord: async (args, calls) => {
      calls.push(['save', args]); return saveResult(args, { photo_path: committedPath });
    } });
    assert.equal((await request(saveBody(), { photo: photo() })).status, 503);
    assert.equal(names(calls).includes('remove'), false);
  }
});

test('lost save response can safely retry the same request, cleaning only the later unused object', async () => {
  let committed;
  const { request, calls } = fixture({ saveRecord: async (args, calls) => {
    calls.push(['save', args]);
    if (!committed) { committed = saveResult(args); return { data: null, error: { code: '40003' } }; }
    return committed;
  } });
  assert.equal((await request(saveBody(), { photo: photo() })).status, 503);
  assert.equal((await request(saveBody(), { photo: photo() })).status, 200);
  const uploads = calls.filter(call => call[0] === 'upload');
  const removals = calls.filter(call => call[0] === 'remove');
  assert.notEqual(uploads[0][1], uploads[1][1]);
  assert.deepEqual(removals, [['remove', [uploads[1][1]]]]);
  assert.equal(committed.data.photo_path, uploads[0][1]);
});

test('concurrent identical creates use separate objects and cannot clean the successful object', async () => {
  let committed;
  const { request, calls } = fixture({ saveRecord: async (args, calls) => {
    calls.push(['save', args]); committed ||= saveResult(args); return committed;
  } });
  const results = await Promise.all([request(saveBody(), { photo: photo() }), request(saveBody(), { photo: photo() })]);
  assert.ok(results.every(result => result.status === 200));
  const paths = calls.filter(call => call[0] === 'upload').map(call => call[1]);
  assert.equal(new Set(paths).size, 2);
  assert.deepEqual(calls.filter(call => call[0] === 'remove'), [['remove', paths.filter(path => path !== committed.data.photo_path)]]);
});

test('cleanup failure does not conceal a confirmed mutation or a precise rejected mutation', async () => {
  for (const rejected of [false, true]) {
    const { request } = fixture({ saveRecord: async args => rejected
      ? { data: null, error: { code: '40001' } }
      : saveResult(args, { photo_path: pathFor() }), removePhotos: async () => { throw new Error('SECRET cleanup'); } });
    const result = await request(saveBody(), { photo: photo() });
    assert.equal(result.status, rejected ? 409 : 200);
  }
});

test('upload failure never sends the database mutation or attempts to delete uncertain objects', async () => {
  for (const action of ['save', 'attach_photo']) {
    const { request, calls } = fixture({ uploadPhoto: async (path, bytes, mime, calls) => {
      calls.push(['upload', path]); return { error: { message: 'SECRET storage' } };
    } });
    const result = await request(action === 'save' ? saveBody() : attachBody(), { photo: photo() });
    assert.equal(result.status, 503);
    assert.doesNotMatch(JSON.stringify(result.data), /SECRET/);
    assert.equal(names(calls).includes('save'), false);
    assert.equal(names(calls).includes('remove'), false);
    assert.equal(calls.filter(call => call[0] === 'attach' && call[1].p_photo_path).length, 0);
  }
});

test('conflicts remain distinct from authentication loss, including a revoke between auth and write', async () => {
  for (const operation of ['saveRecord', 'deleteRecord']) for (const [code, expectedStatus, expectedCode] of [
    ['40001', 409, 'record_conflict'], ['P0002', 404, 'record_not_found'], ['42501', 401, 'admin_session_expired'],
  ]) {
    const { request } = fixture({ [operation]: async () => ({ data: null, error: { code } }) });
    const result = await request(operation === 'saveRecord' ? saveBody({ expected_version: 1 }) : deleteBody());
    assert.equal(result.status, expectedStatus);
    assert.equal(result.data.code, expectedCode);
  }
});

test('delete forwards a stable idempotency fingerprint and never deletes receipt storage', async () => {
  const { request, calls } = fixture();
  for (let n = 0; n < 2; n++) {
    const result = await request(deleteBody({ store_id: 2, expected_version: 5 }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { deleted: true, id: ID, store_id: 2, version: 6 });
  }
  const args = calls.filter(call => call[0] === 'delete').map(call => call[1]);
  assert.deepEqual(args[0], args[1]);
  assert.equal(args[0].p_admin_session_version, 3);
  assert.match(args[0].p_request_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(names(calls).includes('remove'), false);
  assert.equal(names(calls).includes('photo'), false);
});

test('delete rejects incomplete confirmation, cross-store results and ambiguous failures as retryable', async () => {
  for (const result of [{ data: null, error: null }, { data: { deleted: true, id: ID, store_id: 2, version: 2 }, error: null },
    { data: { deleted: true, id: ID, store_id: 1, version: 1 }, error: null }, { data: null, error: { code: '08007' } }, new Error('SECRET')]) {
    const { request, calls } = fixture({ deleteRecord: async () => { if (result instanceof Error) throw result; return result; } });
    const output = await request(deleteBody());
    assert.equal(output.status, 503);
    assert.doesNotMatch(JSON.stringify(output.data), /SECRET/);
    assert.equal(names(calls).includes('remove'), false);
  }
});

test('delete enforces positive version, UUIDs, valid store, allowed fields and no photo', async () => {
  for (const changes of [{ expected_version: 0 }, { request_id: null }, { id: 'bad' }, { store_id: 3 }, { photo_path: 'x' }, { amount: 1 }]) {
    const { request, calls } = fixture();
    assert.equal((await request(deleteBody(changes))).status, 400);
    assert.deepEqual(names(calls), ['auth']);
  }
  assert.equal((await fixture().request(deleteBody(), { photo: photo() })).status, 400);
});

test('one-time attachment preflights before upload and enriches the existing RPC record with its store', async () => {
  const { request, calls } = fixture();
  const output = await request(attachBody({ store_id: 2 }), { photo: photo() });
  assert.equal(output.status, 200);
  assert.equal(output.data.record.store_id, 2);
  assert.equal(output.data.record.has_photo, true);
  assert.equal(output.data.record.version, 2);
  assert.deepEqual(names(calls), ['auth', 'attach', 'upload', 'attach']);
  assert.equal(calls[1][1].p_photo_path, null);
  assert.equal(calls[1][1].p_photo_hash, PHOTO_HASH);
  assert.equal(calls[3][1].p_photo_path, calls[2][1]);
  assert.equal(calls[3][1].p_store_id, 2);
});

test('photo lock is a data restriction, distinct from invalid admin auth, and causes no upload', async () => {
  const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
    calls.push(['attach', args]); return { data: null, error: { code: '55000', message: 'SECRET' } };
  } });
  const output = await request(attachBody(), { photo: photo() });
  assert.equal(output.status, 403);
  assert.equal(output.data.code, 'photo_locked');
  assert.deepEqual(names(calls), ['auth', 'attach']);
  assert.doesNotMatch(JSON.stringify(output.data), /SECRET/);
});

test('attachment exact replay returns the committed result without uploading another object', async () => {
  const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
    calls.push(['attach', args]); return attachmentResult({ ...args, p_photo_path: pathFor(args.p_store_id) });
  } });
  const output = await request(attachBody(), { photo: photo() });
  assert.equal(output.status, 200);
  assert.deepEqual(names(calls), ['auth', 'attach']);
});

test('attachment never mixes new receipt upload with editing record fields', async () => {
  for (const change of [{ amount: 0 }, { address: 'new' }, { vehicle_type: 'store' }, { remove_photo: true }, { expected_version: 0 }]) {
    const { request, calls } = fixture();
    assert.equal((await request(attachBody(change), { photo: photo() })).status, 400);
    assert.deepEqual(names(calls), ['auth']);
  }
  assert.equal((await fixture().request(attachBody())).status, 400);
});

test('attachment unknown commit or partial result retains photos, definitive rollback removes only this attempt', async () => {
  for (const [code, expectedStatus, cleanup] of [['08007', 503, false], ['40003', 503, false], ['40001', 409, true], ['55000', 403, true], ['P0002', 404, true]]) {
    const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
      calls.push(['attach', args]); return args.p_photo_path ? { data: null, error: { code } } : attachmentResult(args);
    } });
    const output = await request(attachBody(), { photo: photo() });
    assert.equal(output.status, expectedStatus);
    assert.equal(names(calls).includes('remove'), cleanup);
    if (cleanup) assert.deepEqual(calls.at(-1), ['remove', [calls[2][1]]]);
  }
  const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
    calls.push(['attach', args]); return args.p_photo_path ? { data: null, error: null } : attachmentResult(args);
  } });
  assert.equal((await request(attachBody(), { photo: photo() })).status, 503);
  assert.equal(names(calls).includes('remove'), false);
});

test('attachment lost commit response is resolved on replay without replacing or deleting the receipt', async () => {
  let committed;
  const { request, calls } = fixture({ attachRecordPhoto: async (args, calls) => {
    calls.push(['attach', args]);
    if (committed) return committed;
    if (!args.p_photo_path) return attachmentResult(args);
    committed = attachmentResult(args);
    return { data: null, error: { code: '08007' } };
  } });
  assert.equal((await request(attachBody(), { photo: photo() })).status, 503);
  assert.equal((await request(attachBody(), { photo: photo() })).status, 200);
  assert.equal(names(calls).filter(name => name === 'upload').length, 1);
  assert.equal(names(calls).includes('remove'), false);
});

test('private receipt links are store-bound, signed for five minutes and never include raw record metadata', async () => {
  for (const store_id of [1, 2]) {
    const { request, calls } = fixture();
    const output = await request({ action: 'photo', store_id, id: ID });
    assert.equal(output.status, 200);
    assert.deepEqual(output.data, { url: 'https://example.invalid/private?token=fixture' });
    assert.deepEqual(calls, [['auth'], ['photo', store_id, ID], ['sign', pathFor(store_id), 300]]);
  }
  for (const path of [null, pathFor(2), `${pathFor()}/../secret.jpg`, 'https://evil.invalid/receipt.jpg']) {
    const { request, calls } = fixture({ photoPath: async () => ({ data: { photo_path: path }, error: null }) });
    assert.equal((await request({ action: 'photo', store_id: 1, id: ID })).status, path ? 503 : 404);
    assert.equal(names(calls).includes('sign'), false);
  }
});

test('public responses whitelist record fields instead of returning private paths, audit or auth details', async () => {
  const { request } = fixture({ saveRecord: async args => {
    const result = saveResult(args); Object.assign(result.data.record, { photo_path: pathFor(), password_hash: 'SECRET', last_request_id: REQUEST, deleted_at: null });
    return result;
  } });
  const output = await request(saveBody());
  assert.equal(output.status, 200);
  assert.deepEqual(Object.keys(output.data), ['record']);
  for (const key of ['photo_path', 'password_hash', 'last_request_id', 'deleted_at']) assert.equal(Object.hasOwn(output.data.record, key), false);
});

test('distance reuses the scooter service for the chosen store with a hashed session identity', async () => {
  const distanceCalls = [];
  const distance = { info: store => ({ available: true, origin_address: DELIVERY_ORIGINS[store], mode: 'scooter', provider: 'geoapify' }),
    async calculate(store, address, sessionKey) { distanceCalls.push([store, address, sessionKey]); return { distance_km: 1.75, address,
      matched_address: address, origin_address: DELIVERY_ORIGINS[store], mode: 'scooter', provider: 'geoapify', estimated: true }; } };
  const { request, calls } = fixture({ distance });
  for (const store_id of [1, 2]) {
    const output = await request({ action: 'distance', store_id, address: ' 屏東縣潮州鎮測試路1號 ' });
    assert.equal(output.status, 200);
    assert.equal(output.data.mode, 'scooter');
    assert.equal(output.data.origin_address, DELIVERY_ORIGINS[store_id]);
    assert.equal(output.data.distance_km, 1.75);
  }
  assert.deepEqual(names(calls), ['auth', 'auth']);
  assert.deepEqual(distanceCalls.map(call => call.slice(0, 2)), [[1, '屏東縣潮州鎮測試路1號'], [2, '屏東縣潮州鎮測試路1號']]);
  assert.equal(distanceCalls[0][2], await hash(encoder.encode(`Bearer ${TOKEN}`)));
  assert.notEqual(distanceCalls[0][2], TOKEN);
});

test('distance invalid inputs, rate limits and provider failures return bounded public errors', async () => {
  let count = 0;
  const distance = { info: () => ({}), async calculate() { count++; throw new DistanceError('查詢太頻繁，請稍候', 429, 'distance_rate_limited', 12); } };
  const { request } = fixture({ distance });
  for (const address of ['', 'a\u0000b', 'a\nb', 'x'.repeat(301), null]) {
    const output = await request({ action: 'distance', store_id: 1, address });
    assert.equal(output.status, 422);
    assert.equal(output.data.code, 'distance_address_invalid');
  }
  assert.equal(count, 0);
  const rateLimited = await request({ action: 'distance', store_id: 1, address: '屏東縣潮州鎮測試路1號' });
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get('retry-after'), '12');
  assert.equal(rateLimited.headers.get('access-control-expose-headers'), 'Retry-After');
  distance.calculate = async () => { throw new Error('api_key SECRET customer address'); };
  const unavailable = await request({ action: 'distance', store_id: 1, address: '屏東縣潮州鎮測試路1號' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.data.code, 'distance_unavailable');
  assert.doesNotMatch(JSON.stringify(unavailable.data), /SECRET|customer|api_key/);
});
