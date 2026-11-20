// Behavior tests for the real HTML and JS. Layout and camera hardware require browser/device QA.
// jsdom is deliberately a test dependency outside the shipped application.
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
const html = fs.readFileSync(path.join(root, 'delivery.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'delivery.js'), 'utf8').replace(
  /^import\s*\{([^}]+)\}\s*from\s*['"]\.\/delivery-core\.mjs[^'"]*['"];?\s*/,
  'const {$1} = window.__deliveryCore;\n'
);
const corePromise = import(pathToFileURL(path.join(root, 'delivery-core.mjs')).href);
const origins = { 1: '屏東縣潮州鎮文化路42號', 2: '屏東縣潮州鎮東華路25號' };
const clone = value => JSON.parse(JSON.stringify(value));
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(body) });
async function waitFor(predicate, message = 'UI did not settle') {
  const limit = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > limit) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

async function harness(options = {}) {
  const core = await corePromise;
  const month = core.taipeiDateTime().slice(0, 7);
  const session = Object.hasOwn(options, 'session') ? options.session : { store_id: 1, store_name: '潮州店(C1)', token: 'test-token' };
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'https://s3235889-pixel.github.io/inventory/delivery.html', runScripts: 'outside-only', virtualConsole });
  const w = dom.window;
  if (options.distanceTimeoutMs) {
    const setWindowTimeout = w.setTimeout.bind(w);
    w.setTimeout = (callback, delay, ...args) => setWindowTimeout(callback, delay === 20000 ? options.distanceTimeoutMs : delay, ...args);
  }
  w.__deliveryCore = core;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  const confirmations = [];
  w.confirm = message => { confirmations.push(String(message)); return true; };
  Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
  let objectCounter = 0;
  w.URL.createObjectURL = () => `blob:test-${++objectCounter}`;
  w.URL.revokeObjectURL = () => {};
  if (session) w.sessionStorage.setItem('receipt-session', JSON.stringify(session));
  const h = {
    dom, w, core, month, session, errors, confirmations, requests: [], records: options.records || [],
    handler: options.handler || null, decode: () => Promise.resolve(),
    distanceService: options.distanceService || { available: options.distanceAvailable === true, origin_address: origins[session?.store_id], mode: 'scooter', provider: 'geoapify' },
    $: id => w.document.getElementById(id),
    set(id, value) { const el = this.$(id); el.value = String(value); el.dispatchEvent(new w.Event('input', { bubbles: true })); },
    click(id) { this.$(id).click(); },
    blur(id) { this.$(id).dispatchEvent(new w.Event('blur')); },
    submit() { this.$('delivery-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); },
    fill() {
      this.set('unit-name', ' 潮州國小 '); this.set('address', '屏東縣潮州鎮中山路1號'); this.set('courier', '小陳');
      this.set('delivered-at', `${month}-01T00:05`); this.set('amount', '600.50'); this.set('distance-km', '2.35');
    },
    photo(name = 'receipt.jpg', type = 'image/jpeg') {
      const file = new w.File(['photo bytes'], name, { type });
      Object.defineProperty(this.$('gallery-input'), 'files', { value: [file], configurable: true });
      this.$('gallery-input').dispatchEvent(new w.Event('change', { bubbles: true }));
    },
    async ready() { await waitFor(() => !this.$('workspace').hidden && !this.$('history-month').disabled, 'Workspace did not load'); },
    async idle() { await waitFor(() => !this.$('history-month').disabled, 'UI stayed busy'); },
    close() { dom.window.close(); },
    defaultResponse(body, photo) {
      if (body.action === 'load') {
        const records = this.records.filter(row => this.core.taipeiDateTime(row.delivered_at).slice(0, 7) === body.month);
        return response(200, { store_id: session.store_id, store_name: session.store_name, month: body.month, page: body.page, page_size: 50,
          records: records.slice(body.page * 50, body.page * 50 + 50), total_count: records.length,
          total_amount: records.reduce((sum, row) => sum + row.amount, 0), total_distance_km: records.reduce((sum, row) => sum + row.distance_km, 0),
          has_more: records.length > (body.page + 1) * 50, distance_service: this.distanceService });
      }
      if (body.action === 'distance') return response(200, { distance_km: 3.27, address: body.address, matched_address: body.address,
        origin_address: this.distanceService.origin_address, mode: 'scooter', provider: 'geoapify', estimated: true });
      if (body.action === 'save') {
        const old = this.records.find(row => row.id === body.id);
        if (old?.request_id === body.request_id) return response(200, { record: old });
        if (old || body.expected_version !== 0 || body.remove_photo) return response(403, { error: '外送紀錄上傳後僅供查詢，不可編輯或刪除', code: 'record_locked' });
        const record = { ...body, version: 1, updated_at: new Date().toISOString(), has_photo: !!photo };
        this.records = [record, ...this.records];
        return response(200, { record });
      }
      if (body.action === 'photo') return response(200, { url: 'https://rjetwgrelmvciatouwiw.supabase.co/storage/v1/object/sign/delivery-photos/1/photo.jpg?token=fixture' });
      return response(400, { error: 'Unsupported' });
    },
  };
  w.Image = class { constructor() { this.width = 3200; this.height = 2400; } decode() { return h.decode(this.src); } };
  w.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {}, fillStyle: '' });
  w.HTMLCanvasElement.prototype.toBlob = function (callback) { callback(new w.Blob(['compressed image'], { type: 'image/jpeg' })); };
  w.fetch = async (url, init) => {
    assert.equal(url, 'https://rjetwgrelmvciatouwiw.supabase.co/functions/v1/delivery-api');
    assert.equal(init.headers.Authorization, `Bearer ${session?.token}`);
    const multipart = init.body instanceof w.FormData;
    const body = multipart ? JSON.parse(init.body.get('payload')) : JSON.parse(init.body);
    const photo = multipart ? init.body.get('photo') : null;
    h.requests.push({ ...clone(body), hasUpload: !!photo, uploadType: photo?.type });
    return h.handler ? h.handler(body, h, photo, init.signal) : h.defaultResponse(body, photo);
  };
  new vm.Script(source, { filename: 'delivery.js' }).runInContext(dom.getInternalVMContext());
  return h;
}

function makeRow(month, overrides = {}) {
  return { id: randomUUID(), unit_name: '潮州國小', address: '潮州鎮中山路1號', courier: '小陳', delivered_at: `${month}-05T06:30:00Z`, amount: 600, distance_km: 2.5, has_photo: false, version: 1, updated_at: `${month}-05T06:30:00Z`, ...overrides };
}

test('logged-out and other-store sessions never show records or call the API', async () => {
  for (const session of [null, { store_id: 3, token: 'other' }, { store_id: 0, token: 'admin' }]) {
    const h = await harness({ session });
    try { assert.equal(h.$('workspace').hidden, true); assert.equal(h.$('access-login').hidden, false); assert.equal(h.requests.length, 0); }
    finally { h.close(); }
  }
});

test('both allowed stores require backend confirmation before showing the workspace', async () => {
  for (const store_id of [1, 2]) {
    const pending = deferred();
    const h = await harness({ session: { store_id, store_name: store_id === 1 ? '潮州店(C1)' : '木崎(C2)', token: 'test-token' }, handler: (body, h) => pending.promise.then(() => h.defaultResponse(body)) });
    try {
      assert.equal(h.$('workspace').hidden, true);
      pending.resolve(); await h.ready();
      assert.equal(h.$('store-name').textContent, h.session.store_name);
      assert.equal(h.$('total-count').textContent, '0');
    } finally { h.close(); }
  }
});

test('required input is validated without treating blanks as zero', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill(); h.set('amount', ''); h.submit();
    assert.equal(h.requests.filter(r => r.action === 'save').length, 0);
    assert.equal(h.$('amount').getAttribute('aria-invalid'), 'true');
    assert.equal(h.$('unit-name').value, ' 潮州國小 ');
  } finally { h.close(); }
});

test('saving confirms the permanent lock and creates a new record with explicit Taiwan time', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill(); h.submit(); await h.idle();
    const sent = h.requests.find(r => r.action === 'save');
    assert.equal(sent.unit_name, '潮州國小');
    assert.equal(sent.delivered_at, h.core.localDateTimeToISO(`${h.month}-01T00:05`));
    assert.equal(sent.expected_version, 0);
    assert.equal(sent.remove_photo, false);
    assert.equal(sent.amount, 600.5); assert.equal(sent.distance_km, 2.35);
    assert.equal(Object.hasOwn(sent, 'store_id'), false);
    assert.equal(h.$('unit-name').value, '');
    assert.equal(h.$('courier').value, '小陳');
    assert.equal(h.$('total-count').textContent, '1');
    assert.match(h.$('message').textContent, /已上傳並鎖定/);
    assert.match(h.confirmations[0], /上傳成功後僅供查詢，所有欄位與單據照片都不能編輯或刪除/);
    assert.match(h.confirmations[0], /本次未附單據；送出後不能補傳照片/);
    assert.equal(h.$('history-body').querySelector('[data-action="edit"]'), null);
    assert.equal(h.$('history-body').querySelector('[data-action="delete"]'), null);
    assert.match(h.$('message').textContent, /僅供查詢，不能編輯或刪除/);
    assert.match(h.$('history-description').textContent, /已上傳的資料與單據僅供查詢，不能編輯或刪除/);
  } finally { h.close(); }
});

test('canceling the upload confirmation preserves the draft and prepared photo', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill(); h.photo(); await waitFor(() => !h.$('save').disabled);
    const preview = h.$('photo-preview').src;
    let confirmation = '';
    h.w.confirm = message => { confirmation = message; return false; };
    h.submit();
    assert.match(confirmation, /單據照片將一併上傳，之後不能更換或移除/);
    assert.equal(h.requests.filter(r => r.action === 'save').length, 0);
    assert.equal(h.$('amount').value, '600.50'); assert.equal(h.$('photo-preview').src, preview);
    assert.equal(h.$('photo-preview-wrap').hidden, false); assert.equal(h.$('save').disabled, false);
    h.set('amount', '650'); h.w.confirm = () => true; h.submit(); await h.idle();
    assert.equal(h.requests.find(r => r.action === 'save').amount, 650);
    assert.equal(h.requests.find(r => r.action === 'save').hasUpload, true);
  } finally { h.close(); }
});

test('failed save preserves inputs and retries the same record and request IDs', async () => {
  let attempts = 0;
  const h = await harness({ handler: (body, h, photo) => body.action === 'save' && ++attempts === 1 ? Promise.reject(new Error('offline')) : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.fill(); h.submit(); await h.idle();
    assert.equal(h.$('amount').value, '600.50');
    assert.match(h.$('message').textContent, /尚無法確認/);
    h.submit(); await h.idle();
    const saves = h.requests.filter(r => r.action === 'save');
    assert.equal(saves.length, 2);
    assert.equal(saves[0].id, saves[1].id); assert.equal(saves[0].request_id, saves[1].request_id);
  } finally { h.close(); }
});

test('changing an uncertain new draft keeps the record ID and changes only the operation ID', async () => {
  const h = await harness({ handler: (body, h, photo) => body.action === 'save' ? response(500, { error: '暫時無法儲存' }) : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.fill(); h.submit(); await h.idle(); h.set('amount', '700'); h.submit(); await h.idle();
    const saves = h.requests.filter(r => r.action === 'save');
    assert.equal(saves[0].id, saves[1].id); assert.notEqual(saves[0].request_id, saves[1].request_id);
    assert.equal(saves[1].amount, 700);
  } finally { h.close(); }
});

test('a creation conflict keeps the draft and cannot be blindly resubmitted', async () => {
  const h = await harness({ handler: (body, h, photo) => body.action === 'save' ? response(409, { error: '這筆紀錄已上傳，無法重複新增' }) : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.fill(); h.set('amount', '800'); h.submit(); await h.idle();
    assert.equal(h.$('amount').value, '800'); assert.equal(h.$('conflict').hidden, false); assert.equal(h.$('save').disabled, true);
    h.submit(); assert.equal(h.requests.filter(r => r.action === 'save').length, 1);
    h.w.confirm = () => false; h.click('reload-conflict'); assert.equal(h.$('amount').value, '800');
    h.w.confirm = () => true; h.click('reload-conflict'); await h.idle(); assert.equal(h.$('conflict').hidden, true);
  } finally { h.close(); }
});

test('record_locked 403 keeps the session, draft and photo while preventing overwrite', async () => {
  const h = await harness({ handler: (body, h, photo) => body.action === 'save'
    ? response(403, { error: '外送紀錄上傳後僅供查詢，不可編輯或刪除', code: 'record_locked' }) : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.fill(); h.photo(); await waitFor(() => !h.$('save').disabled);
    const preview = h.$('photo-preview').src;
    h.submit(); await h.idle();
    assert.equal(h.$('workspace').hidden, false); assert.equal(h.$('access-gate').hidden, true);
    assert.equal(h.$('unit-name').value, ' 潮州國小 '); assert.equal(h.$('amount').value, '600.50');
    assert.equal(h.$('photo-preview').src, preview); assert.equal(h.$('photo-preview-wrap').hidden, false);
    assert.equal(JSON.parse(h.w.sessionStorage.getItem('receipt-session')).token, h.session.token);
    assert.match(h.$('message').textContent, /上傳後僅供查詢，不可編輯或刪除/);
    assert.equal(h.$('conflict').hidden, false); assert.equal(h.$('save').disabled, true);
    h.submit(); assert.equal(h.requests.filter(r => r.action === 'save').length, 1);
  } finally { h.close(); }
});

test('an authorization 403 still clears branch data and requires login', async () => {
  const h = await harness({ handler: (body, h, photo) => body.action === 'save'
    ? response(403, { error: '門市驗證失敗' }) : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.fill(); h.submit(); await h.idle();
    assert.equal(h.$('workspace').hidden, true); assert.equal(h.$('access-login').hidden, false);
    assert.equal(h.$('unit-name').value, ''); assert.equal(h.w.sessionStorage.getItem('receipt-session'), null);
    assert.match(h.$('access-message').textContent, /門市驗證失敗/);
  } finally { h.close(); }
});

test('photo preparation blocks save, preserves prepared photo after failure and sends it on retry', async () => {
  let saveCalls = 0;
  const h = await harness({ handler: (body, h, photo) => body.action === 'save' && ++saveCalls === 1 ? response(500, { error: '上傳連線中斷' }) : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.fill(); const pending = deferred(); h.decode = () => pending.promise; h.photo();
    assert.equal(h.$('save').disabled, true); h.submit(); assert.equal(h.requests.filter(r => r.action === 'save').length, 0);
    pending.resolve(); await waitFor(() => !h.$('save').disabled);
    assert.equal(h.$('photo-preview-wrap').hidden, false);
    h.submit(); await h.idle(); assert.equal(h.$('photo-preview-wrap').hidden, false); h.submit(); await h.idle();
    const saves = h.requests.filter(r => r.action === 'save');
    assert.equal(saves.length, 2); assert.equal(saves[0].hasUpload, true); assert.equal(saves[1].hasUpload, true);
    assert.equal(saves[0].uploadType, 'image/jpeg'); assert.equal(saves[0].request_id, saves[1].request_id);
    assert.match(h.$('message').textContent, /照片已一併上傳/);
  } finally { h.close(); }
});

test('unreadable photos never silently disappear from a submitted record', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill(); h.decode = () => Promise.reject(new Error('無法解碼')); h.photo('photo.heic', 'image/heic');
    await waitFor(() => h.$('photo-feedback').classList.contains('error'));
    assert.equal(h.$('save').disabled, true); assert.match(h.$('photo-feedback').textContent, /HEIC/);
    h.submit(); assert.equal(h.requests.filter(r => r.action === 'save').length, 0);
    h.click('clear-photo'); assert.equal(h.$('save').disabled, false);
    h.submit(); await h.idle(); assert.equal(h.requests.find(r => r.action === 'save').hasUpload, false);
  } finally { h.close(); }
});

test('photos can be canceled and reselected before the first upload', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill(); h.photo(); await waitFor(() => !h.$('save').disabled);
    const firstPreview = h.$('photo-preview').src;
    h.click('clear-photo'); assert.equal(h.$('photo-preview-wrap').hidden, true);
    h.photo('correct-receipt.jpg');
    await waitFor(() => !h.$('save').disabled); assert.notEqual(h.$('photo-preview').src, firstPreview);
    h.submit(); await h.idle();
    const sent = h.requests.find(r => r.action === 'save');
    assert.equal(sent.hasUpload, true); assert.equal(sent.remove_photo, false); assert.equal(sent.expected_version, 0);
  } finally { h.close(); }
});

test('saved records expose only receipt viewing and never refill the new-record form', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill(); h.photo();
    await waitFor(() => !h.$('save').disabled); h.submit(); await h.idle();
    const saved = clone(h.records[0]);
    assert.deepEqual(Array.from(h.$('history-body').querySelectorAll('button'), button => button.dataset.action), ['photo']);
    assert.equal(h.$('new-record'), null); assert.equal(h.$('view-existing-photo'), null); assert.equal(h.$('remove-existing-photo'), null);
    assert.equal(h.$('unit-name').value, ''); assert.equal(h.$('photo-preview-wrap').hidden, true);
    h.w.document.querySelector('[data-action="photo"]').click();
    await waitFor(() => h.$('viewer-image').hasAttribute('src'));
    assert.equal(h.$('unit-name').value, ''); assert.equal(h.$('form-mode').textContent, '新增外送');
    assert.equal(h.$('photo-preview-wrap').hidden, true);
    h.click('close-photo'); h.fill(); h.set('unit-name', '第二筆新外送'); h.submit(); await h.idle();
    const saves = h.requests.filter(r => r.action === 'save');
    assert.equal(saves.length, 2); assert.notEqual(saves[0].id, saves[1].id);
    assert.equal(saves[1].expected_version, 0); assert.equal(saves[1].remove_photo, false); assert.equal(saves[1].hasUpload, false);
    assert.deepEqual(h.records.find(row => row.id === saved.id), saved);
  } finally { h.close(); }
});

test('a canceled photo decode cannot overwrite the form after resetting it', async () => {
  const h = await harness();
  try {
    await h.ready(); const pending = deferred(); h.decode = () => pending.promise; h.photo(); h.click('clear-photo'); pending.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.$('photo-preview-wrap').hidden, true); assert.equal(h.$('photo-feedback').hidden, true);
  } finally { h.close(); }
});

test('a session change clears other-branch data and blocks any save', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill(); h.w.sessionStorage.setItem('receipt-session', JSON.stringify({ store_id: 2, token: 'new-store-token' }));
    h.w.dispatchEvent(new h.w.Event('focus'));
    assert.equal(h.$('workspace').hidden, true); assert.equal(h.$('unit-name').value, ''); assert.equal(h.$('history-body').children.length, 0);
    assert.match(h.$('access-message').textContent, /登入已變更/);
    assert.equal(JSON.parse(h.w.sessionStorage.getItem('receipt-session')).token, 'new-store-token');
    h.submit(); assert.equal(h.requests.filter(r => r.action === 'save').length, 0);
  } finally { h.close(); }
});

test('monthly totals cover all pages and user text remains inert', async () => {
  const h = await harness();
  try {
    await h.ready(); h.records = Array.from({ length: 51 }, (_, i) => makeRow(h.month, { unit_name: i ? `單位${i}` : '<img src=x onerror=alert(1)>', amount: 100, distance_km: 1 }));
    h.click('refresh'); await h.idle();
    assert.equal(h.$('total-count').textContent, '51'); assert.equal(h.$('total-amount').textContent, '5,100');
    assert.equal(h.$('history-body').children.length, 50); assert.equal(h.$('history-body').querySelector('img'), null);
    assert.match(h.$('history-body').textContent, /<img src=x/);
    h.click('next-page'); await h.idle(); assert.equal(h.$('history-body').children.length, 1); assert.equal(h.$('total-count').textContent, '51');
  } finally { h.close(); }
});

test('records without receipts remain query-only with no deletion or photo upload actions', async () => {
  const h = await harness();
  try {
    await h.ready(); assert.match(h.$('list-state').textContent, /上傳後僅供查詢/);
    h.records = [makeRow(h.month), makeRow(h.month, { unit_name: '第二筆' })];
    const saved = clone(h.records);
    h.click('refresh'); await h.idle();
    assert.equal(h.$('history-body').children.length, 2);
    assert.equal(h.$('history-body').querySelector('button'), null);
    assert.equal(h.$('history-body').querySelectorAll('.no-photo').length, 2);
    assert.equal(h.w.document.querySelector('thead th:last-child').textContent, '單據');
    assert.match(h.$('upload-lock-note').textContent, /上傳成功後僅供查詢/);
    assert.match(h.$('upload-lock-note').textContent, /不能編輯或刪除/);
    h.click('refresh'); await h.idle();
    assert.deepEqual(h.records, saved); assert.equal(h.$('total-count').textContent, '2');
    assert.equal(h.requests.every(request => request.action === 'load'), true);
  } finally { h.close(); }
});

test('a read failure is distinguished from an empty month and keeps the draft', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill(); h.handler = () => response(500, { error: '暫時無法讀取' }); h.click('refresh'); await h.idle();
    assert.equal(h.$('unit-name').value, ' 潮州國小 '); assert.match(h.$('list-state').textContent, /無法確認/); assert.equal(h.$('total-count').textContent, '—');
  } finally { h.close(); }
});

test('unavailable automatic distance shows the manual fallback and never requests a route', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill();
    assert.match(h.$('distance-origin').textContent, /屏東縣潮州鎮文化路42號/);
    assert.match(h.$('distance-feedback').textContent, /自動計算尚未啟用，可先手動填寫公里數/);
    assert.equal(h.$('recalculate-distance').disabled, true);
    h.set('address', '屏東縣潮州鎮中山路22號');
    assert.equal(h.$('distance-km').value, '', 'A new address clears the old manual distance');
    h.blur('address'); h.click('recalculate-distance'); h.click('manual-distance');
    assert.equal(h.requests.filter(r => r.action === 'distance').length, 0);
    h.set('distance-km', '2.80'); h.submit(); await h.idle();
    assert.equal(h.requests.find(r => r.action === 'save').distance_km, 2.8);
    assert.equal(h.$('distance-attribution').hidden, true);
  } finally { h.close(); }
});

test('both stores use their confirmed origin and blur calculates a scooter route immediately', async () => {
  for (const store_id of [1, 2]) {
    const h = await harness({ distanceAvailable: true, session: { store_id, store_name: store_id === 1 ? '潮州店(C1)' : '木崎(C2)', token: 'test-token' } });
    try {
      await h.ready(); h.set('address', ' 屏東縣潮州鎮中山路1號 '); h.blur('address');
      await waitFor(() => h.$('distance-km').value === '3.27');
      assert.equal(h.requests.filter(r => r.action === 'distance').length, 1);
      assert.equal(h.requests.find(r => r.action === 'distance').address, '屏東縣潮州鎮中山路1號');
      assert.equal(h.$('distance-origin').textContent, `出發門市：${origins[store_id]}`);
      assert.equal(h.$('distance-attribution').hidden, false);
      assert.match(h.$('distance-attribution').textContent, /Geoapify/); assert.match(h.$('distance-attribution').textContent, /OpenStreetMap/);
      assert.match(h.$('distance-estimate-note').textContent, /並非實際 GPS 里程/);
      assert.match(h.$('history-distance-source').textContent, /距離也可能是手動填寫/);
    } finally { h.close(); }
  }
});

test('address input debounces for about one second and later blur does not repeat a completed route', async () => {
  const h = await harness({ distanceAvailable: true });
  try {
    await h.ready(); const start = Date.now(); h.set('address', '屏東縣潮州鎮中山路1號');
    assert.equal(h.requests.filter(r => r.action === 'distance').length, 0); assert.equal(h.$('save').disabled, true);
    await waitFor(() => h.$('distance-km').value === '3.27');
    assert.ok(Date.now() - start >= 900);
    h.blur('address'); h.blur('address');
    assert.equal(h.requests.filter(r => r.action === 'distance').length, 1);
    assert.match(h.$('distance-feedback').textContent, /預估 3.27 公里/);
  } finally { h.close(); }
});

test('a stale route cannot fill a changed address or overwrite a manual distance', async () => {
  const pending = [];
  const h = await harness({ distanceAvailable: true, handler: (body, h, photo) => {
    if (body.action !== 'distance') return h.defaultResponse(body, photo);
    const deferredRoute = deferred(); pending.push({ body, route: deferredRoute }); return deferredRoute.promise;
  } });
  try {
    await h.ready(); h.set('address', '屏東縣潮州鎮中山路1號'); h.blur('address');
    h.set('address', '屏東縣潮州鎮中山路2號'); h.blur('address');
    assert.equal(pending.length, 2); assert.equal(h.$('distance-km').value, '');
    pending[0].route.resolve(h.defaultResponse(pending[0].body));
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(h.$('distance-km').value, ''); assert.equal(h.$('save').disabled, true);
    h.set('distance-km', '4.20'); pending[1].route.resolve(h.defaultResponse(pending[1].body));
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(h.$('distance-km').value, '4.20'); assert.equal(h.$('distance-attribution').hidden, true);
    assert.match(h.$('distance-feedback').textContent, /目前使用手動公里數/);
    h.set('address', '屏東縣潮州鎮中山路3號');
    assert.equal(h.$('distance-km').value, ''); assert.equal(h.$('save').disabled, true);
  } finally { h.close(); }
});

test('changing an address clears a successful automatic result before another calculation', async () => {
  const h = await harness({ distanceAvailable: true });
  try {
    await h.ready(); h.set('address', '屏東縣潮州鎮中山路1號'); h.blur('address');
    await waitFor(() => h.$('distance-km').value === '3.27');
    h.set('address', '屏東縣潮州鎮中山路2號');
    assert.equal(h.$('distance-km').value, ''); assert.equal(h.$('distance-attribution').hidden, true);
    assert.equal(h.$('save').disabled, true);
    h.click('manual-distance'); assert.equal(h.$('distance-km').getAttribute('aria-busy'), 'false');
    h.set('distance-km', '5.20'); h.blur('address');
    assert.equal(h.requests.filter(r => r.action === 'distance').length, 1); assert.equal(h.$('distance-km').value, '5.20');
  } finally { h.close(); }
});

test('route errors preserve the draft and login, leave distance blank, and allow manual entry', async () => {
  for (const [status, code] of [[422, 'distance_address_invalid'], [422, 'distance_no_route'], [429, 'distance_rate_limited'], [503, 'distance_unavailable'], [403, 'distance_unavailable']]) {
    const h = await harness({ distanceAvailable: true, handler: (body, h, photo) => body.action === 'distance'
      ? response(status, { code, error: '暫時無法取得機車路線' }) : h.defaultResponse(body, photo) });
    try {
      await h.ready(); h.fill(); h.set('address', '屏東縣潮州鎮查無路1號'); h.blur('address');
      await waitFor(() => h.$('distance-feedback').classList.contains('error'));
      assert.equal(h.$('distance-km').value, ''); assert.equal(h.$('unit-name').value, ' 潮州國小 ');
      assert.equal(h.$('workspace').hidden, false); assert.equal(JSON.parse(h.w.sessionStorage.getItem('receipt-session')).token, h.session.token);
      h.blur('address'); assert.equal(h.requests.filter(r => r.action === 'distance').length, 1);
      h.set('distance-km', '2.15'); h.submit(); await h.idle();
      assert.equal(h.requests.find(r => r.action === 'save').distance_km, 2.15);
    } finally { h.close(); }
  }
});

test('distance timeout unlocks manual entry without silently supplying zero', async () => {
  const h = await harness({ distanceAvailable: true, distanceTimeoutMs: 20, handler: (body, h, photo, signal) => body.action === 'distance'
    ? new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new h.w.DOMException('Aborted', 'AbortError')), { once: true }))
    : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.fill(); h.set('address', '屏東縣潮州鎮中山路9號'); h.blur('address');
    await waitFor(() => /距離計算逾時/.test(h.$('distance-feedback').textContent));
    assert.equal(h.$('distance-km').value, ''); assert.equal(h.$('save').disabled, false);
    assert.equal(h.$('manual-distance').disabled, false); assert.equal(h.$('unit-name').value, ' 潮州國小 ');
    h.submit(); assert.equal(h.requests.filter(r => r.action === 'save').length, 0);
    assert.equal(h.$('distance-km').getAttribute('aria-invalid'), 'true');
  } finally { h.close(); }
});

test('mismatched route addresses, origins and modes are never accepted as the current distance', async () => {
  for (const override of [{ address: '不同目的地' }, { origin_address: origins[2] }, { mode: 'drive' }]) {
    const h = await harness({ distanceAvailable: true, handler: async (body, h, photo) => {
      const result = h.defaultResponse(body, photo);
      return body.action === 'distance' ? response(200, { ...await result.json(), ...override }) : result;
    } });
    try {
      await h.ready(); h.set('address', '屏東縣潮州鎮中山路1號'); h.blur('address');
      await waitFor(() => h.$('distance-feedback').classList.contains('error'));
      assert.equal(h.$('distance-km').value, ''); assert.equal(h.$('distance-attribution').hidden, true);
      assert.match(h.$('distance-feedback').textContent, /距離回應不完整/);
    } finally { h.close(); }
  }
});

test('an unknown save result retains its distance and request IDs despite late routes or retry interactions', async () => {
  const route = deferred(); let routeBody; let saveCalls = 0;
  const h = await harness({ distanceAvailable: true, handler: (body, h, photo) => {
    if (body.action === 'distance') { routeBody = body; return route.promise; }
    if (body.action === 'save' && ++saveCalls === 1) return Promise.reject(new Error('offline'));
    return h.defaultResponse(body, photo);
  } });
  try {
    await h.ready(); h.fill(); h.set('address', '屏東縣潮州鎮中山路8號'); h.blur('address');
    h.submit(); assert.equal(h.requests.filter(r => r.action === 'save').length, 0);
    h.click('manual-distance'); h.set('distance-km', '4.20'); h.submit(); await h.idle();
    route.resolve(h.defaultResponse(routeBody)); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(h.$('distance-km').value, '4.20'); assert.match(h.$('message').textContent, /尚無法確認/);
    assert.equal(h.$('recalculate-distance').disabled, true); assert.equal(h.$('manual-distance').disabled, true);
    h.blur('address'); h.click('recalculate-distance'); h.click('refresh'); await h.idle();
    assert.equal(h.requests.filter(r => r.action === 'distance').length, 1);
    h.submit(); await h.idle();
    const saves = h.requests.filter(r => r.action === 'save');
    assert.equal(saves.length, 2); assert.equal(saves[0].id, saves[1].id); assert.equal(saves[0].request_id, saves[1].request_id);
    assert.equal(saves[0].distance_km, 4.2); assert.equal(saves[1].distance_km, 4.2);
  } finally { h.close(); }
});

test('a late distance response cannot fill the blank form after a successful upload', async () => {
  const route = deferred(); let routeBody;
  const h = await harness({ distanceAvailable: true, handler: (body, h, photo) => {
    if (body.action === 'distance') { routeBody = body; return route.promise; }
    return h.defaultResponse(body, photo);
  } });
  try {
    await h.ready(); h.fill(); h.set('address', '屏東縣潮州鎮中山路8號'); h.blur('address');
    h.click('manual-distance'); h.set('distance-km', '4.20'); h.submit(); await h.idle();
    route.resolve(h.defaultResponse(routeBody)); await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(h.$('unit-name').value, ''); assert.equal(h.$('address').value, ''); assert.equal(h.$('distance-km').value, '');
    assert.equal(h.$('distance-attribution').hidden, true); assert.equal(h.records[0].distance_km, 4.2);
    assert.equal(h.$('history-body').querySelector('[data-action="edit"], [data-action="delete"]'), null);
  } finally { h.close(); }
});

test('session changes invalidate in-flight routes and genuine distance authorization errors still require login', async () => {
  const route = deferred(); let routeBody;
  const h = await harness({ distanceAvailable: true, handler: (body, h, photo) => {
    if (body.action === 'distance') { routeBody = body; return route.promise; }
    return h.defaultResponse(body, photo);
  } });
  try {
    await h.ready(); h.set('address', '屏東縣潮州鎮中山路1號'); h.blur('address');
    h.w.sessionStorage.setItem('receipt-session', JSON.stringify({ store_id: 2, token: 'new-store-token' }));
    h.w.dispatchEvent(new h.w.Event('focus')); route.resolve(h.defaultResponse(routeBody));
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(h.$('workspace').hidden, true); assert.equal(h.$('distance-km').value, '');
    assert.equal(JSON.parse(h.w.sessionStorage.getItem('receipt-session')).token, 'new-store-token');
  } finally { h.close(); }
  const denied = await harness({ distanceAvailable: true, handler: (body, h, photo) => body.action === 'distance'
    ? response(403, { error: '門市驗證失敗' }) : h.defaultResponse(body, photo) });
  try {
    await denied.ready(); denied.set('address', '屏東縣潮州鎮中山路1號'); denied.blur('address');
    await waitFor(() => denied.$('workspace').hidden);
    assert.equal(denied.w.sessionStorage.getItem('receipt-session'), null); assert.equal(denied.$('distance-km').value, '');
    assert.match(denied.$('access-message').textContent, /門市驗證失敗/);
  } finally { denied.close(); }
});
