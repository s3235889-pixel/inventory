// A separate endpoint for the existing shared administrator session. Store
// tokens are never promoted into administrator access by a request field.
import { createDistanceService, DistanceError } from '../delivery-api/distance.ts';
import type { DistanceService } from '../delivery-api/distance.ts';

const ORIGIN = 'https://s3235889-pixel.github.io';
const STORES: Record<number, string> = { 1: '潮州店(C1)', 2: '木崎(C2)' };
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024;
const MAX_ROWS = 10000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only these known rejections prove the current attempt's object is unused.
// Connection/statement completion unknown (08007/40003) must retain it.
const REJECTED_TRANSACTION_CODES = new Set(['22023', '23502', '23503', '23505', '23514', '40001', '42501', '55000', 'P0002']);
const encoder = new TextEncoder();

type DatabaseError = { code?: string; message?: string };
type Result<T> = { data: T | null; error: DatabaseError | null };
export type VehicleType = 'personal' | 'store';
export type AdminRecord = {
  id: string; store_id: number; unit_name: string; address: string; courier: string;
  delivered_at: string; amount: number; distance_km: number; vehicle_type: VehicleType | null;
  has_photo: boolean; version: number; updated_at: string; created_at?: string;
};
export type LoadResult = { records: AdminRecord[]; total_count: number; total_amount: number; total_distance_km: number };
export type SaveArguments = {
  p_store_id: number; p_id: string; p_request_id: string; p_expected_version: number;
  p_record: Pick<AdminRecord, 'unit_name' | 'address' | 'courier' | 'delivered_at' | 'amount' | 'distance_km' | 'vehicle_type'>;
  p_photo_path: string | null; p_request_fingerprint: string; p_admin_session_version: number;
};
export type SaveResult = { record: AdminRecord; photo_path: string | null };
export type DeleteArguments = {
  p_store_id: number; p_id: string; p_request_id: string; p_expected_version: number;
  p_request_fingerprint: string; p_admin_session_version: number;
};
export type DeleteResult = { deleted: true; id: string; store_id: number; version: number };
export type AttachPhotoArguments = {
  p_store_id: number; p_id: string; p_request_id: string; p_expected_version: number;
  p_photo_hash: string; p_photo_path: string | null;
};
// The original attachment RPC returns an ordinary record without store_id.
export type AttachPhotoResult = { record: Omit<AdminRecord, 'store_id'> & { store_id?: number }; photo_path: string | null; ready_for_upload: boolean };
export type Dependencies = {
  key: CryptoKey;
  adminSessionVersion: () => Promise<Result<{ session_version: number }>>;
  loadRecords: (store: number | null, month: string) => Promise<Result<LoadResult>>;
  saveRecord: (args: SaveArguments) => Promise<Result<SaveResult>>;
  deleteRecord: (args: DeleteArguments) => Promise<Result<DeleteResult>>;
  attachRecordPhoto: (args: AttachPhotoArguments) => Promise<Result<AttachPhotoResult>>;
  photoPath: (store: number, id: string) => Promise<Result<{ photo_path: string | null }>>;
  uploadPhoto: (path: string, bytes: Uint8Array, mime: string) => Promise<{ error: DatabaseError | null }>;
  removePhotos: (paths: string[]) => Promise<{ error: DatabaseError | null }>;
  signPhoto: (path: string, seconds: number) => Promise<Result<{ signedUrl: string }>>;
  distance?: DistanceService;
  now?: () => number;
};

class RequestError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 400, code?: string) { super(message); this.status = status; this.code = code; }
}
function fail(message: string, status = 400, code?: string): never { throw new RequestError(message, status, code); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function decode64(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}
async function authenticate(request: Request, dependencies: Dependencies, now: number): Promise<number> {
  const authorization = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!match || authorization.length > 4096) fail('請先使用管理者帳號登入', 401, 'admin_session_expired');
  let payload: unknown;
  try {
    const signature = decode64(match[2]);
    if (signature.length !== 32 || !await crypto.subtle.verify('HMAC', dependencies.key, signature, encoder.encode(match[1]))) {
      fail('管理者登入驗證失敗，請重新登入', 401, 'admin_session_expired');
    }
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode64(match[1])));
  } catch { fail('管理者登入驗證失敗，請重新登入', 401, 'admin_session_expired'); }
  if (!object(payload)) fail('管理者登入驗證失敗，請重新登入', 401, 'admin_session_expired');
  if (payload.admin !== true || payload.store !== 0) fail('此頁僅限管理者使用，門市登入不能管理外送紀錄', 403, 'admin_required');
  if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= now) {
    fail('管理者登入已逾時，請重新登入', 401, 'admin_session_expired');
  }
  if (typeof payload.version !== 'number' || !Number.isSafeInteger(payload.version) || payload.version < 1) {
    fail('管理者登入已失效，請重新登入', 401, 'admin_session_expired');
  }
  let result: Result<{ session_version: number }>;
  try { result = await dependencies.adminSessionVersion(); }
  catch { fail('暫時無法確認管理者登入，請稍後再試', 503); }
  if (result.error || !result.data || !Number.isInteger(result.data.session_version) || result.data.session_version < 1) {
    fail('暫時無法確認管理者登入，請稍後再試', 503);
  }
  if (payload.version !== result.data.session_version) fail('管理者密碼已更新，請使用新密碼重新登入', 401, 'admin_session_expired');
  return payload.version;
}

// Shared validation conventions match delivery-api without changing its
// employee-only authorization or exposing administrator mutations there.
async function boundedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > limit) fail('資料或照片過大，照片請使用 8MB 以內的檔案', 413);
  const reader = request.body?.getReader();
  if (!reader) fail('缺少外送資料');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); fail('資料或照片過大，照片請使用 8MB 以內的檔案', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function readBody(request: Request): Promise<{ body: Record<string, unknown>; photo: File | null }> {
  const type = request.headers.get('content-type') || '';
  let payload: string;
  let photo: File | null = null;
  if (/^multipart\/form-data(?:\s*;|$)/i.test(type)) {
    const bytes = await boundedBytes(request, MAX_PHOTO_BYTES + MAX_JSON_BYTES);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { 'Content-Type': type } }).formData(); }
    catch { fail('照片上傳格式錯誤，請重新選取照片'); }
    if ([...form.keys()].some(key => key !== 'payload' && key !== 'photo') || form.getAll('payload').length !== 1 || form.getAll('photo').length > 1) fail('上傳欄位格式錯誤');
    const raw = form.get('payload');
    if (typeof raw !== 'string' || encoder.encode(raw).length > MAX_JSON_BYTES) fail('外送資料格式錯誤');
    payload = raw;
    const file = form.get('photo');
    if (file !== null) {
      if (!(file instanceof File)) fail('請選擇有效的單據照片');
      photo = file;
    }
  } else if (/^application\/json(?:\s*;|$)/i.test(type)) {
    const bytes = await boundedBytes(request, MAX_JSON_BYTES);
    try { payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('外送資料文字格式錯誤'); }
  } else fail('請使用 JSON 或照片表單送出資料', 415);
  let body: unknown;
  try { body = JSON.parse(payload); } catch { fail('外送資料格式錯誤，請重新整理後再試'); }
  if (!object(body)) fail('外送資料格式錯誤');
  if (photo && body.action !== 'save' && body.action !== 'attach_photo') fail('此操作不能上傳照片');
  return { body, photo };
}
function onlyKeys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('外送資料包含不支援的欄位');
}
function storeId(value: unknown, all = false): number | null {
  if (all && (value === null || value === undefined)) return null;
  if (value !== 1 && value !== 2) fail('請選擇潮州店或木崎', 400, 'store_invalid');
  return value;
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label}無效，請重新載入`);
  return value.toLowerCase();
}
function version(value: unknown, allowZero: boolean): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value >= 2147483647) fail('紀錄版本無效，請重新載入');
  return value;
}
function textField(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || value.includes('\u0000')) fail(`${label}請填 1 至 ${max} 個字`);
  return value.trim();
}
function decimal(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) fail(`${label}請填 0 至 ${max}，最多兩位小數`);
  return Math.round(value * 100) / 100;
}
function deliveredAt(value: unknown): string {
  if (typeof value !== 'string') fail('請填寫有效的外送日期與時間');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  const parsed = new Date(value);
  if (!match || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`
    || parsed.getTime() < Date.parse('1899-12-31T16:00:00Z') || parsed.getTime() >= Date.parse('9999-12-31T16:00:00Z')) fail('請填寫有效的外送日期與時間');
  return parsed.toISOString();
}
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join('');
}
async function readPhoto(photo: File): Promise<{ bytes: Uint8Array; mime: string; ext: string; hash: string }> {
  if (photo.size === 0) fail('照片檔案是空的，請重新選取');
  if (photo.size > MAX_PHOTO_BYTES) fail('照片請使用 8MB 以內的檔案', 413);
  const bytes = new Uint8Array(await photo.arrayBuffer());
  let mime = '', ext = '';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { mime = 'image/jpeg'; ext = 'jpg'; }
  else if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) { mime = 'image/png'; ext = 'png'; }
  else if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') { mime = 'image/webp'; ext = 'webp'; }
  if (!mime || photo.type !== mime) fail('單據照片僅接受 JPG、PNG 或 WebP，請重新拍照或選取圖片', 415);
  return { bytes, mime, ext, hash: await digest(bytes) };
}
function ownedPhotoPath(value: unknown, store: number, id: string, content?: { hash: string; ext: string }): value is string {
  if (typeof value !== 'string' || !value.startsWith(`${store}/${id}/`)) return false;
  const file = value.split('/');
  if (file.length !== 3) return false;
  const name = /^([0-9a-f-]{36})-([0-9a-f]{64})\.(jpg|png|webp)$/.exec(file[2]);
  return !!name && UUID.test(name[1]) && (!content || name[2] === content.hash && name[3] === content.ext);
}
function databaseFailure(error: DatabaseError): never {
  if (error.code === '42501') fail('管理者授權已失效，請重新登入後再試', 401, 'admin_session_expired');
  if (error.code === '40001' || error.code === '23505' || error.code === '55000') fail('這筆紀錄已變更或已刪除，請重新載入後核對，避免覆蓋其他修改', 409, 'record_conflict');
  if (error.code === 'P0002') fail('找不到這筆外送紀錄，可能已刪除，請重新載入', 404, 'record_not_found');
  if (error.code === '22023' || error.code === '23514' || error.code === '23502' || error.code === '23503') fail('外送資料不完整或格式有誤，請檢查門市與各欄位', 400, 'record_invalid');
  if (error.code === '54000') fail('所選月份的紀錄過多，請先選擇單一門市後再查詢或匯出', 413, 'too_many_records');
  fail('雲端回應暫時中斷。若剛送出操作，請保留原內容並重試確認，系統會避免重複執行。', 503);
}
function attachmentFailure(error: DatabaseError): never {
  if (error.code === '55000') fail('此紀錄已有單據照片，不能再次補傳，請重新載入查看', 403, 'photo_locked');
  databaseFailure(error);
}
function publicRecord(value: unknown, store: number): AdminRecord {
  if (!object(value) || typeof value.id !== 'string' || !UUID.test(value.id)
    || value.store_id !== undefined && value.store_id !== store
    || typeof value.unit_name !== 'string' || typeof value.address !== 'string' || typeof value.courier !== 'string'
    || typeof value.delivered_at !== 'string' || !Number.isFinite(Date.parse(value.delivered_at))
    || typeof value.amount !== 'number' || !Number.isFinite(value.amount)
    || typeof value.distance_km !== 'number' || !Number.isFinite(value.distance_km)
    || value.vehicle_type !== null && value.vehicle_type !== 'personal' && value.vehicle_type !== 'store'
    || typeof value.has_photo !== 'boolean' || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1
    || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))) {
    fail('尚未收到完整的外送紀錄確認，請保留原內容並重試', 503);
  }
  return { id: value.id, store_id: store, unit_name: value.unit_name, address: value.address, courier: value.courier,
    delivered_at: value.delivered_at, amount: value.amount, distance_km: value.distance_km,
    vehicle_type: value.vehicle_type, has_photo: value.has_photo, version: value.version, updated_at: value.updated_at,
    ...(typeof value.created_at === 'string' ? { created_at: value.created_at } : {}) };
}

export function createHandler(dependencies: Dependencies) {
  const now = dependencies.now || Date.now;
  const distance = dependencies.distance || createDistanceService();
  const headers = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Expose-Headers': 'Retry-After',
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin',
  };
  async function cleanup(path: string) {
    try { await dependencies.removePhotos([path]); } catch { /* Do not misreport a committed result. */ }
  }
  return async (request: Request): Promise<Response> => {
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== ORIGIN) fail('此來源無法使用外送管理', 403, 'origin_forbidden');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'POST') return Response.json({ error: '僅接受 POST' }, { status: 405, headers: { ...headers, Allow: 'POST, OPTIONS' } });
      const adminVersion = await authenticate(request, dependencies, now());
      const { body, photo } = await readBody(request);
      if (body.action === 'load') {
        onlyKeys(body, ['action', 'month', 'store_id']);
        const store = storeId(body.store_id, true);
        if (typeof body.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month) || body.month < '1900-01') fail('請選擇有效月份');
        const { data, error } = await dependencies.loadRecords(store, body.month);
        if (error) databaseFailure(error);
        if (!data || !Array.isArray(data.records) || !Number.isSafeInteger(data.total_count) || data.total_count < 0
          || data.records.length !== data.total_count || !Number.isFinite(data.total_amount) || !Number.isFinite(data.total_distance_km)) fail('清單尚未完整讀取，請重新查詢後再匯出', 503);
        if (data.total_count > MAX_ROWS) fail('所選月份的紀錄過多，請選擇單一門市後再查詢或匯出', 413, 'too_many_records');
        const records = data.records.map(row => {
          if (row.store_id !== 1 && row.store_id !== 2 || store !== null && row.store_id !== store) fail('清單門市資料不一致，請重新查詢', 503);
          return publicRecord(row, row.store_id);
        });
        return Response.json({ records, total_count: data.total_count, total_amount: data.total_amount, total_distance_km: data.total_distance_km,
          month: body.month, store_id: store, stores: STORES, distance_services: { '1': distance.info(1), '2': distance.info(2) } }, { headers });
      }
      if (body.action === 'save') {
        onlyKeys(body, ['action', 'store_id', 'id', 'request_id', 'expected_version', 'unit_name', 'address', 'courier', 'delivered_at', 'amount', 'distance_km', 'vehicle_type']);
        const store = storeId(body.store_id)!;
        const id = uuid(body.id, '紀錄識別碼'), requestId = uuid(body.request_id, '儲存識別碼');
        const expectedVersion = version(body.expected_version, true);
        if (expectedVersion > 0 && photo) fail('編輯資料時保留原單據，不能同時更換照片', 400, 'photo_edit_not_allowed');
        if (body.vehicle_type !== 'personal' && body.vehicle_type !== 'store' && !(expectedVersion > 0 && body.vehicle_type === null)) fail('請選擇自用車或店用車', 400, 'vehicle_type_required');
        const record: SaveArguments['p_record'] = {
          unit_name: textField(body.unit_name, '外送單位名稱', 100), address: textField(body.address, '地址', 300),
          courier: textField(body.courier, '外送人員', 60), delivered_at: deliveredAt(body.delivered_at),
          amount: decimal(body.amount, '金額', 99999999.99), distance_km: decimal(body.distance_km, '距離', 99999.99), vehicle_type: body.vehicle_type,
        };
        if (record.address.replace(/\s/g, '') === '屏東縣') fail('請在屏東縣後填寫完整外送地址');
        const image = photo ? await readPhoto(photo) : null;
        const fingerprint = await digest(encoder.encode(JSON.stringify({ action: 'save', store_id: store, id, expected_version: expectedVersion, record, photoHash: image?.hash || null })));
        const path = image ? `${store}/${id}/${crypto.randomUUID()}-${image.hash}.${image.ext}` : null;
        if (path && image) {
          const uploaded = await dependencies.uploadPhoto(path, image.bytes, image.mime);
          if (uploaded.error) fail('照片上傳未完成，請保留內容並重試', 503);
        }
        let result: Result<SaveResult>;
        try { result = await dependencies.saveRecord({ p_store_id: store, p_id: id, p_request_id: requestId, p_expected_version: expectedVersion,
          p_record: record, p_photo_path: path, p_request_fingerprint: fingerprint, p_admin_session_version: adminVersion }); }
        catch { fail('儲存結果尚無法確認，請保留原內容並重試，系統會避免重複執行', 503); }
        if (result.error) {
          if (path && REJECTED_TRANSACTION_CODES.has(result.error.code || '')) await cleanup(path);
          databaseFailure(result.error);
        }
        if (!result.data || result.data.record?.id !== id || result.data.record?.version <= expectedVersion
          || image && (!ownedPhotoPath(result.data.photo_path, store, id, image) || !result.data.record?.has_photo)) fail('尚未收到完整儲存確認，請保留原內容並重試', 503);
        const saved = publicRecord(result.data.record, store);
        if (path && path !== result.data.photo_path) await cleanup(path);
        return Response.json({ record: saved }, { headers });
      }
      if (body.action === 'delete') {
        onlyKeys(body, ['action', 'store_id', 'id', 'request_id', 'expected_version']);
        const store = storeId(body.store_id)!, id = uuid(body.id, '紀錄識別碼'), requestId = uuid(body.request_id, '刪除識別碼');
        const expectedVersion = version(body.expected_version, false);
        const fingerprint = await digest(encoder.encode(JSON.stringify({ action: 'delete', store_id: store, id, expected_version: expectedVersion })));
        let result: Result<DeleteResult>;
        try { result = await dependencies.deleteRecord({ p_store_id: store, p_id: id, p_request_id: requestId, p_expected_version: expectedVersion,
          p_request_fingerprint: fingerprint, p_admin_session_version: adminVersion }); }
        catch { fail('刪除結果尚無法確認，請使用同一筆操作重試確認', 503); }
        if (result.error) databaseFailure(result.error);
        if (!result.data || result.data.deleted !== true || result.data.id !== id || result.data.store_id !== store
          || !Number.isSafeInteger(result.data.version) || result.data.version <= expectedVersion) fail('尚未收到完整刪除確認，請使用同一筆操作重試確認', 503);
        // Soft deletion intentionally keeps private receipts and the audit log.
        return Response.json({ deleted: true, id, store_id: store, version: result.data.version }, { headers });
      }
      if (body.action === 'attach_photo') {
        onlyKeys(body, ['action', 'store_id', 'id', 'request_id', 'expected_version']);
        const store = storeId(body.store_id)!, id = uuid(body.id, '紀錄識別碼'), requestId = uuid(body.request_id, '補傳識別碼');
        const expectedVersion = version(body.expected_version, false);
        if (!photo) fail('請先拍照或選取要補傳的單據照片');
        const image = await readPhoto(photo);
        const args: AttachPhotoArguments = { p_store_id: store, p_id: id, p_request_id: requestId, p_expected_version: expectedVersion,
          p_photo_hash: image.hash, p_photo_path: null };
        let preflight: Result<AttachPhotoResult>;
        try { preflight = await dependencies.attachRecordPhoto(args); }
        catch { fail('補傳結果尚無法確認，請保留這張照片並重試', 503); }
        if (preflight.error) attachmentFailure(preflight.error);
        if (!preflight.data) fail('尚未收到補傳狀態，請保留這張照片並重試', 503);
        if (preflight.data.ready_for_upload === false) {
          if (!ownedPhotoPath(preflight.data.photo_path, store, id, image) || !preflight.data.record?.has_photo || preflight.data.record.id !== id || preflight.data.record.version <= expectedVersion) fail('尚未收到補傳確認，請保留照片並重試', 503);
          return Response.json({ record: publicRecord(preflight.data.record, store) }, { headers });
        }
        if (preflight.data.ready_for_upload !== true || preflight.data.photo_path || preflight.data.record?.has_photo || preflight.data.record?.id !== id) fail('尚未確認這筆紀錄可補傳，請保留照片並重試', 503);
        const path = `${store}/${id}/${crypto.randomUUID()}-${image.hash}.${image.ext}`;
        const uploaded = await dependencies.uploadPhoto(path, image.bytes, image.mime);
        if (uploaded.error) fail('照片補傳未完成，請保留這張照片並重試', 503);
        let result: Result<AttachPhotoResult>;
        try { result = await dependencies.attachRecordPhoto({ ...args, p_photo_path: path }); }
        catch { fail('補傳結果尚無法確認，請保留這張照片並重試', 503); }
        if (result.error) {
          if (REJECTED_TRANSACTION_CODES.has(result.error.code || '')) await cleanup(path);
          attachmentFailure(result.error);
        }
        if (!result.data || result.data.ready_for_upload !== false || !ownedPhotoPath(result.data.photo_path, store, id, image) || !result.data.record?.has_photo
          || result.data.record.id !== id || result.data.record.version <= expectedVersion) fail('尚未收到完整補傳確認，請保留這張照片並重試', 503);
        const saved = publicRecord(result.data.record, store);
        if (path !== result.data.photo_path) await cleanup(path);
        return Response.json({ record: saved }, { headers });
      }
      if (body.action === 'photo') {
        onlyKeys(body, ['action', 'store_id', 'id']);
        const store = storeId(body.store_id)!, id = uuid(body.id, '紀錄識別碼');
        const { data, error } = await dependencies.photoPath(store, id);
        if (error) databaseFailure(error);
        if (!data?.photo_path) fail('這筆紀錄沒有可查看的單據照片', 404);
        if (!ownedPhotoPath(data.photo_path, store, id)) fail('單據照片連結暫時無法確認，請重新查詢', 503);
        const signed = await dependencies.signPhoto(data.photo_path, 300);
        if (signed.error) databaseFailure(signed.error);
        if (!signed.data?.signedUrl) fail('照片暫時無法讀取，請稍後再試', 503);
        return Response.json({ url: signed.data.signedUrl }, { headers });
      }
      if (body.action === 'distance') {
        onlyKeys(body, ['action', 'store_id', 'address']);
        const store = storeId(body.store_id)!;
        if (typeof body.address !== 'string' || !body.address.trim() || [...body.address.trim()].length > 300 || /[\u0000-\u001f\u007f]/.test(body.address)) fail('請填寫完整的臺灣外送地址（最多 300 個字）', 422, 'distance_address_invalid');
        const sessionKey = await digest(encoder.encode(request.headers.get('authorization')!));
        try { return Response.json(await distance.calculate(store, body.address.trim(), sessionKey), { headers }); }
        catch (error) { if (error instanceof DistanceError) throw error; fail('暫時無法計算機車距離，請稍後重試或手動填寫公里數', 503, 'distance_unavailable'); }
      }
      fail('不支援的外送管理操作');
    } catch (error) {
      if (error instanceof DistanceError) return Response.json({ error: error.message, code: error.code }, { status: error.status,
        headers: { ...headers, ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) } });
      if (error instanceof RequestError) return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status, headers });
      return Response.json({ error: '連線暫時異常，請稍後再試；若剛送出操作，請保留原內容並重試確認' }, { status: 503, headers });
    }
  };
}
