import test from 'node:test';
import assert from 'node:assert/strict';
import { taipeiDateTime, localDateTimeToISO, isValidMonth, readDecimal, validateFields, isAllowedSession } from '../delivery-core.mjs';

test('Taiwan midnight and year boundary do not depend on the device timezone', () => {
  assert.equal(taipeiDateTime('2026-12-31T16:05:00Z'), '2027-01-01T00:05');
  assert.equal(taipeiDateTime('2026-11-30T15:59:00Z'), '2026-11-30T23:59');
  assert.equal(localDateTimeToISO('2026-11-01T00:00'), '2026-10-31T16:00:00.000Z');
  assert.equal(localDateTimeToISO('2026-11-30T23:59'), '2026-11-30T15:59:00.000Z');
});

test('invalid calendar dates are rejected instead of rolling into another day', () => {
  for (const date of ['2026-02-29T10:00', '2026-04-31T10:00', '2026-01-01T24:00', '1899-12-31T00:00', '2026-01-01', '2026-01-01T12:01:30']) {
    assert.equal(localDateTimeToISO(date), null, date);
  }
  assert.equal(localDateTimeToISO('2028-02-29T10:00'), '2028-02-29T02:00:00.000Z');
  assert.equal(localDateTimeToISO('9999-12-31T23:59'), '9999-12-31T15:59:00.000Z');
});

test('month validation accepts scheduled future deliveries and rejects malformed months', () => {
  for (const month of ['1900-01', '2026-11', '2040-12', '9999-12']) assert.equal(isValidMonth(month), true);
  for (const month of ['', '2026-13', '2026-1', '1899-12', '2026-11-01']) assert.equal(isValidMonth(month), false);
});

test('numeric entry requires explicit finite nonnegative numbers with at most two decimals', () => {
  for (const value of ['', ' ', '-1', 'NaN', 'Infinity', '1e2', '1,000', '0.001']) assert.equal(readDecimal(value, 10000), null, value);
  assert.equal(readDecimal('0', 10000), 0);
  assert.equal(readDecimal('.5', 10000), 0.5);
  assert.equal(readDecimal(' 120.25 ', 10000), 120.25);
  assert.equal(readDecimal('10000.01', 10000), null);
});

test('text is trimmed without changing valid content, blanks remain validation errors', () => {
  const valid = { unit_name: ' 餐廳 ', address: '屏東縣潮州鎮\n2樓', courier: '小陳 ', delivered_at: '2026-12-01T00:01', amount: '0', distance_km: '1.25' };
  const result = validateFields(valid);
  assert.equal(result.ok, true);
  assert.equal(result.value.unit_name, '餐廳');
  assert.equal(result.value.courier, '小陳');
  assert.equal(result.value.address, valid.address);
  assert.equal(result.value.delivered_at, '2026-11-30T16:01:00.000Z');
  const invalid = validateFields({ ...valid, unit_name: ' ', address: 'a'.repeat(301), amount: '' });
  assert.deepEqual(Object.keys(invalid.errors).sort(), ['address', 'amount', 'unit_name']);
});

test('the entry gate only accepts sessions for the two exact branch identifiers', () => {
  for (const store_id of [1, 2]) assert.equal(isAllowedSession({ store_id, token: 'test' }), true);
  for (const session of [null, {}, { store_id: 0, token: 'test' }, { store_id: 3, token: 'test' }, { store_id: 2, token: '' }]) {
    assert.equal(isAllowedSession(session), false);
  }
});
