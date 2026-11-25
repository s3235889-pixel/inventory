// Actual admin HTML/JS behavior, with network and camera isolated from customer data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom')); }
catch { ({ JSDOM, VirtualConsole } = require(path.resolve(__dirname, '../../qa-runtime/node_modules/jsdom'))); }
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'delivery-admin.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'delivery-admin.js'), 'utf8')
  .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/delivery-admin-core\.mjs[^'"]*['"];?\s*/m, 'const {$1} = window.__core;\n')
  .replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/delivery-export\.mjs[^'"]*['"];?\s*/m, 'const {$1} = window.__export;\n');
const corePromise = import(pathToFileURL(path.join(root, 'delivery-admin-core.mjs')).href);
const clone = value => JSON.parse(JSON.stringify(value));
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => clone(body) });
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { resolve, reject, promise }; };
async function waitFor(predicate, label = 'UI did not settle') {
  const limit = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > limit) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const makeRow = (month, overrides = {}) => ({ id: randomUUID(), store_id: 1, unit_name: '潮州國小', address: '屏東縣潮州鎮中山路1號', courier: '小陳', delivered_at: `${month}-05T06:30:00.000Z`, amount: 600, distance_km: 2.5, vehicle_type: 'personal', has_photo: false, version: 1, created_at: `${month}-05T06:30:00.000Z`, ...overrides });

async function harness(options = {}) {
  const core = await corePromise, month = core.taipeiDateTime().slice(0, 7), virtualConsole = new VirtualConsole(), errors = [];
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'https://s3235889-pixel.github.io/inventory/delivery-admin.html', runScripts: 'outside-only', virtualConsole });
  const w = dom.window;
  const token = Object.hasOwn(options, 'token') ? options.token : 'fixture-admin-token';
  if (token) w.sessionStorage.setItem('receipt-admin-session', token);
  w.__core = core;
  Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
  w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  w.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  let objectCounter = 0;
  const h = {
    dom, w, core, month, token, errors, requests: [], exports: [], downloads: [], confirmations: [], uploads: [], revoked: [],
    records: options.records ? options.records(month) : [], handler: options.handler || null, decode: () => Promise.resolve(), mutations: new Map(),
    $: id => w.document.getElementById(id),
    set(id, value, event = 'input') { const el = this.$(id); el.value = String(value); el.dispatchEvent(new w.Event(event, { bubbles: true })); },
    click(id) { this.$(id).click(); },
    submit(id = 'editor-form') { this.$(id).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); },
    action(action, id = this.records[0]?.id) { const button = w.document.querySelector(`#rows button[data-action="${action}"][data-id="${id}"]`); assert.ok(button, `Missing ${action} action`); button.click(); },
    fill(overrides = {}) {
      const fields = { 'edit-unit': ' 新外送單位 ', 'edit-address': '屏東縣潮州鎮文化路10號', 'edit-courier': '小林', 'edit-date': `${month}-01T00:05`, 'edit-amount': '700.50', 'edit-distance': '3.25', ...overrides };
      for (const [id, value] of Object.entries(fields)) this.set(id, value);
      this.click('edit-personal');
    },
    photo(kind = 'editor', bytes = 'camera photo', type = 'image/jpeg') {
      const file = new w.File([bytes], 'photo.jpg', { type }), input = this.$(`${kind}-gallery-input`);
      Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new w.Event('change', { bubbles: true }));
    },
    photoBytes(photo) { return new Promise((resolve, reject) => { const reader = new w.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(photo); }); },
    async ready() { await waitFor(() => !this.$('workspace').hidden && !this.$('month').disabled, 'Workspace did not load'); },
    async idle() { await waitFor(() => !this.$('month').disabled, 'Main controls stayed busy'); },
    async photoReady(kind = 'editor') { await waitFor(() => !this.$(`${kind}-photo-preview-wrap`).hidden && !this.$(`${kind}-photo-preview`).hidden && !this.$(`${kind}-camera`).disabled, 'Photo did not prepare'); },
    close() { dom.window.close(); },
    defaultResponse(body, photo) {
      if (body.action === 'admin_login') return response(200, { token: 'new-fixture-admin-token' });
      if (body.action === 'load') {
        const rows = this.records.filter(row => core.taipeiDateTime(row.delivered_at).slice(0, 7) === body.month && (!body.store_id || row.store_id === body.store_id));
        return response(200, { records: rows, total_count: rows.length, total_amount: core.recordTotals(rows).amount, total_distance_km: core.recordTotals(rows).distance,
          distance_services: Object.fromEntries([1, 2].map(store => [String(store), { available: options.distanceAvailable === true, mode: 'scooter', provider: 'geoapify', origin_address: core.STORE_ORIGINS[store] }])) });
      }
      if (body.action === 'distance') return response(200, { distance_km: 3.27, address: body.address, matched_address: body.address, origin_address: core.STORE_ORIGINS[body.store_id], mode: 'scooter', provider: 'geoapify', estimated: true });
      if (body.action === 'photo') return response(200, { url: 'https://rjetwgrelmvciatouwiw.supabase.co/storage/v1/object/sign/delivery-photos/1/receipt.jpg?token=fixture-photo' });
      if (this.mutations.has(body.request_id)) return response(200, this.mutations.get(body.request_id));
      const old = this.records.find(row => row.id === body.id);
      if (body.action === 'save') {
        const record = { ...body, has_photo: !!old?.has_photo || !!photo, version: (old?.version || 0) + 1, created_at: old?.created_at || new Date().toISOString() };
        this.records = [record, ...this.records.filter(row => row.id !== record.id)]; const result = { record }; this.mutations.set(body.request_id, result); return response(200, result);
      }
      if (body.action === 'delete') {
        this.records = this.records.filter(row => row.id !== body.id); const result = { deleted: true, id: body.id, store_id: body.store_id, version: (old?.version || 0) + 1 }; this.mutations.set(body.request_id, result); return response(200, result);
      }
      if (body.action === 'attach_photo') {
        const record = { ...old, has_photo: true, version: old.version + 1 }; this.records = this.records.map(row => row.id === body.id ? record : row);
        const result = { record }; this.mutations.set(body.request_id, result); return response(200, result);
      }
      return response(400, { error: 'Unsupported action' });
    },
  };
  w.confirm = message => { h.confirmations.push(message); return true; };
  w.URL.createObjectURL = () => `blob:fixture-${++objectCounter}`;
  w.URL.revokeObjectURL = url => h.revoked.push(url);
  w.HTMLAnchorElement.prototype.click = function () { h.downloads.push({ filename: this.download, href: this.href }); };
  w.__export = { createDeliveryWorkbook: (records, meta) => { h.exports.push({ records: clone(records), meta: clone(meta) }); return new Uint8Array([80, 75, 3, 4]); }, deliveryExportFilename: ({ month }) => `delivery-${month}.xlsx` };
  w.Image = class { constructor() { this.width = 3200; this.height = 2400; } decode() { return h.decode(this.src); } };
  w.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '', fillRect() {}, drawImage() {} });
  w.HTMLCanvasElement.prototype.toBlob = callback => callback(new w.Blob(['compressed image bytes'], { type: 'image/jpeg' }));
  w.fetch = async (url, init) => {
    assert.ok(url === 'https://rjetwgrelmvciatouwiw.supabase.co/functions/v1/delivery-admin-api' || url === 'https://rjetwgrelmvciatouwiw.supabase.co/functions/v1/receipt-api');
    const multipart = init.body instanceof w.FormData, body = multipart ? JSON.parse(init.body.get('payload')) : JSON.parse(init.body), photo = multipart ? init.body.get('photo') : null;
    if (body.action !== 'admin_login') assert.equal(init.headers.Authorization, `Bearer ${w.sessionStorage.getItem('receipt-admin-session')}`);
    h.requests.push({ ...clone(body), multipart, hasPhoto: !!photo }); if (photo) h.uploads.push({ action: body.action, photo });
    return h.handler ? h.handler(body, h, photo, init.signal) : h.defaultResponse(body, photo);
  };
  new vm.Script(source, { filename: 'delivery-admin.js' }).runInContext(dom.getInternalVMContext());
  return h;
}

test('no token exposes only manager login; a store token rejected by server never reveals records', async () => {
  const h = await harness({ token: null });
  try { assert.equal(h.$('workspace').hidden, true); assert.equal(h.$('login').hidden, false); assert.equal(h.requests.length, 0); assert.equal(h.$('password').minLength, 4); assert.equal(h.w.document.querySelector('.back-link').target, '_top'); }
  finally { h.close(); }
  const denied = await harness({ token: 'store-session', handler: () => response(403, { error: '僅限主管', code: 'admin_required' }) });
  try { await waitFor(() => !denied.$('password').disabled); assert.equal(denied.$('workspace').hidden, true); assert.equal(denied.$('rows').children.length, 0); assert.equal(denied.w.sessionStorage.getItem('receipt-admin-session'), null); }
  finally { denied.close(); }
});

test('existing manager token must complete server verification before workspace appears', async () => {
  const gate = deferred(), h = await harness({ handler: async (body, h, photo) => { await gate.promise; return h.defaultResponse(body, photo); } });
  try { assert.equal(h.$('workspace').hidden, true); assert.equal(h.$('login-submit').disabled, true); gate.resolve(); await h.ready(); assert.equal(h.requests.length, 1); assert.equal(h.requests[0].action, 'load'); assert.equal(h.requests[0].store_id, null); }
  finally { h.close(); }
});

test('manager password is sent only to login and cleared; failed verification can retry without exposing data', async () => {
  let unavailable = true;
  const h = await harness({ token: null, handler: (body, h, photo) => body.action === 'load' && unavailable ? response(503, { error: '暫時無法讀取' }) : h.defaultResponse(body, photo) });
  try {
    h.set('password', 'secret-fixture-password'); h.submit('login-form');
    await waitFor(() => !h.$('login-retry').hidden); assert.equal(h.$('workspace').hidden, true); assert.equal(h.$('password').value, '');
    assert.equal(h.w.sessionStorage.getItem('receipt-admin-session'), 'new-fixture-admin-token');
    assert.equal(h.requests.filter(req => Object.hasOwn(req, 'password')).length, 1);
    unavailable = false; h.click('login-retry'); await h.ready();
    assert.doesNotMatch(h.w.document.body.textContent, /secret-fixture-password|new-fixture-admin-token/);
  } finally { h.close(); }
});

test('incomplete monthly response disables data and export instead of accepting a partial page', async () => {
  const h = await harness({ records: month => [makeRow(month)], handler: (body, h) => body.action === 'load' ? response(200, { records: h.records, total_count: 51 }) : h.defaultResponse(body) });
  try { await waitFor(() => !h.$('login-retry').hidden); assert.equal(h.$('workspace').hidden, true); assert.equal(h.$('export').disabled, true); assert.match(h.$('login-message').textContent, /未完整/); }
  finally { h.close(); }
});

test('all filtered results, numerical sort and full totals are independent of 50-row pagination and Excel exports', async () => {
  const h = await harness({ records: month => Array.from({ length: 82 }, (_, i) => makeRow(month, { unit_name: i < 70 ? `匯出對象${i}` : '排除對象', amount: 100 - i, distance_km: i / 10, vehicle_type: i < 65 ? 'personal' : 'store' })) });
  try {
    await h.ready(); assert.equal(h.$('rows').children.length, 50); h.set('search', '匯出對象'); h.set('vehicle-filter', 'personal', 'change'); h.set('sort-by', 'amount', 'change'); h.set('sort-direction', 'asc', 'change');
    assert.equal(h.$('total-count').textContent, '65'); assert.equal(h.$('rows').children.length, 50); h.click('next-page'); assert.equal(h.$('rows').children.length, 15);
    h.click('export'); await waitFor(() => h.downloads.length === 1);
    const exported = h.exports[0]; assert.equal(exported.records.length, 65); assert.equal(exported.records[0].amount, 36); assert.equal(exported.records.at(-1).amount, 100); assert.equal(typeof exported.records[0].distance_km, 'number');
    assert.equal(exported.meta.search, '匯出對象'); assert.equal(exported.meta.vehicleLabel, '自用車'); assert.match(exported.meta.sortLabel, /金額.*升冪/); assert.doesNotMatch(JSON.stringify(exported), /fixture-admin-token|password|Authorization/);
    assert.match(h.downloads[0].filename, /\.xlsx$/); assert.equal(h.$('total-amount').textContent, '4,420');
  } finally { h.close(); }
});

test('store and month filters reload full scope and safely show XSS text as literal text', async () => {
  const h = await harness({ records: month => [makeRow(month, { store_id: 2, unit_name: '<img src=x onerror=alert(1)>', address: '<script>bad()</script>' }), makeRow(month)] });
  try {
    await h.ready(); assert.equal(h.$('rows').querySelector('img,script'), null); assert.match(h.$('rows').textContent, /<img src=x/);
    h.set('store-filter', '2', 'change'); await h.ready(); assert.equal(h.requests.at(-1).store_id, 2); assert.equal(h.$('rows').children.length, 1);
    h.set('month', '2025-01', 'change'); await h.ready(); assert.equal(h.requests.at(-1).month, '2025-01'); assert.equal(h.$('rows').children.length, 0); assert.equal(h.$('export').disabled, true);
  } finally { h.close(); }
});

test('new record defaults to Pingtung and Taiwan time, requires a vehicle, and saves raw numeric values', async () => {
  const h = await harness();
  try {
    await h.ready(); h.click('new-record'); assert.equal(h.$('edit-address').value, '屏東縣'); assert.equal(h.$('edit-date').value.slice(0, 7), h.month); assert.equal(h.$('edit-personal').checked, false); assert.equal(h.$('legacy-vehicle-option').hidden, true);
    h.fill(); h.$('edit-personal').checked = false; h.submit(); assert.equal(h.$('edit-vehicle-error').hidden, false); assert.equal(h.requests.filter(req => req.action === 'save').length, 0);
    h.click('edit-store-vehicle'); h.submit(); await waitFor(() => !h.$('editor-dialog').open); await h.ready();
    const saved = h.requests.find(req => req.action === 'save'); assert.equal(saved.store_id, 1); assert.equal(saved.vehicle_type, 'store'); assert.equal(saved.expected_version, 0); assert.equal(saved.amount, 700.5); assert.equal(saved.distance_km, 3.25); assert.equal(saved.unit_name, '新外送單位'); assert.equal(saved.delivered_at, new Date(`${h.month}-01T00:05:00+08:00`).toISOString()); assert.equal(saved.multipart, true); assert.equal(saved.hasPhoto, false);
    assert.equal(h.requests.at(-1).action, 'load'); assert.equal(h.$('rows').children.length, 1);
  } finally { h.close(); }
});

test('editing freezes store, preserves existing receipt and allows legacy NULL vehicle to remain unrecorded', async () => {
  const h = await harness({ records: month => [makeRow(month, { store_id: 2, has_photo: true, vehicle_type: null, version: 4 })] });
  try {
    await h.ready(); h.action('edit'); assert.equal(h.$('edit-store').disabled, true); assert.equal(h.$('edit-store').value, '2'); assert.equal(h.$('editor-photo-section').hidden, true); assert.equal(h.$('legacy-vehicle-option').hidden, false); assert.equal(h.$('edit-unknown').checked, true);
    h.set('edit-unit', '更正單位'); h.set('edit-courier', '新同仁'); h.set('edit-amount', '900'); h.set('edit-distance', '4.5'); h.submit();
    await waitFor(() => !h.$('editor-dialog').open); await h.ready(); const saved = h.requests.find(req => req.action === 'save');
    assert.equal(saved.expected_version, 4); assert.equal(saved.vehicle_type, null); assert.equal(saved.store_id, 2); assert.equal(saved.hasPhoto, false); assert.equal(h.records[0].has_photo, true); assert.equal(h.records[0].courier, '新同仁');
    h.action('edit'); h.click('edit-personal'); h.submit(); await waitFor(() => !h.$('editor-dialog').open); await h.ready(); h.action('edit'); assert.equal(h.$('legacy-vehicle-option').hidden, true);
  } finally { h.close(); }
});

test('unknown save freezes payload and JPEG bytes, retries stable IDs and reloads authoritative data', async () => {
  let first = true;
  const h = await harness({ handler: (body, h, photo) => {
    if (body.action === 'save' && first) { first = false; h.defaultResponse(body, photo); h.records[0].unit_name = '稍後更正的名稱'; throw new TypeError('network lost after commit'); }
    return h.defaultResponse(body, photo);
  } });
  try {
    await h.ready(); h.click('new-record'); h.fill(); h.photo(); await h.photoReady(); h.submit(); await waitFor(() => h.$('save-record').textContent.includes('重試'));
    assert.equal(h.$('edit-unit').disabled, true); assert.equal(h.$('editor-camera').disabled, true); assert.match(h.$('editor-message').textContent, /尚無法確認/);
    h.submit(); await waitFor(() => !h.$('editor-dialog').open); await h.ready(); const saves = h.requests.filter(req => req.action === 'save'); assert.equal(saves.length, 2); assert.deepEqual(saves[0], saves[1]);
    assert.equal(await h.photoBytes(h.uploads[0].photo), await h.photoBytes(h.uploads[1].photo)); assert.equal(h.uploads[0].photo.type, 'image/jpeg'); assert.equal(h.records.length, 1); assert.match(h.$('rows').textContent, /稍後更正的名稱/);
  } finally { h.close(); }
});

test('409 keeps draft and requires an explicit discard/reload before editing latest version', async () => {
  const h = await harness({ records: month => [makeRow(month)], handler: (body, h, photo) => {
    if (body.action === 'save') { h.records[0] = { ...h.records[0], unit_name: '別人更正', version: 2 }; return response(409, { error: '紀錄已由其他人更新', code: 'record_conflict' }); }
    return h.defaultResponse(body, photo);
  } });
  try {
    await h.ready(); h.action('edit'); h.set('edit-unit', '我的更正'); h.submit(); await waitFor(() => !h.$('editor-conflict').hidden);
    assert.equal(h.$('edit-unit').value, '我的更正'); assert.equal(h.$('save-record').disabled, true); assert.equal(h.$('workspace').hidden, false);
    h.click('reload-editor'); await waitFor(() => h.$('editor-dialog').open && h.$('edit-unit').value === '別人更正'); assert.equal(h.$('save-record').disabled, false); assert.ok(h.confirmations.length >= 2);
  } finally { h.close(); }
});

test('delete confirmation identifies store/unit/date/amount and uncertain retry uses one request', async () => {
  let first = true;
  const h = await harness({ records: month => [makeRow(month, { store_id: 2, amount: 1234.5 })], handler: (body, h, photo) => {
    if (body.action === 'delete' && first) { first = false; h.defaultResponse(body); throw new TypeError('unknown result'); }
    return h.defaultResponse(body, photo);
  } });
  try {
    await h.ready(); h.action('delete'); for (const expected of ['木崎(C2)', '潮州國小', h.month, '1,234.5']) assert.ok(h.$('delete-summary').textContent.includes(expected));
    h.click('confirm-delete'); await waitFor(() => h.$('confirm-delete').textContent.includes('重試')); h.click('confirm-delete'); await waitFor(() => !h.$('delete-dialog').open); await h.ready();
    const requests = h.requests.filter(req => req.action === 'delete'); assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]); assert.equal(h.$('rows').children.length, 0); assert.equal(h.$('total-count').textContent, '0'); assert.equal(h.$('export').disabled, true); assert.equal(h.requests.at(-1).action, 'load');
  } finally { h.close(); }
});

test('separate first-photo attachment uses readonly record summary and stable photo retries', async () => {
  let first = true;
  const h = await harness({ records: month => [makeRow(month, { vehicle_type: 'store', version: 3 })], handler: (body, h, photo) => {
    if (body.action === 'attach_photo' && first) { first = false; h.defaultResponse(body, photo); throw new Error('lost after upload'); }
    return h.defaultResponse(body, photo);
  } });
  try {
    await h.ready(); h.action('attach'); assert.match(h.$('attachment-summary').textContent, /店用車/); assert.equal(h.$('attachment-summary').querySelector('input,textarea,select'), null);
    h.photo('attachment'); await h.photoReady('attachment'); h.submit('attachment-form'); await waitFor(() => h.$('confirm-attachment').textContent.includes('重試'));
    assert.equal(h.$('attachment-clear-photo').disabled, true); h.submit('attachment-form'); await waitFor(() => !h.$('attachment-dialog').open); await h.ready();
    const requests = h.requests.filter(req => req.action === 'attach_photo'); assert.deepEqual(requests[0], requests[1]); assert.equal(requests[0].expected_version, 3); assert.equal(Object.hasOwn(requests[0], 'address'), false); assert.equal(await h.photoBytes(h.uploads[0].photo), await h.photoBytes(h.uploads[1].photo)); assert.ok(h.w.document.querySelector('[data-action=photo]'));
  } finally { h.close(); }
});

test('photo_locked retains login and prepared photo, while genuine 401 clears draft, image and rows', async () => {
  let status = 403;
  const h = await harness({ records: month => [makeRow(month)], handler: (body, h, photo) => body.action === 'attach_photo' ? response(status, { error: status === 403 ? '已有照片' : '登入已失效', code: status === 403 ? 'photo_locked' : 'admin_session_expired' }) : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.action('attach'); h.photo('attachment'); await h.photoReady('attachment'); h.submit('attachment-form'); await waitFor(() => h.$('attachment-message').textContent.includes('草稿'));
    assert.equal(h.$('workspace').hidden, false); assert.equal(h.w.sessionStorage.getItem('receipt-admin-session'), h.token); assert.equal(h.$('attachment-photo-preview-wrap').hidden, false); assert.equal(h.$('confirm-attachment').disabled, true);
    h.click('cancel-attachment'); h.action('attach'); h.photo('attachment'); await h.photoReady('attachment'); status = 401; h.submit('attachment-form'); await waitFor(() => h.$('workspace').hidden);
    assert.equal(h.$('attachment-dialog').open, false); assert.equal(h.$('rows').children.length, 0); assert.equal(h.$('attachment-photo-preview').hasAttribute('src'), false); assert.equal(h.w.sessionStorage.getItem('receipt-admin-session'), null);
  } finally { h.close(); }
});

test('private receipt viewer validates signed URL origin and cleans image on close', async () => {
  let safe = false;
  const h = await harness({ records: month => [makeRow(month, { has_photo: true })], handler: (body, h, photo) => body.action === 'photo' && !safe ? response(200, { url: 'https://evil.example/receipt.jpg' }) : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.action('photo'); await waitFor(() => !h.$('retry-photo').hidden); assert.equal(h.$('photo-image').hasAttribute('src'), false);
    safe = true; h.click('retry-photo'); await waitFor(() => h.$('photo-image').hasAttribute('src')); h.$('photo-image').dispatchEvent(new h.w.Event('load')); assert.equal(h.$('photo-image').hidden, false);
    h.click('close-photo'); assert.equal(h.$('photo-image').hasAttribute('src'), false); assert.equal(h.$('photo-dialog').open, false);
  } finally { h.close(); }
});

test('new address calculates scooter distance for selected store; manual input cancels a late auto result', async () => {
  const pending = deferred(); let hold = false;
  const h = await harness({ distanceAvailable: true, handler: async (body, h, photo) => { if (body.action === 'distance' && hold) await pending.promise; return h.defaultResponse(body, photo); } });
  try {
    await h.ready(); h.click('new-record'); h.set('edit-store', '2', 'change'); h.set('edit-address', '屏東縣潮州鎮文化路88號'); h.$('edit-address').dispatchEvent(new h.w.Event('blur'));
    await waitFor(() => h.$('edit-distance').value === '3.27'); assert.equal(h.requests.find(req => req.action === 'distance').store_id, 2); assert.match(h.$('distance-origin').textContent, /東華路25號/);
    hold = true; h.set('edit-address', '屏東縣潮州鎮中山路55號'); assert.equal(h.$('edit-distance').value, ''); h.$('edit-address').dispatchEvent(new h.w.Event('blur'));
    await waitFor(() => h.requests.filter(req => req.action === 'distance').length === 2); h.set('edit-distance', '9.8'); pending.resolve(); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(h.$('edit-distance').value, '9.8'); assert.match(h.$('distance-feedback').textContent, /手動公里數/); assert.equal(h.$('save-record').disabled, false);
  } finally { h.close(); }
});

test('photo decode failures block save until canceled, and stale decode cannot populate a later dialog', async () => {
  const h = await harness();
  try {
    await h.ready(); h.click('new-record'); h.fill(); h.decode = () => Promise.reject(new Error('照片格式無法讀取')); h.photo(); await waitFor(() => h.$('editor-photo-feedback').textContent.includes('無法讀取'));
    assert.equal(h.$('save-record').disabled, true); assert.equal(h.$('editor-photo-preview-wrap').hidden, false); h.click('editor-clear-photo'); assert.equal(h.$('save-record').disabled, false);
    const pending = deferred(); h.decode = () => pending.promise; h.photo(); h.click('cancel-editor'); h.click('new-record'); pending.resolve(); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(h.$('editor-photo-preview-wrap').hidden, true); assert.equal(h.$('edit-unit').value, ''); assert.equal(h.$('save-record').disabled, false);
  } finally { h.close(); }
});

test('late mutation from a discarded dialog never clears a new draft or reloads its scope', async () => {
  const pending = deferred();
  const h = await harness({ handler: async (body, h, photo) => { if (body.action === 'save') await pending.promise; return h.defaultResponse(body, photo); } });
  try {
    await h.ready(); h.click('new-record'); h.fill(); h.submit(); await waitFor(() => h.requests.some(req => req.action === 'save'));
    h.click('cancel-editor'); h.click('new-record'); h.set('edit-unit', '新的草稿'); pending.resolve(); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(h.$('editor-dialog').open, true); assert.equal(h.$('edit-unit').value, '新的草稿'); assert.equal(h.requests.filter(req => req.action === 'load').length, 1);
  } finally { h.close(); }
});

test('session change drops stale responses, clears all sensitive state and protects unsaved work', async () => {
  const pending = deferred(); let delay = false;
  const h = await harness({ records: month => [makeRow(month, { has_photo: true })], handler: async (body, h, photo) => { if (body.action === 'load' && delay) await pending.promise; return h.defaultResponse(body, photo); } });
  try {
    await h.ready(); h.action('edit'); h.set('edit-unit', '尚未存檔'); const before = new h.w.Event('beforeunload', { cancelable: true }); h.w.dispatchEvent(before); assert.equal(before.defaultPrevented, true);
    h.w.confirm = () => false; h.click('logout'); assert.equal(h.$('workspace').hidden, false); h.w.confirm = () => true; h.click('cancel-editor'); delay = true; h.click('refresh');
    h.w.sessionStorage.setItem('receipt-admin-session', 'different-admin-token'); h.w.dispatchEvent(new h.w.Event('focus')); pending.resolve(); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(h.$('workspace').hidden, true); assert.equal(h.$('rows').children.length, 0); assert.equal(h.$('edit-unit').value, ''); assert.equal(h.w.sessionStorage.getItem('receipt-admin-session'), 'different-admin-token');
  } finally { h.close(); }
});
