// This endpoint shares the existing receipt login, but permits only 木崎(C2).
// The data access callbacks are supplied by the service-role adapter in index.ts.
const ORIGIN = 'https://s3235889-pixel.github.io';
const STORE_ID = 2;
const MAX_BODY_BYTES = 32 * 1024;
const MEAT_NAMES = { beef: '牛五花', pork: '豚梅花', chicken: '雞胸肉' } as const;
const MEAT_IDS = Object.keys(MEAT_NAMES) as Array<keyof typeof MEAT_NAMES>;
const FIELDS = ['closing', 'thaw', 'extra', 'waste', 'target'];
const encoder = new TextEncoder();

export type MeatCounts = {
  closing: number;
  thaw: number;
  extra: number;
  waste: number;
  target: number | null;
};
export type Meats = Record<keyof typeof MEAT_NAMES, MeatCounts>;
export type MeatDay = {
  business_date: string;
  meats: Meats;
  note: string;
  version: number;
  updated_at: string;
};
type DatabaseError = { code?: string; message?: string };
type Result<T> = { data: T | null; error: DatabaseError | null };
type SaveArguments = {
  p_store_id: number;
  p_date: string;
  p_meats: Meats;
  p_note: string;
  p_expected_version: number;
  p_request_id: string;
};
export type Dependencies = {
  key: CryptoKey;
  loadDays: (store: number, start: string, end: string) => Promise<Result<MeatDay[]>>;
  saveDay: (args: SaveArguments) => Promise<Result<MeatDay>>;
  now?: () => number;
};

class RequestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
function fail(message: string, status = 400): never {
  throw new RequestError(message, status);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function taipeiDate(timestamp: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function businessDate(value: unknown, today: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > today) {
    fail('請選擇今天或以前的有效盤點日期');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('請選擇今天或以前的有效盤點日期');
  }
  return value;
}
function monthRange(date: string, today: string) {
  const first = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(first);
  end.setUTCMonth(end.getUTCMonth() + 1);
  first.setUTCDate(first.getUTCDate() - 7);
  // The seven extra days include the baseline for the month's first forecast.
  return {
    start: first.toISOString().slice(0, 10),
    end: [end.toISOString().slice(0, 10), today].sort()[0],
  };
}
function base64url(value: string): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) fail('請重新使用木崎門市登入', 401);
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}
async function authenticate(request: Request, key: CryptoKey, now: number): Promise<void> {
  const authorization = request.headers.get('authorization') || '';
  const match = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!match || authorization.length > 4096) fail('請先使用木崎門市登入', 401);
  let payload: unknown;
  try {
    const signature = base64url(match[2]);
    if (signature.length !== 32 || !await crypto.subtle.verify('HMAC', key, signature, encoder.encode(match[1]))) {
      fail('登入驗證失敗，請重新登入', 401);
    }
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64url(match[1])));
  } catch {
    fail('登入驗證失敗，請重新登入', 401);
  }
  if (!object(payload) || typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp) || payload.exp <= now) {
    fail('登入已逾時，請重新使用木崎門市登入', 401);
  }
  // Neither an administrator token nor another store's valid token grants access.
  if (payload.store !== STORE_ID || payload.admin !== false) {
    fail('肉品庫存僅限木崎門市登入使用', 403);
  }
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    fail('請使用 JSON 格式送出盤點資料', 415);
  }
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_BODY_BYTES) fail('盤點資料過大，請縮短備註後再試', 413);
  const reader = request.body?.getReader();
  if (!reader) fail('缺少盤點資料');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        fail('盤點資料過大，請縮短備註後再試', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('盤點資料格式錯誤，請重新整理後再試'); }
  if (!object(body)) fail('盤點資料格式錯誤');
  if (Object.hasOwn(body, 'store_id')) fail('門市由登入狀態決定，請勿指定其他門市');
  return body;
}
function portions(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000 || Math.abs(value * 10 - Math.round(value * 10)) > 0.000001) {
    fail(`${label}請填 0 至 10000 份，最多一位小數`);
  }
  return Math.round(value * 10) / 10;
}
function validateMeats(value: unknown): Meats {
  if (!object(value) || Object.keys(value).length !== MEAT_IDS.length || !MEAT_IDS.every(id => Object.hasOwn(value, id))) {
    fail('請完整填寫牛五花、豚梅花、雞胸肉的盤點資料');
  }
  const result = {} as Meats;
  for (const id of MEAT_IDS) {
    const counts = value[id];
    const name = MEAT_NAMES[id];
    if (!object(counts) || Object.keys(counts).some(field => !FIELDS.includes(field))) fail(`${name}盤點資料格式錯誤`);
    result[id] = {
      closing: portions(counts.closing, `${name}冷藏剩餘`),
      thaw: portions(counts.thaw, `${name}今晚退冰`),
      extra: portions(counts.extra === undefined ? 0 : counts.extra, `${name}今日追加退冰`),
      waste: portions(counts.waste === undefined ? 0 : counts.waste, `${name}今日耗損`),
      target: counts.target === undefined || counts.target === null ? null : portions(counts.target, `${name}明日需求`),
    };
  }
  return result;
}
function databaseFailure(error: DatabaseError): never {
  if (error.code === '40001' || error.code === '23505') {
    fail('這天的盤點已由其他裝置更新，請先重新載入並確認最新數字', 409);
  }
  if (error.code === '22023') {
    // This code is reserved by the save RPC for intentional validation messages.
    fail(error.message || '盤點數量有誤，請確認冷藏剩餘、追加退冰與耗損', 400);
  }
  fail('雲端資料暫時無法存取，請稍後再試', 500);
}

export function createHandler(dependencies: Dependencies) {
  const now = dependencies.now || Date.now;
  const headers = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
  return async (request: Request): Promise<Response> => {
    try {
      const origin = request.headers.get('origin');
      if (origin && origin !== ORIGIN) fail('此來源無法使用肉品庫存', 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (request.method !== 'POST') return Response.json({ error: '僅接受 POST' }, { status: 405, headers: { ...headers, Allow: 'POST, OPTIONS' } });
      const timestamp = now();
      await authenticate(request, dependencies.key, timestamp);
      const body = await readBody(request);
      const today = taipeiDate(timestamp);
      const date = businessDate(body.date, today);
      if (body.action === 'load') {
        const { start, end } = monthRange(date, today);
        const { data, error } = await dependencies.loadDays(STORE_ID, start, end);
        if (error) databaseFailure(error);
        return Response.json({ today, store_id: STORE_ID, store_name: '木崎(C2)', records: data || [], start, end }, { headers });
      }
      if (body.action === 'save') {
        const meats = validateMeats(body.meats);
        const note = body.note === undefined ? '' : body.note;
        if (typeof note !== 'string' || note.length > 500) fail('備註最多 500 個字');
        if (typeof body.expected_version !== 'number' || !Number.isInteger(body.expected_version) || body.expected_version < 0 || body.expected_version >= 2147483647) {
          fail('盤點版本無效，請重新載入');
        }
        if (typeof body.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id)) {
          fail('儲存識別碼無效，請重新載入');
        }
        const { data, error } = await dependencies.saveDay({
          p_store_id: STORE_ID, p_date: date, p_meats: meats, p_note: note.trim(),
          p_expected_version: body.expected_version, p_request_id: body.request_id,
        });
        if (error) databaseFailure(error);
        if (!data) fail('尚未收到儲存確認，請重新載入確認資料', 500);
        return Response.json({ record: data }, { headers });
      }
      fail('不支援的盤點操作');
    } catch (error) {
      if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status, headers });
      // Do not expose database details, authorization headers, or token payloads.
      return Response.json({ error: '連線暫時異常，請稍後再試；剛送出儲存時請先重新載入確認' }, { status: 500, headers });
    }
  };
}
