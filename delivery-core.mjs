// Dates in this feature always use Taiwan time, independent of device settings.
export const ALLOWED_STORES = Object.freeze({ 1: '潮州店(C1)', 2: '木崎(C2)' });

export function taipeiDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

export function isValidMonth(value) {
  return typeof value === 'string' && /^(?:19\d{2}|[2-9]\d{3})-(?:0[1-9]|1[0-2])$/.test(value);
}

export function localDateTimeToISO(value) {
  if (typeof value !== 'string' || !/^(?:19\d{2}|[2-9]\d{3})-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+08:00`);
  if (!Number.isFinite(date.getTime()) || taipeiDateTime(date) !== value) return null;
  return date.toISOString();
}

export function readDecimal(value, max) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= max ? Math.round(amount * 100) / 100 : null;
}

export function validateFields(input) {
  const errors = {};
  const value = {};
  for (const [field, label, max] of [
    ['unit_name', '外送單位名稱', 100], ['address', '外送地址', 300], ['courier', '外送人員', 60],
  ]) {
    const text = typeof input[field] === 'string' ? input[field].trim() : '';
    if (!text || text.length > max) errors[field] = `請填寫${label}（最多 ${max} 個字）。`;
    value[field] = text;
  }
  value.delivered_at = localDateTimeToISO(input.delivered_at);
  if (!value.delivered_at) errors.delivered_at = '請填寫有效的外送日期與時間。';
  value.amount = readDecimal(input.amount, 99999999.99);
  if (value.amount === null) errors.amount = '金額請填 0 至 99,999,999.99 元，最多兩位小數。';
  value.distance_km = readDecimal(input.distance_km, 99999.99);
  if (value.distance_km === null) errors.distance_km = '距離請填 0 至 99,999.99 公里，最多兩位小數。';
  return { ok: Object.keys(errors).length === 0, errors, value };
}

export function isAllowedSession(session) {
  return session !== null && typeof session === 'object' && !Array.isArray(session)
    && Object.hasOwn(ALLOWED_STORES, Number(session.store_id))
    && typeof session.token === 'string' && session.token.length > 0;
}
