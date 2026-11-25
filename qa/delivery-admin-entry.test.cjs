const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('../../qa-runtime/node_modules/jsdom');
const source = fs.readFileSync(new URL('../admin.html', `file://${__filename}`), 'utf8');

function setup(hash = '') {
  const dom = new JSDOM(source, { url: `https://example.test/inventory/admin.html${hash}`, runScripts: 'outside-only' });
  const calls = { manage: 0, monthly: 0 };
  dom.window.fetchManageOrders = () => calls.manage++;
  dom.window.loadMonthlyData = () => calls.monthly++;
  const start = source.indexOf('    function switchMainTab(tab) {');
  const end = source.indexOf('    async function loadBaseDropdowns()', start);
  new vm.Script(source.slice(start, end)).runInContext(dom.getInternalVMContext());
  return { dom, calls, document: dom.window.document };
}

test('main management system opens the gated delivery page inside its fourth tab', () => {
  const { dom, document } = setup();
  const frame = document.getElementById('delivery-admin-frame');
  assert.equal(frame.getAttribute('src'), null);
  dom.window.switchMainTab('delivery');
  assert.equal(document.getElementById('tab-delivery-content').classList.contains('hidden'), false);
  assert.equal(document.getElementById('tab-daily-content').classList.contains('hidden'), true);
  assert.equal(frame.getAttribute('src'), 'delivery-admin.html?v=20261125-admin1');
  assert.equal(dom.window.location.hash, '#delivery');
  assert.equal(document.getElementById('btn-tab-delivery').getAttribute('aria-pressed'), 'true');
  dom.window.close();
});

test('delivery deep link opens directly and switching back preserves all existing tabs', () => {
  const { dom, calls, document } = setup('#delivery');
  const frame = document.getElementById('delivery-admin-frame');
  assert.equal(document.getElementById('tab-delivery-content').classList.contains('hidden'), false);
  for (const name of ['manage', 'monthly', 'daily', 'delivery']) {
    dom.window.switchMainTab(name);
    const visible = ['daily', 'manage', 'monthly', 'delivery'].filter(value => !document.getElementById(`tab-${value}-content`).classList.contains('hidden'));
    assert.deepEqual(visible, [name]);
  }
  assert.deepEqual(calls, { manage: 1, monthly: 1 });
  assert.equal(document.getElementById('delivery-admin-frame'), frame);
  dom.window.switchMainTab('daily');
  assert.equal(dom.window.location.hash, '');
  dom.window.close();
});
