/**
 * DOM integration tests for the real inventory page and script.
 * Browser layout is outside jsdom's scope; these tests verify behavior and API contracts.
 * Test dependency stays outside the deployed application:
 *   npm install --prefix ../qa-runtime --save-exact jsdom@26.1.0
 *   node --test qa/meat-ui.test.cjs
 * Alternatively install jsdom in your normal test environment or set JSDOM_PATH.
 */
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

const project = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(project, 'meat-inventory.html'), 'utf8');
const source = fs.readFileSync(path.join(project, 'meat-inventory.js'), 'utf8').replace(
  /^import\s*\{([^}]+)\}\s*from\s*['"]\.\/meat-core\.mjs[^'"]*['"];?\s*/,
  'const {$1} = window.__meatCore;\n'
);
const corePromise = import(pathToFileURL(path.join(project, 'meat-core.mjs')).href);
const clone = value => JSON.parse(JSON.stringify(value));
const response = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => clone(data) });
const meatValues = (closing, thaw) => Object.fromEntries(['beef', 'pork', 'chicken'].map(id => [id, { closing, thaw, extra: 0, waste: 0, target: null }]));

async function waitFor(predicate, message = 'UI did not settle') {
  const limit = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > limit) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function harness(options = {}) {
  const core = await corePromise;
  const today = core.taipeiToday();
  const previousDate = core.shiftDate(today, -1);
  const defaultSession = { store_id: 2, store_name: '木崎(C2)', token: 'ui-test-token' };
  const session = Object.hasOwn(options, 'session') ? options.session : defaultSession;
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'https://s3235889-pixel.github.io/inventory/meat-inventory.html', runScripts: 'outside-only', virtualConsole });
  const { window } = dom;
  window.__meatCore = core;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.confirm = () => false;
  Object.defineProperty(window.crypto, 'randomUUID', { value: randomUUID, configurable: true });
  if (session) window.sessionStorage.setItem('receipt-session', JSON.stringify(session));
  const h = {
    dom, window, core, today, previousDate, errors, requests: [],
    records: options.records ?? [{ business_date: previousDate, meats: meatValues(10, 20), note: '', version: 1, updated_at: `${previousDate}T13:00:00Z` }],
    handler: options.handler || null,
    $: id => window.document.getElementById(id),
    set(id, value) { const input = this.$(id); input.value = String(value); input.dispatchEvent(new window.Event('input', { bubbles: true })); },
    click(id) { this.$(id).click(); },
    submit() { this.$('inventory-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
    async ready() { await waitFor(() => !this.$('workspace').hidden && !this.$('business-date').disabled, 'Muki workspace did not load'); },
    async idle() { await waitFor(() => !this.$('business-date').disabled, 'UI remained busy'); },
    fillAll(closing = 8, thaw = 25) { for (const id of ['beef', 'pork', 'chicken']) { this.set(`${id}-closing`, closing); this.set(`${id}-thaw`, thaw); } },
    close() { dom.window.close(); },
    loadResponse() { return response(200, { today, store_id: 2, store_name: '木崎(C2)', records: this.records, start: core.shiftDate(today.slice(0, 8) + '01', -7), end: core.shiftDate(today, 1) }); },
    defaultResponse(body) {
      if (body.action === 'load') return this.loadResponse();
      if (body.action === 'save') {
        const record = { business_date: body.date, meats: clone(body.meats), note: body.note, version: body.expected_version + 1, updated_at: `${today}T13:01:00Z` };
        this.records = [...this.records.filter(row => row.business_date !== body.date), record];
        return response(200, { record });
      }
      return response(400, { error: 'Unknown action' });
    }
  };
  window.fetch = async (url, init) => {
    assert.equal(url, 'https://rjetwgrelmvciatouwiw.supabase.co/functions/v1/meat-inventory-api');
    assert.equal(init.headers.Authorization, `Bearer ${session?.token}`);
    const body = JSON.parse(init.body);
    h.requests.push(clone(body));
    return h.handler ? h.handler(body, h) : h.defaultResponse(body);
  };
  new vm.Script(source, { filename: 'meat-inventory.js' }).runInContext(dom.getInternalVMContext());
  return h;
}

test('without a session the workspace remains hidden and no API request is made', async () => {
  const h = await harness({ session: null });
  try {
    assert.equal(h.$('workspace').hidden, true);
    assert.match(h.$('access-message').textContent, /木崎門市登入/);
    assert.equal(h.$('access-login').hidden, false);
    assert.equal(h.requests.length, 0);
  } finally { h.close(); }
});

test('another store does not see the workspace and cannot trigger a load', async () => {
  const h = await harness({ session: { store_id: 3, token: 'other-store-token' } });
  try { assert.equal(h.$('workspace').hidden, true); assert.equal(h.requests.length, 0); }
  finally { h.close(); }
});

test('Muki workspace stays hidden until the backend validates the session', async () => {
  let complete;
  const h = await harness({ handler: (_body, instance) => new Promise(resolve => { complete = () => resolve(instance.loadResponse()); }) });
  try {
    assert.equal(h.$('workspace').hidden, true);
    assert.equal(h.$('access-login').hidden, true);
    complete(); await h.ready();
    assert.equal(h.$('access-gate').hidden, true);
    assert.equal(h.$('workspace').hidden, false);
  } finally { h.close(); }
});

for (const status of [401, 403]) {
  test(`backend ${status} response keeps Muki UI hidden`, async () => {
    const h = await harness({ handler: () => response(status, { error: 'Denied' }) });
    try {
      await waitFor(() => !h.$('access-login').hidden);
      assert.equal(h.$('workspace').hidden, true);
      assert.match(h.$('access-message').textContent, status === 401 ? /登入已逾時/ : /僅限木崎/);
    } finally { h.close(); }
  });
}

test('cold stock alone reveals usage and recommendation before thaw is entered', async () => {
  const h = await harness();
  try {
    await h.ready(); h.set('beef-closing', 8);
    assert.equal(h.$('beef-usage').textContent, '22');
    assert.equal(h.$('beef-suggested').textContent, '14');
    assert.equal(h.$('beef-next').textContent, '—');
    h.click('beef-apply'); assert.equal(h.$('beef-thaw').value, '14');
    h.set('beef-thaw', 40);
    assert.equal(h.$('beef-usage').textContent, '22');
    assert.equal(h.$('beef-next').textContent, '48');
    h.set('beef-extra', 4); h.set('beef-waste', 2);
    assert.equal(h.$('beef-usage').textContent, '24');
    assert.equal(h.errors.length, 0);
  } finally { h.close(); }
});

test('three meats save atomically with date, expected version, and request ID', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fillAll(); h.set('day-note', '今晚盤點'); h.submit();
    await waitFor(() => h.$('message').textContent.startsWith('已儲存')); await h.idle();
    const saves = h.requests.filter(body => body.action === 'save');
    assert.equal(saves.length, 1);
    assert.equal(saves[0].expected_version, 0);
    assert.equal(saves[0].date, h.today);
    assert.equal(saves[0].note, '今晚盤點');
    assert.deepEqual(Object.keys(saves[0].meats).sort(), ['beef', 'chicken', 'pork']);
    assert.deepEqual(saves[0].meats.beef, { closing: 8, thaw: 25, extra: 0, waste: 0, target: null });
    assert.match(saves[0].request_id, /^[0-9a-f-]{36}$/);
    assert.equal(h.records.filter(row => row.business_date === h.today).length, 1);
    assert.match(h.$('month-summary').textContent, /22/);
    assert.equal(h.$('record-status').classList.contains('dirty'), false);
  } finally { h.close(); }
});

test('network failure retains all input and retries with the exact same request ID', async () => {
  let saveCount = 0;
  const h = await harness({ handler: (body, instance) => {
    if (body.action === 'save' && ++saveCount === 1) throw new Error('Connection lost');
    return instance.defaultResponse(body);
  } });
  try {
    await h.ready(); h.fillAll(); h.submit();
    await waitFor(() => h.$('message').textContent.includes('連線中斷')); await h.idle();
    assert.equal(h.$('beef-closing').value, '8');
    assert.equal(h.$('chicken-thaw').value, '25');
    h.submit(); await waitFor(() => h.$('message').textContent.startsWith('已儲存')); await h.idle();
    const saves = h.requests.filter(body => body.action === 'save');
    assert.equal(saves.length, 2); assert.deepEqual(saves[0], saves[1]);
    assert.equal(h.records.filter(row => row.business_date === h.today).length, 1);
  } finally { h.close(); }
});

test('409 conflict keeps unsaved values and requires a deliberate reload', async () => {
  const h = await harness({ handler: (body, instance) => body.action === 'save' ? response(409, { error: '其他裝置已更新' }) : instance.defaultResponse(body) });
  try {
    await h.ready(); h.fillAll(); h.submit();
    await waitFor(() => !h.$('conflict').hidden); await h.idle();
    assert.equal(h.$('beef-closing').value, '8');
    assert.equal(h.$('pork-thaw').value, '25');
    assert.equal(h.$('save').disabled, true);
    assert.equal(h.$('workspace').hidden, false);
    assert.match(h.$('record-status').textContent, /尚未儲存/);
  } finally { h.close(); }
});

test('cancelling a date change preserves the selected date and unsaved input', async () => {
  const h = await harness();
  try {
    await h.ready(); h.set('beef-closing', 8);
    let confirmations = 0; h.window.confirm = () => { confirmations += 1; return false; };
    h.$('business-date').value = h.previousDate;
    h.$('business-date').dispatchEvent(new h.window.Event('change', { bubbles: true }));
    assert.equal(confirmations, 1); assert.equal(h.$('business-date').value, h.today);
    assert.equal(h.$('beef-closing').value, '8');
    assert.equal(h.requests.length, 1);
  } finally { h.close(); }
});

test('failed subsequent load retains the original date and input', async () => {
  let loads = 0;
  const h = await harness({ handler: (body, instance) => {
    if (body.action === 'load' && ++loads > 1) throw new Error('Offline');
    return instance.defaultResponse(body);
  } });
  try {
    await h.ready(); h.set('beef-closing', 8); h.window.confirm = () => true;
    h.click('previous-day');
    await waitFor(() => h.$('message').textContent.includes('輸入仍保留')); await h.idle();
    assert.equal(h.$('business-date').value, h.today);
    assert.equal(h.$('beef-closing').value, '8');
    assert.equal(h.$('workspace').hidden, false);
  } finally { h.close(); }
});

test('a refresh failure after successful save explicitly preserves the success result', async () => {
  let loads = 0;
  const h = await harness({ handler: (body, instance) => {
    if (body.action === 'load' && ++loads > 1) throw new Error('Refresh failed');
    return instance.defaultResponse(body);
  } });
  try {
    await h.ready(); h.fillAll(); h.submit();
    await waitFor(() => h.$('message').textContent.includes('盤點已成功儲存')); await h.idle();
    assert.equal(h.records.filter(row => row.business_date === h.today).length, 1);
    assert.equal(h.$('record-status').classList.contains('dirty'), false);
    assert.equal(h.$('beef-closing').value, '8');
    assert.equal(h.$('save').disabled, false);
  } finally { h.close(); }
});

for (const field of ['extra', 'waste', 'target']) {
  test(`invalid optional ${field} is rejected and never silently saved as zero`, async () => {
    const h = await harness();
    try {
      await h.ready(); h.fillAll(); h.set(`beef-${field}`, '1e2');
      assert.equal(h.$(`beef-${field}`).value, '1e2');
      if (field !== 'target') assert.equal(h.$('beef-usage-box').classList.contains('invalid'), true);
      else assert.match(h.$('beef-forecast-source').textContent, /請填/);
      h.submit();
      assert.equal(h.requests.filter(body => body.action === 'save').length, 0);
      assert.match(h.$('message').textContent, /最多小數一位|最多一位小數/);
      assert.equal(h.$(`beef-${field}`).value, '1e2');
    } finally { h.close(); }
  });
}

test('missing required portions remain blank and do not become a saved zero', async () => {
  const h = await harness();
  try {
    await h.ready(); h.fillAll(); h.set('pork-closing', ''); h.submit();
    assert.equal(h.requests.filter(body => body.action === 'save').length, 0);
    assert.match(h.$('message').textContent, /豚梅花.*請填寫/);
    assert.equal(h.$('pork-closing').value, '');
  } finally { h.close(); }
});

test('first recorded day can save its baseline while usage remains unknown', async () => {
  const h = await harness({ records: [] });
  try {
    await h.ready(); h.fillAll();
    assert.equal(h.$('beef-usage').textContent, '—');
    assert.equal(h.$('beef-next').textContent, '33');
    assert.equal(h.$('beef-suggested').textContent, '—');
    h.set('beef-target', 25);
    assert.equal(h.$('beef-suggested').textContent, '17');
    h.submit(); await waitFor(() => h.$('message').textContent.startsWith('已儲存')); await h.idle();
    assert.match(h.$('month-summary').textContent, /0 天有效用量/);
    assert.equal(h.$('beef-usage').textContent, '—');
  } finally { h.close(); }
});
