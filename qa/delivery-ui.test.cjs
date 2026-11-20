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
  w.__deliveryCore = core;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.confirm = () => true;
  Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
  let objectCounter = 0;
  w.URL.createObjectURL = () => `blob:test-${++objectCounter}`;
  w.URL.revokeObjectURL = () => {};
  if (session) w.sessionStorage.setItem('receipt-session', JSON.stringify(session));
  const h = {
    dom, w, core, month, session, errors, requests: [], records: options.records || [],
    handler: options.handler || null, decode: () => Promise.resolve(),
    $: id => w.document.getElementById(id),
    set(id, value) { const el = this.$(id); el.value = String(value); el.dispatchEvent(new w.Event('input', { bubbles: true })); },
    click(id) { this.$(id).click(); },
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
          has_more: records.length > (body.page + 1) * 50 });
      }
      if (body.action === 'save') {
        const old = this.records.find(row => row.id === body.id);
        const record = { ...body, version: body.expected_version + 1, updated_at: new Date().toISOString(), has_photo: photo ? true : body.remove_photo ? false : !!old?.has_photo };
        this.records = [record, ...this.records.filter(row => row.id !== record.id)];
        return response(200, { record });
      }
      if (body.action === 'delete') { this.records = this.records.filter(row => row.id !== body.id); return response(200, { ok: true }); }
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
    return h.handler ? h.handler(body, h, photo) : h.defaultResponse(body, photo);
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

test('saving uses explicit Taiwan time, trimmed values and zero-based new record version', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill(); h.submit(); await h.idle();
    const sent = h.requests.find(r => r.action === 'save');
    assert.equal(sent.unit_name, '潮州國小');
    assert.equal(sent.delivered_at, h.core.localDateTimeToISO(`${h.month}-01T00:05`));
    assert.equal(sent.expected_version, 0);
    assert.equal(sent.amount, 600.5); assert.equal(sent.distance_km, 2.35);
    assert.equal(Object.hasOwn(sent, 'store_id'), false);
    assert.equal(h.$('unit-name').value, '');
    assert.equal(h.$('courier').value, '小陳');
    assert.equal(h.$('total-count').textContent, '1');
    assert.match(h.$('message').textContent, /已儲存/);
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

test('concurrent edit conflicts keep the draft and cannot be blindly resubmitted', async () => {
  const h = await harness({ handler: (body, h, photo) => body.action === 'save' ? response(409, { error: '另一個畫面已更新' }) : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.records = [makeRow(h.month)]; h.click('refresh'); await h.idle();
    h.w.document.querySelector('[data-action="edit"]').click(); h.set('amount', '800'); h.submit(); await h.idle();
    assert.equal(h.$('amount').value, '800'); assert.equal(h.$('conflict').hidden, false); assert.equal(h.$('save').disabled, true);
    h.submit(); assert.equal(h.requests.filter(r => r.action === 'save').length, 1);
    h.w.confirm = () => false; h.click('reload-conflict'); assert.equal(h.$('amount').value, '800');
    h.w.confirm = () => true; h.click('reload-conflict'); await h.idle(); assert.equal(h.$('conflict').hidden, true);
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

test('choosing a replacement after removing an old photo sends replacement without removal flag', async () => {
  const h = await harness();
  try {
    await h.ready(); h.records = [makeRow(h.month, { has_photo: true })]; h.click('refresh'); await h.idle();
    h.w.document.querySelector('[data-action="edit"]').click(); h.click('remove-existing-photo'); h.photo();
    await waitFor(() => !h.$('save').disabled); h.submit(); await h.idle();
    const sent = h.requests.find(r => r.action === 'save');
    assert.equal(sent.hasUpload, true); assert.equal(sent.remove_photo, false); assert.equal(sent.expected_version, 1);
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

test('failed delete preserves the row and success removes only the selected record', async () => {
  let failDelete = true;
  const h = await harness({ handler: (body, h, photo) => body.action === 'delete' && failDelete ? response(409, { error: '資料已更新' }) : h.defaultResponse(body, photo) });
  try {
    await h.ready(); h.records = [makeRow(h.month), makeRow(h.month, { unit_name: '第二筆' })]; h.click('refresh'); await h.idle();
    h.w.document.querySelector('[data-action="delete"]').click(); await h.idle(); assert.equal(h.$('history-body').children.length, 2);
    failDelete = false; h.w.document.querySelector('[data-action="delete"]').click(); await h.idle(); assert.equal(h.$('history-body').children.length, 1);
    assert.match(h.$('history-body').textContent, /第二筆/);
  } finally { h.close(); }
});

test('a read failure is distinguished from an empty month and keeps the draft', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fill(); h.handler = () => response(500, { error: '暫時無法讀取' }); h.click('refresh'); await h.idle();
    assert.equal(h.$('unit-name').value, ' 潮州國小 '); assert.match(h.$('list-state').textContent, /無法確認/); assert.equal(h.$('total-count').textContent, '—');
  } finally { h.close(); }
});
