import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validateAdminFields, isCompleteRecord, filterAndSortRecords, recordTotals, normalizeSearch, PAGE_SIZE, MAX_RECORDS } from '../delivery-admin-core.mjs';

const input = { store_id: '1', unit_name: ' 潮州國小 ', address: '屏東縣潮州鎮中山路1號', courier: ' 小陳 ', delivered_at: '2026-11-01T00:05', amount: '600.50', distance_km: '2.35', vehicle_type: 'personal' };
const row = overrides => ({ id: randomUUID(), store_id: 1, unit_name: '潮州國小', address: '屏東縣潮州鎮中山路1號', courier: '小陳', delivered_at: '2026-10-31T16:05:00.000Z', amount: 600.5, distance_km: 2.35, vehicle_type: 'personal', version: 1, has_photo: false, ...overrides });

test('administrator validation keeps Taiwan date, numeric cells, allowed stores and new vehicle requirement', () => {
  const result = validateAdminFields(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { store_id: 1, unit_name: '潮州國小', address: input.address, courier: '小陳', delivered_at: '2026-10-31T16:05:00.000Z', amount: 600.5, distance_km: 2.35, vehicle_type: 'personal' });
  for (const store_id of ['0', '3', '', 'invalid']) assert.equal(validateAdminFields({ ...input, store_id }).ok, false);
  for (const vehicle_type of ['', null, 'scooter']) assert.equal(validateAdminFields({ ...input, vehicle_type }).ok, false);
  assert.equal(validateAdminFields({ ...input, address: '屏東縣' }).ok, false);
});

test('only explicit legacy mode accepts unrecorded vehicle and still validates all fields', () => {
  const result = validateAdminFields({ ...input, vehicle_type: '' }, { allowUnrecordedVehicle: true });
  assert.equal(result.ok, true); assert.equal(result.value.vehicle_type, null);
  assert.equal(validateAdminFields({ ...input, vehicle_type: 'invalid' }, { allowUnrecordedVehicle: true }).ok, false);
  assert.equal(validateAdminFields({ ...input, vehicle_type: null, amount: '-1' }, { allowUnrecordedVehicle: true }).ok, false);
});

test('complete record guard rejects partial, invalid, or numerically formatted server rows', () => {
  assert.equal(isCompleteRecord(row({})), true);
  assert.equal(isCompleteRecord(row({ vehicle_type: null })), true);
  for (const override of [{ id: 'x' }, { amount: '600.50' }, { distance_km: NaN }, { store_id: 3 }, { version: 0 }, { has_photo: 'true' }, { vehicle_type: 'scooter' }, { delivered_at: 'nonsense' }]) assert.equal(Boolean(isCompleteRecord(row(override))), false);
  assert.equal(PAGE_SIZE, 50); assert.equal(MAX_RECORDS, 10000);
});

test('filtering covers normalized terms and legacy vehicle without changing source records', () => {
  const a = row({ unit_name: 'ＡＢＣ ２', vehicle_type: null });
  const b = row({ store_id: 2, unit_name: '木崎活動', vehicle_type: 'store' });
  const records = [a, b], before = [...records];
  assert.deepEqual(filterAndSortRecords(records, { search: 'abc 2' }), [a]);
  assert.deepEqual(filterAndSortRecords(records, { vehicle: 'unknown' }), [a]);
  assert.deepEqual(filterAndSortRecords(records, { search: '木崎', vehicle: 'store' }), [b]);
  assert.deepEqual(filterAndSortRecords(records, { search: '2026-11-01' }), [a, b].sort((x, y) => x.id.localeCompare(y.id)));
  assert.deepEqual(records, before); assert.equal(normalizeSearch(' ＡＢＣ '), 'abc');
});

test('all sortable fields support deterministic directions, numeric sorting and tied rows', () => {
  const records = [row({ store_id: 2, unit_name: '單位10', courier: '人員10', amount: 10, distance_km: 10, vehicle_type: null, delivered_at: '2026-11-03T10:00:00Z' }), row({ unit_name: '單位2', courier: '人員2', amount: 2, distance_km: 2, vehicle_type: 'personal', delivered_at: '2026-11-01T10:00:00Z' })];
  for (const sort of ['store_id', 'unit_name', 'courier', 'amount', 'distance_km', 'vehicle_type', 'delivered_at']) {
    assert.equal(filterAndSortRecords(records, { sort, direction: 'asc' })[0], records[1]);
    assert.equal(filterAndSortRecords(records, { sort, direction: 'desc' })[0], records[0]);
  }
  const first = row({ id: '00000000-0000-4000-8000-000000000001' }), second = { ...first, id: '00000000-0000-4000-8000-000000000002' };
  assert.deepEqual(filterAndSortRecords([second, first], { sort: 'amount' }), [first, second]);
});

test('totals accumulate hundredths without floating point display errors', () => {
  assert.deepEqual(recordTotals([row({ amount: .1, distance_km: .1 }), row({ amount: .2, distance_km: .2 })]), { count: 2, amount: .3, distance: .3 });
  assert.deepEqual(recordTotals([]), { count: 0, amount: 0, distance: 0 });
});
