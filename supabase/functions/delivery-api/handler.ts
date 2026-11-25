// Shared receipt login; only authenticated 潮州店(C1) and 木崎(C2) may use this API.
// No browser-provided store identifier, object path, or service key is trusted.
import { createDistanceService, DistanceError } from './distance.ts';
import type { DistanceService } from './distance.ts';
const ORIGIN = 'https://s3235889-pixel.github.io';
const STORES: Record<number, string> = { 1: '潮州店(C1)', 2: '木崎(C2)' };
const PAGE_SIZE = 50;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only known statement/transaction rejections prove an upload is unused.
// In particular, 08007 and 40003 describe unknown completion, not rollback.
const REJECTED_TRANSACTION_CODES = new Set(['22023', '23502', '23503', '23505', '23514', '40001', '42501', '55000', 'P0002']);
const encoder = new TextEncoder();

export type VehicleType = 'personal' | 'store';
export type DeliveryRecord = {
  id: string; unit_name: string; address: string; courier: string;
  delivered_at: string; amount: number; distance_km: number; vehicle_type: VehicleType | null;
  has_photo: boolean; version: number; updated_at: string;
};
type DatabaseError = { code?: string; message?: string };
type Result<T> = { data: T | null; error: DatabaseError | null };
export type LoadResult = {
  records: DeliveryRecord[]; total_count: number; total_amount: number; total_distance_km: number;
};
export type SaveArguments = {
  p_store_id: number; p_id: string; p_request_id: string; p_expected_version: number;
  p_record: Pick<DeliveryRecord, 'unit_name' | 'address' | 'courier' | 'delivered_at' | 'amount' | 'distance_km'> & { vehicle_type?: VehicleType };
  p_photo_path: string | null; p_remove_photo: boolean; p_request_fingerprint: string;
};
export type SaveResult = { record: DeliveryRecord; photo_path: string | null; unused_photo_paths: string[] };
export type AttachPhotoArguments = {
  p_store_id: number; p_id: string; p_request_id: string; p_expected_version: number;
  p_photo_hash: string; p_photo_path: string | null;
};
export type AttachPhotoResult = { record: DeliveryRecord; photo_path: string | null; ready_for_upload: boolean };
export type Dependencies = {
  key: CryptoKey;
  loadRecords: (store: number, month: string, page: number) => Promise<Result<LoadResult>>;
  saveRecord: (args: SaveArguments) => Promise<Result<SaveResult>>;
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
function recordLocked(): never { fail('外送紀錄上傳後僅供查詢，不可編輯或刪除', 403, 'record_locked'); }
function photoLocked(): never { fail('此紀錄已有單據照片，補傳後不能更換或移除，請重新載入查看。', 403, 'photo_locked'); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function decode64(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}
async function authenticate(request: Request, key: CryptoKey, now: number): Promise<number> {
  const authorization = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!match || authorization.length > 4096) fail('請先使用潮州店或木崎門市登入', 401);
  let payload: unknown;
  try {
    const signature = decode64(match[2]);
    if (signature.length !== 32 || !await crypto.subtle.verify('HMAC', key, signature, encoder.encode(match[1]))) {
      fail('登入驗證失敗，請重新登入', 401);
    }
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode64(match[1])));
  } catch { fail('登入驗證失敗，請重新登入', 401); }
  if (!object(payload) || typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= now) {
    fail('登入已逾時，請重新登入', 401);
  }
  if ((payload.store !== 1 && payload.store !== 2) || payload.admin !== false) {
    fail('外送記錄僅限潮州店與木崎使用', 403);
  }
  return payload.store;
}
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
    if ([...form.keys()].some(key => key !== 'payload' && key !== 'photo') || form.getAll('payload').length !== 1 || form.getAll('photo').length > 1) {
      fail('上傳欄位格式錯誤');
    }
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
  } else { fail('請使用 JSON 或照片表單送出資料', 415); }
  let body: unknown;
  try { body = JSON.parse(payload); } catch { fail('外送資料格式錯誤，請重新整理後再試'); }
  if (!object(body)) fail('外送資料格式錯誤');
  if (Object.hasOwn(body, 'store_id')) fail('門市由登入狀態決定，請勿指定其他門市');
  if (photo && body.action !== 'save' && body.action !== 'attach_photo') fail('此操作不能上傳照片');
  return { body, photo };
}
function onlyKeys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('外送資料包含不支援的欄位');
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${label}無效，請重新載入`);
  return value.toLowerCase();
}
function version(value: unknown, allowZero: boolean): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value >= 2147483647) {
    fail('紀錄版本無效，請重新載入');
  }
  return value;
}
function textField(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || value.includes('\u0000')) {
    fail(`${label}請填 1 至 ${max} 個字`);
  }
  return value.trim();
}
function decimal(value: unknown, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) {
    fail(`${label}請填 0 至 ${max}，最多兩位小數`);
  }
  return Math.round(value * 100) / 100;
}
function deliveredAt(value: unknown): string {
  if (typeof value !== 'string') fail('請填寫有效的外送日期與時間');
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  const parsed = new Date(value);
  if (!match || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z` ||
      parsed.getTime() < Date.parse('1899-12-31T16:00:00Z') || parsed.getTime() >= Date.parse('9999-12-31T16:00:00Z')) {
    fail('請填寫有效的外送日期與時間');
  }
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
function databaseFailure(error: DatabaseError): never {
  if (error.code === '55000') recordLocked();
  if (error.code === '40001' || error.code === '23505') fail('這筆紀錄的狀態已變更或已刪除，請重新載入確認', 409);
  if (error.code === 'P0002') fail('找不到這筆外送紀錄，請重新載入', 404);
  if (error.code === '42501') fail('沒有權限操作這筆外送紀錄', 403);
  if (error.code === '22023' || error.code === '23514') fail('外送資料不完整或格式有誤，請檢查後再儲存', 400);
  fail('雲端回應暫時中斷。若剛送出儲存，請保留內容並再次儲存確認，系統會避免重複記錄。', 503);
}
function attachmentFailure(error: DatabaseError): never {
  if (error.code === '55000') photoLocked();
  databaseFailure(error);
}

export function createHandler(dependencies: Dependencies) {
  const now = dependencies.now || Date.now;
  const distance = dependencies.distance || createDistanceService();
  const headers = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin',
  };
  async function cleanup(paths: string[]) {
    if (!paths.length) return;
    // A failed cleanup must not turn an already committed record into an apparent failure.
    // An uncertain database write is never cleaned up here: it could have committed.
    try { await dependencies.removePhotos([...new Set(paths)]); } catch { /* Preserve the successful record. */ }
  }
  return async (request: Request): Promise<Response> => {
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== ORIGIN) fail('此來源無法使用外送記錄', 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'POST') return Response.json({ error: '僅接受 POST' }, { status: 405, headers: { ...headers, Allow: 'POST, OPTIONS' } });
      const store = await authenticate(request, dependencies.key, now());
      const { body, photo } = await readBody(request);
      if (body.action === 'load') {
        onlyKeys(body, ['action', 'month', 'page']);
        if (typeof body.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month) || body.month < '1900-01') fail('請選擇有效月份');
        const page = body.page === undefined ? 0 : body.page;
        if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 0 || page > 100000) fail('頁碼無效');
        const { data, error } = await dependencies.loadRecords(store, body.month, page);
        if (error) databaseFailure(error);
        if (!data) fail('外送紀錄尚未讀取完成，請重試', 503);
        return Response.json({ ...data, store_id: store, store_name: STORES[store], month: body.month, page, page_size: PAGE_SIZE,
          has_more: (page + 1) * PAGE_SIZE < Number(data.total_count), distance_service: distance.info(store) }, { headers });
      }
      if (body.action === 'distance') {
        onlyKeys(body, ['action', 'address']);
        if (typeof body.address !== 'string' || !body.address.trim() || [...body.address.trim()].length > 300
          || /[\u0000-\u001f\u007f]/.test(body.address)) {
          fail('請填寫完整的臺灣外送地址（最多 300 個字）。', 422, 'distance_address_invalid');
        }
        // Only the verified token selects the store. Keep raw tokens out of the
        // provider's best-effort per-session limiter and all response objects.
        const sessionKey = await digest(encoder.encode(request.headers.get('authorization')!.slice(7)));
        try { return Response.json(await distance.calculate(store, body.address.trim(), sessionKey), { headers }); }
        catch (error) {
          if (error instanceof DistanceError) throw error;
          fail('暫時無法自動計算機車距離，請稍後重試，或手動輸入公里數。', 503, 'distance_unavailable');
        }
      }
      if (body.action === 'save') {
        onlyKeys(body, ['action', 'id', 'request_id', 'expected_version', 'unit_name', 'address', 'courier', 'delivered_at', 'amount', 'distance_km', 'vehicle_type', 'remove_photo']);
        const id = uuid(body.id, '紀錄識別碼'), requestId = uuid(body.request_id, '儲存識別碼');
        const expectedVersion = version(body.expected_version, true);
        if (body.remove_photo !== undefined && typeof body.remove_photo !== 'boolean') fail('照片移除選項無效');
        const removePhoto = body.remove_photo === true;
        // Cached pages may still submit edits. Reject them before reading or uploading a photo.
        // Version zero is a new record or an exact retry; the database decides which.
        if (expectedVersion > 0 || removePhoto) recordLocked();
        const record: SaveArguments['p_record'] = {
          unit_name: textField(body.unit_name, '外送單位名稱', 100), address: textField(body.address, '地址', 300),
          courier: textField(body.courier, '外送人員', 60), delivered_at: deliveredAt(body.delivered_at),
          amount: decimal(body.amount, '金額', 99999999.99), distance_km: decimal(body.distance_km, '距離', 99999.99),
        };
        if (record.address.replace(/\s/g, '') === '屏東縣') fail('請在屏東縣後填寫完整外送地址');
        // Preserve the exact old JSON shape/order for a cached page retry.
        // The database rejects a missing choice only after checking an existing
        // record's exact retry, so legacy uploads can still confirm completion.
        if (Object.hasOwn(body, 'vehicle_type')) {
          if (body.vehicle_type !== 'personal' && body.vehicle_type !== 'store') fail('請選擇自用車或店用車', 400, 'vehicle_type_required');
          record.vehicle_type = body.vehicle_type;
        }
        const image = photo ? await readPhoto(photo) : null;
        const fingerprint = await digest(encoder.encode(JSON.stringify({ record, expectedVersion, removePhoto, photoHash: image?.hash || null })));
        // Unique per attempt, not per request_id, so concurrent retries cannot delete each other's upload.
        const path = image ? `${store}/${id}/${crypto.randomUUID()}-${image.hash}.${image.ext}` : null;
        if (image && path) {
          const upload = await dependencies.uploadPhoto(path, image.bytes, image.mime);
          if (upload.error) fail('照片上傳未完成，內容已保留，請重新儲存', 503);
        }
        let result: Result<SaveResult>;
        try {
          result = await dependencies.saveRecord({ p_store_id: store, p_id: id, p_request_id: requestId, p_expected_version: expectedVersion,
            p_record: record, p_photo_path: path, p_remove_photo: removePhoto, p_request_fingerprint: fingerprint });
        } catch {
          // The response may have been lost after COMMIT. Never remove the uploaded path here.
          fail('儲存結果尚無法確認，內容已保留。請再次儲存確認，系統會避免重複記錄。', 503);
        }
        if (result.error) {
          // An arbitrary SQLSTATE can describe unknown completion. Preserve the
          // object unless a known rejection proves the write did not commit.
          if (path && REJECTED_TRANSACTION_CODES.has(result.error.code || '')) await cleanup([path]);
          if (result.error.code === '22023' && !Object.hasOwn(record, 'vehicle_type')) {
            fail('請先記下目前尚未儲存的資料，重新整理頁面後選擇「自用車」或「店用車」再儲存。', 400, 'vehicle_type_required');
          }
          databaseFailure(result.error);
        }
        if (!result.data) fail('尚未收到儲存確認，請保留內容並再次儲存確認', 503);
        // Never remove an earlier committed photo. Only this attempt's unused
        // object can be cleaned up after an exact retry has been confirmed.
        if (path && path !== result.data.photo_path) await cleanup([path]);
        return Response.json({ record: result.data.record }, { headers });
      }
      if (body.action === 'attach_photo') {
        onlyKeys(body, ['action', 'id', 'request_id', 'expected_version']);
        const id = uuid(body.id, '紀錄識別碼'), requestId = uuid(body.request_id, '補傳識別碼');
        const expectedVersion = version(body.expected_version, false);
        if (!photo) fail('請先拍照或選取要補傳的單據照片');
        const image = await readPhoto(photo);
        const args: AttachPhotoArguments = { p_store_id: store, p_id: id, p_request_id: requestId,
          p_expected_version: expectedVersion, p_photo_hash: image.hash, p_photo_path: null };
        // Read-only preflight accepts a committed exact retry before applying
        // the one-photo lock. It never reserves a row or changes original data.
        let preflight: Result<AttachPhotoResult>;
        try { preflight = await dependencies.attachRecordPhoto(args); }
        catch { fail('補傳結果尚無法確認，請保留這張照片並再次送出確認。', 503); }
        if (preflight.error) attachmentFailure(preflight.error);
        if (!preflight.data) fail('尚未收到補傳狀態，請保留這張照片並再次送出確認。', 503);
        if (preflight.data.ready_for_upload === false) {
          if (!preflight.data.photo_path || !preflight.data.record?.has_photo) fail('尚未收到補傳確認，請保留照片並重試。', 503);
          return Response.json({ record: preflight.data.record }, { headers });
        }
        if (preflight.data.ready_for_upload !== true || preflight.data.photo_path || preflight.data.record?.has_photo) {
          fail('尚未確認這筆紀錄可補傳單據，請保留照片並重試。', 503);
        }
        const path = `${store}/${id}/${crypto.randomUUID()}-${image.hash}.${image.ext}`;
        const upload = await dependencies.uploadPhoto(path, image.bytes, image.mime);
        if (upload.error) fail('單據照片上傳未完成，請保留這張照片並再次送出。', 503);
        let result: Result<AttachPhotoResult>;
        try { result = await dependencies.attachRecordPhoto({ ...args, p_photo_path: path }); }
        catch {
          // COMMIT may have succeeded; removing this object could break the
          // saved receipt. The same request/hash can confirm it on retry.
          fail('補傳結果尚無法確認，請保留這張照片並再次送出確認。', 503);
        }
        if (result.error) {
          if (REJECTED_TRANSACTION_CODES.has(result.error.code || '')) await cleanup([path]);
          attachmentFailure(result.error);
        }
        if (!result.data || result.data.ready_for_upload !== false || !result.data.photo_path || !result.data.record?.has_photo) {
          fail('尚未收到補傳確認，請保留這張照片並再次送出確認。', 503);
        }
        // Another concurrent exact retry can have committed its own object.
        // Never trust a cleanup list or remove any earlier committed object.
        if (path !== result.data.photo_path) await cleanup([path]);
        return Response.json({ record: result.data.record }, { headers });
      }
      if (body.action === 'delete') {
        onlyKeys(body, ['action', 'id', 'expected_version']);
        uuid(body.id, '紀錄識別碼');
        version(body.expected_version, false);
        // Cached clients can still send delete. Do not invoke any database or
        // storage operation: uploaded records and their photos are read-only.
        recordLocked();
      }
      if (body.action === 'photo') {
        onlyKeys(body, ['action', 'id']);
        const { data, error } = await dependencies.photoPath(store, uuid(body.id, '紀錄識別碼'));
        if (error) databaseFailure(error);
        if (!data?.photo_path) fail('這筆紀錄沒有可查看的單據照片', 404);
        const signed = await dependencies.signPhoto(data.photo_path, 300);
        if (signed.error) databaseFailure(signed.error);
        if (!signed.data?.signedUrl) fail('照片暫時無法讀取，請稍後再試', 503);
        return Response.json({ url: signed.data.signedUrl }, { headers });
      }
      fail('不支援的外送記錄操作');
    } catch (error) {
      if (error instanceof DistanceError) return Response.json({ error: error.message, code: error.code }, {
        status: error.status, headers: { ...headers, ...(error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) },
      });
      if (error instanceof RequestError) return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status, headers });
      return Response.json({ error: '連線暫時異常，請稍後再試；若剛送出儲存，請保留內容並重試確認。' }, { status: 503, headers });
    }
  };
}
