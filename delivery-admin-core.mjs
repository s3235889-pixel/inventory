import { ALLOWED_STORES, DEFAULT_DELIVERY_ADDRESS, VEHICLE_TYPES, vehicleTypeLabel, taipeiDateTime, isValidMonth, isCountyPrefixOnly, validateFields } from './delivery-core.mjs?v=20261125-vehicle1';

export { ALLOWED_STORES, DEFAULT_DELIVERY_ADDRESS, VEHICLE_TYPES, vehicleTypeLabel, taipeiDateTime, isValidMonth, isCountyPrefixOnly };
export const PAGE_SIZE = 50;
export const MAX_RECORDS = 10000;
export const STORE_ORIGINS = Object.freeze({ 1: '屏東縣潮州鎮文化路42號', 2: '屏東縣潮州鎮東華路25號' });
export const SORT_LABELS = Object.freeze({
  delivered_at: '外送日期時間', store_id: '門市', unit_name: '外送單位', courier: '外送人員',
  amount: '金額', distance_km: '公里數', vehicle_type: '使用車輛',
});
export const VEHICLE_FILTER_LABELS = Object.freeze({ all: '全部車輛', personal: '自用車', store: '店用車', unknown: '未記錄' });
const collator = new Intl.Collator('zh-Hant-TW', { numeric: true, sensitivity: 'base' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAdminFields(raw, { allowUnrecordedVehicle = false } = {}) {
  const candidate = { ...raw, vehicle_type: allowUnrecordedVehicle && (raw.vehicle_type === '' || raw.vehicle_type === null) ? 'personal' : raw.vehicle_type };
  const result = validateFields(candidate);
  if (allowUnrecordedVehicle && (raw.vehicle_type === '' || raw.vehicle_type === null)) result.value.vehicle_type = null;
  const store = Number(raw.store_id);
  if (!Object.hasOwn(ALLOWED_STORES, store)) result.errors.store_id = '請選擇潮州店或木崎。';
  result.value.store_id = store;
  result.ok = Object.keys(result.errors).length === 0;
  return result;
}

export function isCompleteRecord(row) {
  return row && typeof row === 'object' && !Array.isArray(row) && UUID.test(row.id || '')
    && Number.isInteger(row.store_id) && Object.hasOwn(ALLOWED_STORES, row.store_id)
    && ['unit_name', 'address', 'courier', 'delivered_at'].every(key => typeof row[key] === 'string')
    && Number.isFinite(Date.parse(row.delivered_at))
    && typeof row.amount === 'number' && Number.isFinite(row.amount) && row.amount >= 0 && row.amount <= 99999999.99
    && typeof row.distance_km === 'number' && Number.isFinite(row.distance_km) && row.distance_km >= 0 && row.distance_km <= 99999.99
    && (row.vehicle_type === null || Object.hasOwn(VEHICLE_TYPES, row.vehicle_type))
    && typeof row.has_photo === 'boolean' && Number.isInteger(row.version) && row.version > 0;
}

export function normalizeSearch(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-TW');
}

export function filterAndSortRecords(records, { search = '', vehicle = 'all', sort = 'delivered_at', direction = 'desc' } = {}) {
  const query = normalizeSearch(search);
  const key = Object.hasOwn(SORT_LABELS, sort) ? sort : 'delivered_at';
  const sign = direction === 'asc' ? 1 : -1;
  const selected = records.filter(row => {
    if (vehicle !== 'all' && (vehicle === 'unknown' ? row.vehicle_type != null : row.vehicle_type !== vehicle)) return false;
    if (!query) return true;
    const haystack = [row.unit_name, row.address, row.courier, ALLOWED_STORES[row.store_id], vehicleTypeLabel(row.vehicle_type), taipeiDateTime(row.delivered_at)].join(' ');
    return normalizeSearch(haystack).includes(query);
  });
  const compare = (a, b) => {
    if (key === 'delivered_at') return Date.parse(a.delivered_at) - Date.parse(b.delivered_at);
    if (['store_id', 'amount', 'distance_km'].includes(key)) return Number(a[key]) - Number(b[key]);
    if (key === 'vehicle_type') {
      const order = { personal: 0, store: 1 };
      return (order[a.vehicle_type] ?? 2) - (order[b.vehicle_type] ?? 2);
    }
    return collator.compare(a[key], b[key]);
  };
  return selected.sort((a, b) => sign * compare(a, b) || b.delivered_at.localeCompare(a.delivered_at) || a.id.localeCompare(b.id));
}

export function recordTotals(records) {
  return {
    count: records.length,
    amount: records.reduce((sum, row) => sum + Math.round(row.amount * 100), 0) / 100,
    distance: records.reduce((sum, row) => sum + Math.round(row.distance_km * 100), 0) / 100,
  };
}
