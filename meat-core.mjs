/** Pure calculations for the nightly meat count. All quantities are portions. */
export const MEATS = Object.freeze([
  Object.freeze({ id: 'beef', name: '牛五花' }),
  Object.freeze({ id: 'pork', name: '豚梅花' }),
  Object.freeze({ id: 'chicken', name: '雞胸肉' }),
]);

const MEAT_IDS = new Set(MEATS.map(({ id }) => id));
const MAX_PORTIONS = 10000;
const taipeiFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});

const isBlank = value => value == null || (typeof value === 'string' && value.trim() === '');
const tenths = value => Math.round(value * 10);
const meatAt = (row, id) => row?.meats?.[id] ?? {};

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Calendar arithmetic uses UTC; it does not depend on the browser's time zone. */
export function shiftDate(date, days) {
  if (!isValidDate(date) || !Number.isSafeInteger(days)) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  if (!Number.isFinite(parsed.getTime())) return null;
  const result = parsed.toISOString().slice(0, 10);
  return isValidDate(result) ? result : null;
}

/** The business date is always shown in Taiwan time, including around midnight. */
export function taipeiToday(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(taipeiFormatter.formatToParts(date).map(part => [part.type, part.value]));
  const result = `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  return isValidDate(result) ? result : null;
}

/** Empty required inputs and invalid inputs return null; optional empties mean zero. */
export function readPortions(raw, { optional = false } = {}) {
  if (isBlank(raw)) return optional ? 0 : null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  // Accept normal decimal input, including .5 and 1., but never exponent notation.
  if (typeof raw === 'string' && !/^(?:\d+(?:\.\d?)?|\.\d)$/.test(raw.trim())) return null;
  const value = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(value) || value < 0 || value > MAX_PORTIONS) return null;
  const scaled = value * 10;
  // Tolerate only floating-point representation noise, not additional precision.
  if (Math.abs(scaled - Math.round(scaled)) > Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4) return null;
  return Math.round(scaled) / 10;
}

function parseMeat(row, id) {
  const raw = meatAt(row, id);
  return {
    raw,
    closing: readPortions(raw.closing),
    thaw: readPortions(raw.thaw),
    extra: readPortions(raw.extra, { optional: true }),
    waste: readPortions(raw.waste, { optional: true }),
  };
}

/**
 * opening = yesterday's closing + yesterday's thaw.
 * available = opening + today's extra thaw.
 * usage = available - today's closing - today's waste.
 * Today's newly planned thaw belongs only to nextAvailable.
 * Partial entry still exposes every quantity that can already be calculated.
 */
export function calculateUsage(previous, current, id) {
  const result = { opening: null, available: null, usage: null, nextAvailable: null, status: 'incomplete' };
  if (!MEAT_IDS.has(id) || (current != null && (typeof current !== 'object' || Array.isArray(current)))) {
    result.status = 'invalid';
    return result;
  }
  if (!current) return result;

  const values = parseMeat(current, id);
  const currentDateValid = isValidDate(current.business_date);
  const hasPrevious = currentDateValid && previous != null &&
    previous.business_date === shiftDate(current.business_date, -1);
  const baseline = hasPrevious ? parseMeat(previous, id) : null;

  if (values.closing !== null && values.thaw !== null) {
    result.nextAvailable = (tenths(values.closing) + tenths(values.thaw)) / 10;
  }
  if (baseline?.closing != null && baseline.thaw !== null) {
    result.opening = (tenths(baseline.closing) + tenths(baseline.thaw)) / 10;
    if (values.extra !== null) result.available = (tenths(result.opening) + tenths(values.extra)) / 10;
  }
  if (result.available !== null && values.closing !== null && values.waste !== null) {
    result.usage = (tenths(result.available) - tenths(values.closing) - tenths(values.waste)) / 10;
  }

  const invalidCurrentNumber = ['closing', 'thaw', 'extra', 'waste'].some(field =>
    values[field] === null && !isBlank(values.raw[field]));
  const invalidBaselineNumber = baseline && ['closing', 'thaw'].some(field =>
    baseline[field] === null && !isBlank(baseline.raw[field]));
  if ((!currentDateValid && !isBlank(current.business_date)) || invalidCurrentNumber || invalidBaselineNumber ||
      (result.usage !== null && result.usage < 0)) {
    result.status = 'invalid';
  } else if (!currentDateValid || values.closing === null || values.thaw === null ||
      (baseline && (baseline.closing === null || baseline.thaw === null))) {
    result.status = 'incomplete';
  } else if (!hasPrevious) {
    result.status = 'missing_previous';
  } else {
    result.status = 'ok';
  }
  return result;
}

/**
 * Average valid usage on date and the preceding six calendar days.
 * A draft replaces, rather than adds to, the saved record for the selected date.
 * The draft's usage may count before its thaw is filled, since thaw affects tomorrow.
 */
export function forecast(records, date, id, draft = null) {
  const empty = { average: null, samples: 0, target: null, suggested: null, source: 'none' };
  if (!isValidDate(date) || !MEAT_IDS.has(id)) return empty;
  const byDate = new Map();
  for (const row of Array.isArray(records) ? records : []) {
    if (isValidDate(row?.business_date) && row.business_date <= date) byDate.set(row.business_date, row);
  }
  if (draft?.business_date === date) byDate.set(date, draft);

  let totalTenths = 0;
  let samples = 0;
  for (let offset = -6; offset <= 0; offset += 1) {
    const day = shiftDate(date, offset);
    const row = byDate.get(day);
    if (!row) continue;
    const result = calculateUsage(byDate.get(shiftDate(day, -1)), row, id);
    const usableDraft = row === draft && result.status === 'incomplete' && result.usage !== null && result.usage >= 0;
    if (result.status !== 'ok' && !usableDraft) continue;
    totalTenths += tenths(result.usage);
    samples += 1;
  }

  const average = samples ? totalTenths / (samples * 10) : null;
  const current = byDate.get(date);
  const values = meatAt(current, id);
  const hasManualTarget = !isBlank(values.target);
  const manualTarget = hasManualTarget ? readPortions(values.target) : null;
  const target = hasManualTarget ? manualTarget : average === null ? null : Math.ceil(average);
  const source = target === null ? 'none' : hasManualTarget ? 'manual' : 'average';
  const closing = readPortions(values.closing);
  const suggested = target === null || closing === null ? null : Math.ceil(Math.max(0, (tenths(target) - tenths(closing)) / 10));
  return { average, samples, target, suggested, source };
}

/** Validate a saved day, including the immediately following day's balance. */
export function validateDay(row, previous = null, next = null) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return ['盤點記錄格式不正確。'];
  const errors = [];
  const dateValid = isValidDate(row.business_date);
  if (!dateValid) errors.push('請選擇有效的盤點日期。');

  const fields = [
    ['closing', '今晚冷藏剩餘', true],
    ['thaw', '今晚退冰份數', true],
    ['extra', '今日追加退冰', false],
    ['waste', '今日耗損', false],
    ['target', '明日預計用量', false],
  ];
  for (const { id, name } of MEATS) {
    const values = meatAt(row, id);
    let validValues = true;
    for (const [field, label, required] of fields) {
      if (isBlank(values[field])) {
        if (required) {
          errors.push(`${name}：請填寫${label}，沒有時請填 0。`);
          validValues = false;
        }
      } else if (readPortions(values[field]) === null) {
        errors.push(`${name}：${label}須為 0～10,000 份，最多一位小數。`);
        validValues = false;
      }
    }
    if (!validValues || !dateValid) continue;

    const usage = calculateUsage(previous, row, id);
    if (usage.usage !== null && usage.usage < 0) {
      errors.push(`${name}：今日使用量為負數（${usage.usage} 份），請檢查冷藏剩餘、追加退冰與耗損。`);
    }
    if (next?.business_date === shiftDate(row.business_date, 1)) {
      const following = calculateUsage(row, next, id);
      if (following.usage !== null && following.usage < 0) {
        errors.push(`${name}：此修改會使 ${next.business_date} 的使用量為負數（${following.usage} 份），請確認次日盤點。`);
      }
    }
  }
  return errors;
}
