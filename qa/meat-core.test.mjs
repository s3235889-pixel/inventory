import test from 'node:test';
import assert from 'node:assert/strict';
import { MEATS, taipeiToday, shiftDate, isValidDate, readPortions, calculateUsage, forecast, validateDay } from '../meat-core.mjs';

function day(date, beef = {}, others = {}) {
  const meat = overrides => ({ closing: 0, thaw: 0, extra: 0, waste: 0, target: null, ...overrides });
  return {
    business_date: date,
    meats: { beef: meat(beef), pork: meat(others.pork), chicken: meat(others.chicken) },
    note: '', version: 1, updated_at: `${date}T12:00:00Z`,
  };
}

test('fixed meat names match the three requested products', () => {
  assert.deepEqual(MEATS.map(({ id, name }) => [id, name]), [
    ['beef', '牛五花'], ['pork', '豚梅花'], ['chicken', '雞胸肉'],
  ]);
});

test('Taiwan date changes at 16:00 UTC, independently of the host time zone', () => {
  assert.equal(taipeiToday(new Date('2026-11-17T15:59:59.999Z')), '2026-11-17');
  assert.equal(taipeiToday(new Date('2026-11-17T16:00:00.000Z')), '2026-11-18');
  assert.equal(taipeiToday('2026-12-31T16:00:00Z'), '2027-01-01');
  assert.equal(taipeiToday(new Date('invalid')), null);
});

test('strict calendar validation rejects normalized or incorrectly formatted dates', () => {
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-1-01', '', null, 20261117]) {
    assert.equal(isValidDate(value), false, String(value));
  }
  for (const value of ['2024-02-29', '2026-02-28', '2026-11-17', '2026-12-31']) assert.equal(isValidDate(value), true);
});

test('date arithmetic covers month ends, leap days and year ends', () => {
  assert.equal(shiftDate('2026-11-30', 1), '2026-12-01');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2024-03-01', -1), '2024-02-29');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDate('2026-02-29', 1), null);
  assert.equal(shiftDate('2026-11-17', 0.5), null);
});

test('portion parsing distinguishes empty from zero and accepts one decimal place', () => {
  assert.equal(readPortions(''), null);
  assert.equal(readPortions('   '), null);
  assert.equal(readPortions(undefined), null);
  assert.equal(readPortions(null, { optional: true }), 0);
  assert.equal(readPortions('', { optional: true }), 0);
  assert.equal(readPortions(0), 0);
  assert.equal(readPortions('0'), 0);
  assert.equal(readPortions(' 12.5 '), 12.5);
  assert.equal(readPortions('.5'), 0.5);
  assert.equal(readPortions('1.'), 1);
  assert.equal(readPortions(10000), 10000);
  assert.equal(readPortions(0.1 + 0.2), 0.3);
});

test('portion parsing rejects negative, excessive, fractional and non-numeric values', () => {
  for (const value of [-1, '−1', '12.34', 12.34, '1.00', 10000.1, '1e2', NaN, Infinity, true, false, {}, [], '肉', '1,000']) {
    assert.equal(readPortions(value), null, String(value));
    assert.equal(readPortions(value, { optional: true }), null, String(value));
  }
});

test('nightly count assigns tonight thaw only to tomorrow', () => {
  const yesterday = day('2026-11-17', { closing: 10, thaw: 20 });
  const today = day('2026-11-18', { closing: 8, thaw: 25 });
  assert.deepEqual(calculateUsage(yesterday, today, 'beef'), {
    opening: 30, available: 30, usage: 22, nextAvailable: 33, status: 'ok',
  });
  today.meats.beef.thaw = 40;
  assert.equal(calculateUsage(yesterday, today, 'beef').usage, 22);
  assert.equal(calculateUsage(yesterday, today, 'beef').nextAvailable, 48);
});

test('same-day extra thaw and waste are accounted for separately', () => {
  const yesterday = day('2026-11-17', { closing: 10, thaw: 20 });
  const today = day('2026-11-18', { closing: 8, thaw: 25, extra: 4, waste: 2 });
  assert.deepEqual(calculateUsage(yesterday, today, 'beef'), {
    opening: 30, available: 34, usage: 24, nextAvailable: 33, status: 'ok',
  });
});

test('decimal quantities do not create floating-point negative or residual usage', () => {
  const yesterday = day('2026-11-17', { closing: 0.1, thaw: 0.2 });
  assert.deepEqual(calculateUsage(yesterday, day('2026-11-18', { closing: 0.3, thaw: 0.2 }), 'beef'), {
    opening: 0.3, available: 0.3, usage: 0, nextAvailable: 0.5, status: 'ok',
  });
});

test('first count establishes tomorrow stock without inventing today usage', () => {
  assert.deepEqual(calculateUsage(null, day('2026-11-17', { closing: 8, thaw: 25 }), 'beef'), {
    opening: null, available: null, usage: null, nextAvailable: 33, status: 'missing_previous',
  });
  assert.deepEqual(validateDay(day('2026-11-17', { closing: 8, thaw: 25 })), []);
});

test('a gap cannot become a multi-day usage presented as one day', () => {
  const older = day('2026-11-15', { closing: 10, thaw: 20 });
  const today = day('2026-11-17', { closing: 8, thaw: 25 });
  assert.equal(calculateUsage(older, today, 'beef').status, 'missing_previous');
  assert.equal(calculateUsage(older, today, 'beef').usage, null);
  const tomorrow = day('2026-11-18', { closing: 3, thaw: 20 });
  assert.equal(calculateUsage(today, tomorrow, 'beef').usage, 30);
});

test('empty today thaw allows preview of usage but prevents next stock and saving', () => {
  const yesterday = day('2026-11-17', { closing: 10, thaw: 20 });
  const today = day('2026-11-18', { closing: 8, thaw: '' });
  assert.deepEqual(calculateUsage(yesterday, today, 'beef'), {
    opening: 30, available: 30, usage: 22, nextAvailable: null, status: 'incomplete',
  });
  assert.match(validateDay(today, yesterday).join('\n'), /牛五花.*今晚退冰/);
});

test('empty closing is not silently interpreted as zero', () => {
  const yesterday = day('2026-11-17', { closing: 10, thaw: 20 });
  const today = day('2026-11-18', { closing: '', thaw: 10 });
  const result = calculateUsage(yesterday, today, 'beef');
  assert.equal(result.opening, 30);
  assert.equal(result.usage, null);
  assert.equal(result.nextAvailable, null);
  assert.equal(result.status, 'incomplete');
  assert.match(validateDay(today, yesterday).join('\n'), /牛五花.*冷藏/);
});

test('negative usage remains visible as invalid rather than being clamped to zero', () => {
  const yesterday = day('2026-11-17', { closing: 5, thaw: 15 });
  const today = day('2026-11-18', { closing: 25, thaw: 10 });
  assert.equal(calculateUsage(yesterday, today, 'beef').usage, -5);
  assert.equal(calculateUsage(yesterday, today, 'beef').status, 'invalid');
  assert.match(validateDay(today, yesterday).join('\n'), /今日使用量為負數（-5 份）/);
  today.meats.beef.extra = 5;
  assert.deepEqual(validateDay(today, yesterday), []);
});

test('invalid current or baseline quantities are not usable data', () => {
  const yesterday = day('2026-11-17', { closing: 10, thaw: 20 });
  const today = day('2026-11-18', { closing: 8, thaw: 'bad' });
  assert.equal(calculateUsage(yesterday, today, 'beef').status, 'invalid');
  today.meats.beef.thaw = 25;
  yesterday.meats.beef.thaw = '';
  assert.equal(calculateUsage(yesterday, today, 'beef').status, 'incomplete');
  yesterday.meats.beef.thaw = -1;
  assert.equal(calculateUsage(yesterday, today, 'beef').status, 'invalid');
  assert.equal(calculateUsage(null, day('2026-02-29'), 'beef').status, 'invalid');
  assert.equal(calculateUsage(null, today, 'unknown').status, 'invalid');
});

test('empty optional extra and waste mean zero; target does not alter measured usage', () => {
  const yesterday = day('2026-11-17', { closing: 10, thaw: 20 });
  const today = day('2026-11-18', { closing: 8, thaw: 25, extra: '', waste: undefined, target: 500 });
  assert.equal(calculateUsage(yesterday, today, 'beef').usage, 22);
  assert.equal(calculateUsage(yesterday, today, 'beef').status, 'ok');
});

test('forecast averages valid days, subtracts closing stock and has no hidden buffer', () => {
  const records = [
    day('2026-11-14', { closing: 0, thaw: 20 }),
    day('2026-11-15', { closing: 0, thaw: 30 }),
    day('2026-11-16', { closing: 0, thaw: 33 }),
    day('2026-11-17', { closing: 8, thaw: 40 }),
  ];
  assert.deepEqual(forecast(records, '2026-11-17', 'beef'), {
    average: 25, samples: 3, target: 25, suggested: 17, source: 'average',
  });
});

test('forecast includes real zero-usage days', () => {
  const records = [
    day('2026-11-15', { closing: 0, thaw: 20 }),
    day('2026-11-16', { closing: 20, thaw: 0 }),
    day('2026-11-17', { closing: 0, thaw: 20 }),
  ];
  assert.deepEqual(forecast(records, '2026-11-17', 'beef'), {
    average: 10, samples: 2, target: 10, suggested: 10, source: 'average',
  });
});

test('forecast with no valid usage is unknown, not zero', () => {
  const records = [day('2026-11-17', { closing: 8, thaw: 25 })];
  assert.deepEqual(forecast(records, '2026-11-17', 'beef'), {
    average: null, samples: 0, target: null, suggested: null, source: 'none',
  });
});

test('forecast only uses selected date and prior six days, with a separate prior-day basis', () => {
  const records = [];
  // Each date after the initial basis has 10 portions used, except a stale old day.
  for (let offset = -10; offset <= 1; offset += 1) {
    records.push(day(shiftDate('2026-11-17', offset), { closing: 0, thaw: offset === -9 ? 1000 : 10 }));
  }
  assert.deepEqual(forecast(records, '2026-11-17', 'beef'), {
    average: 10, samples: 7, target: 10, suggested: 10, source: 'average',
  });
  records.at(-1).meats.beef.extra = 9000;
  assert.equal(forecast(records, '2026-11-17', 'beef').average, 10);
});

test('forecast does not bridge missing days or count negative days', () => {
  const records = [
    day('2026-11-13', { closing: 0, thaw: 10 }),
    day('2026-11-15', { closing: 0, thaw: 10 }),
    day('2026-11-16', { closing: 15, thaw: 10 }),
    day('2026-11-17', { closing: 5, thaw: 10 }),
  ];
  const result = forecast(records, '2026-11-17', 'beef');
  assert.equal(result.samples, 1);
  assert.equal(result.average, 20);
});

test('same-day draft replaces saved count without double counting and works before thaw entry', () => {
  const records = [
    day('2026-11-16', { closing: 10, thaw: 20 }),
    day('2026-11-17', { closing: 8, thaw: 25 }),
  ];
  const draft = day('2026-11-17', { closing: 10, thaw: '' });
  assert.deepEqual(forecast(records, '2026-11-17', 'beef', draft), {
    average: 20, samples: 1, target: 20, suggested: 10, source: 'average',
  });
  assert.equal(records[1].meats.beef.closing, 8, 'forecast does not mutate saved data');
});

test('incomplete saved rows are not samples and incomplete drafts need computable usage', () => {
  const prior = day('2026-11-16', { closing: 10, thaw: 20 });
  const incomplete = day('2026-11-17', { closing: 8, thaw: '' });
  assert.equal(forecast([prior, incomplete], '2026-11-17', 'beef').samples, 0);
  const missingClosing = day('2026-11-17', { closing: '', thaw: '' });
  assert.equal(forecast([prior], '2026-11-17', 'beef', missingClosing).samples, 0);
  const invalidThaw = day('2026-11-17', { closing: 8, thaw: -1 });
  assert.equal(forecast([prior], '2026-11-17', 'beef', invalidThaw).samples, 0);
});

test('manual target takes priority, including zero, without requiring history', () => {
  const current = day('2026-11-17', { closing: 8, thaw: 25, target: 30 });
  assert.deepEqual(forecast([current], current.business_date, 'beef'), {
    average: null, samples: 0, target: 30, suggested: 22, source: 'manual',
  });
  current.meats.beef.target = 0;
  assert.deepEqual(forecast([current], current.business_date, 'beef'), {
    average: null, samples: 0, target: 0, suggested: 0, source: 'manual',
  });
});

test('suggested thaw rounds upward and never becomes negative or deducts tonight thaw twice', () => {
  const current = day('2026-11-17', { closing: 3.5, thaw: 100, target: 10.2 });
  assert.equal(forecast([current], current.business_date, 'beef').suggested, 7);
  current.meats.beef.closing = 30;
  assert.equal(forecast([current], current.business_date, 'beef').suggested, 0);
  current.meats.beef.closing = '';
  assert.equal(forecast([current], current.business_date, 'beef').suggested, null);
});

test('fractional average rounds the target up instead of truncating demand', () => {
  const records = [
    day('2026-11-15', { closing: 0, thaw: 10 }),
    day('2026-11-16', { closing: 0, thaw: 11 }),
    day('2026-11-17', { closing: 0, thaw: 0 }),
  ];
  assert.deepEqual(forecast(records, '2026-11-17', 'beef'), {
    average: 10.5, samples: 2, target: 11, suggested: 11, source: 'average',
  });
});

test('invalid manual demand does not silently fall back to an automatic target', () => {
  const records = [
    day('2026-11-16', { closing: 0, thaw: 20 }),
    day('2026-11-17', { closing: 0, thaw: 20, target: -1 }),
  ];
  assert.deepEqual(forecast(records, '2026-11-17', 'beef'), {
    average: 20, samples: 1, target: null, suggested: null, source: 'none',
  });
  assert.match(validateDay(records[1], records[0]).join('\n'), /明日預計用量/);
});

test('all meats retain separate counts and forecasts', () => {
  const previous = day('2026-11-16', { closing: 10, thaw: 20 }, {
    pork: { closing: 5, thaw: 10 }, chicken: { closing: 2, thaw: 5 },
  });
  const current = day('2026-11-17', { closing: 8, thaw: 25 }, {
    pork: { closing: 4, thaw: 10 }, chicken: { closing: 3, thaw: 6 },
  });
  assert.deepEqual(MEATS.map(({ id }) => calculateUsage(previous, current, id).usage), [22, 11, 4]);
  assert.deepEqual(MEATS.map(({ id }) => forecast([previous, current], current.business_date, id).average), [22, 11, 4]);
});

test('editing historical thaw changes the following day, not that day usage', () => {
  const before = day('2026-11-15', { closing: 10, thaw: 20 });
  const edited = day('2026-11-16', { closing: 10, thaw: 20 });
  const next = day('2026-11-17', { closing: 8, thaw: 25 });
  assert.equal(calculateUsage(before, edited, 'beef').usage, 20);
  assert.equal(calculateUsage(edited, next, 'beef').usage, 22);
  edited.meats.beef.thaw = 25;
  assert.equal(calculateUsage(before, edited, 'beef').usage, 20);
  assert.equal(calculateUsage(edited, next, 'beef').usage, 27);
  assert.equal(forecast([before, edited, next], '2026-11-17', 'beef').average, 23.5);
});

test('editing historical closing recalculates both that day and the next', () => {
  const previous = day('2026-11-15', { closing: 10, thaw: 20 });
  const edited = day('2026-11-16', { closing: 8, thaw: 25 });
  const next = day('2026-11-17', { closing: 3, thaw: 20 });
  edited.meats.beef.closing = 7;
  assert.equal(calculateUsage(previous, edited, 'beef').usage, 23);
  assert.equal(calculateUsage(edited, next, 'beef').opening, 32);
  assert.equal(calculateUsage(edited, next, 'beef').usage, 29);
});

test('historical save blocks creating a negative following day balance', () => {
  const previous = day('2026-11-15', { closing: 10, thaw: 20 });
  const edited = day('2026-11-16', { closing: 5, thaw: 0 });
  const next = day('2026-11-17', { closing: 8, thaw: 20 });
  const errors = validateDay(edited, previous, next);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /牛五花.*2026-11-17.*負數/);
  next.meats.beef.extra = 3;
  assert.deepEqual(validateDay(edited, previous, next), []);
});

test('historical save only checks the immediately following date, including month ends', () => {
  const edited = day('2026-11-30', { closing: 5, thaw: 0 });
  assert.match(validateDay(edited, null, day('2026-12-01', { closing: 8, thaw: 20 })).join('\n'), /2026-12-01/);
  assert.deepEqual(validateDay(edited, null, day('2026-12-02', { closing: 8, thaw: 20 })), []);
});

test('adding a missing historical day repairs the following-day baseline automatically', () => {
  const first = day('2026-11-15', { closing: 0, thaw: 20 });
  const next = day('2026-11-17', { closing: 5, thaw: 20 });
  assert.equal(forecast([first, next], next.business_date, 'beef').samples, 0);
  const backfill = day('2026-11-16', { closing: 5, thaw: 20 });
  assert.deepEqual(validateDay(backfill, first, next), []);
  assert.deepEqual(forecast([first, backfill, next], next.business_date, 'beef'), {
    average: 17.5, samples: 2, target: 18, suggested: 13, source: 'average',
  });
});

test('validation identifies missing or invalid fields for each meat without crashing', () => {
  assert.equal(validateDay(null).length, 1);
  assert.equal(validateDay({ business_date: 'invalid', meats: {} }).length, 7);
  const current = day('2026-11-17', { extra: -1, waste: 'bad', target: 1.23 });
  const errors = validateDay(current);
  assert.equal(errors.length, 3);
  assert.match(errors.join('\n'), /今日追加退冰/);
  assert.match(errors.join('\n'), /今日耗損/);
  assert.match(errors.join('\n'), /明日預計用量/);
});

test('forecast and calculations leave inputs unchanged and tolerate irrelevant future drafts', () => {
  const records = [day('2026-11-16', { thaw: 20 }), day('2026-11-17', { closing: 5, thaw: 10 })];
  const original = JSON.stringify(records);
  const futureDraft = day('2026-11-18', { closing: 0, thaw: 50 });
  forecast(records, '2026-11-17', 'beef', futureDraft);
  validateDay(records[1], records[0]);
  assert.equal(JSON.stringify(records), original);
  assert.equal(forecast(records, '2026-11-17', 'beef', futureDraft).average, 15);
  assert.equal(forecast(records, 'bad-date', 'beef').source, 'none');
});
