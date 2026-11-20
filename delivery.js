import { ALLOWED_STORES, taipeiDateTime, isValidMonth, validateFields, isAllowedSession } from './delivery-core.mjs?v=20261120';

const API = 'https://rjetwgrelmvciatouwiw.supabase.co/functions/v1/delivery-api';
const PHOTO_ORIGIN = 'https://rjetwgrelmvciatouwiw.supabase.co';
const $ = id => document.getElementById(id);
const fields = { unit_name: 'unit-name', address: 'address', courier: 'courier', delivered_at: 'delivered-at', amount: 'amount', distance_km: 'distance-km' };
const numberFormat = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
const format = value => Number.isFinite(Number(value)) ? numberFormat.format(Number(value)) : '—';
const state = {
  session: null, loaded: false, listReady: false, loading: false, mutating: false,
  records: [], month: taipeiDateTime().slice(0, 7), page: 0, totalCount: 0, hasMore: false,
  newId: crypto.randomUUID(), dirty: false, signature: '', conflict: false,
  pendingSave: null, photo: null, photoURL: '', photoBusy: false, photoError: '',
  photoVersion: 0, loadVersion: 0, viewerVersion: 0, viewerId: null,
};

class ApiError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.status = status; this.code = code; }
}

function readSession() {
  try { return JSON.parse(sessionStorage.getItem('receipt-session') || 'null'); }
  catch { return null; }
}

function sameSession() {
  const latest = readSession();
  return isAllowedSession(latest) && latest.token === state.session?.token
    && Number(latest.store_id) === Number(state.session?.store_id);
}

function setMessage(message, kind = '') {
  $('message').textContent = message;
  $('message').className = `message ${kind}`.trim();
  $('message').hidden = !message;
}

function setGate(message, { login = true, retry = false } = {}) {
  $('workspace').hidden = true;
  $('access-gate').hidden = false;
  $('access-message').textContent = message;
  $('access-login').hidden = !login;
  $('access-retry').hidden = !retry;
}

function clearErrors() {
  for (const id of Object.values(fields)) {
    $(id).removeAttribute('aria-invalid');
    $(`${id}-error`).hidden = true;
    $(`${id}-error`).textContent = '';
  }
}

function closeViewer() {
  state.viewerVersion++;
  state.viewerId = null;
  $('viewer-image').removeAttribute('src');
  $('viewer-image').hidden = true;
  if (typeof $('photo-dialog').close === 'function') $('photo-dialog').close();
  else $('photo-dialog').removeAttribute('open');
}

function clearNewPhoto() {
  state.photoVersion++;
  state.photoBusy = false;
  state.photo = null;
  state.photoError = '';
  if (state.photoURL) URL.revokeObjectURL(state.photoURL);
  state.photoURL = '';
  $('photo-preview').removeAttribute('src');
  $('camera-input').value = '';
  $('gallery-input').value = '';
}

function invalidateSession(message) {
  const current = readSession();
  if (current?.token === state.session?.token) sessionStorage.removeItem('receipt-session');
  state.loadVersion++;
  state.session = null;
  state.loaded = false;
  state.loading = false;
  state.mutating = false;
  state.listReady = false;
  state.records = [];
  state.pendingSave = null;
  state.dirty = false;
  state.conflict = false;
  clearNewPhoto();
  closeViewer();
  $('delivery-form').reset();
  $('history-body').replaceChildren();
  $('store-name').textContent = '';
  for (const id of ['total-count', 'total-amount', 'total-distance']) $(id).textContent = '—';
  setMessage('');
  clearErrors();
  setGate(message);
}

function handleFailure(error) {
  if (error.status === 403 && error.code === 'record_locked') return false;
  if (error.status === 401 || error.status === 403) {
    const message = error.message || '門市登入已失效。';
    invalidateSession(error.status === 401
      ? `${message} 尚未儲存的內容已清除，請回叫貨系統重新登入後再填寫。`
      : message);
    return true;
  }
  return false;
}

function busy() { return state.loading || state.mutating; }

function syncControls() {
  const blocked = busy();
  document.querySelectorAll('#delivery-form input, #delivery-form textarea, #delivery-form button').forEach(el => { el.disabled = blocked; });
  for (const id of ['history-month', 'refresh', 'access-retry', 'reload-conflict']) $(id).disabled = blocked;
  $('save').disabled = blocked || !state.loaded || state.photoBusy || !!state.photoError || state.conflict;
  $('save').textContent = state.mutating ? '儲存中…' : state.photoBusy ? '照片處理中…' : '儲存外送記錄';
  $('save-hint').textContent = state.photoError ? '請重新選照片或取消新照片' : state.dirty ? '有尚未儲存的內容' : '金額以新台幣記錄';
  $('delivery-form').setAttribute('aria-busy', String(state.mutating || state.photoBusy));
  $('previous-page').disabled = blocked || !state.listReady || state.page === 0;
  $('next-page').disabled = blocked || !state.listReady || !state.hasMore;
  document.querySelectorAll('#history-body button').forEach(el => { el.disabled = blocked; });
  $('conflict').hidden = !state.conflict;
  $('photo-preview-wrap').hidden = !state.photoURL;
  $('clear-photo').hidden = !state.photo && !state.photoError && !state.photoBusy;
  $('photo-feedback').textContent = state.photoBusy ? '正在整理照片，完成後即可儲存…' : state.photoError;
  $('photo-feedback').hidden = !state.photoBusy && !state.photoError;
  $('photo-feedback').className = `photo-feedback${state.photoError ? ' error' : ''}`;
  $('photo-summary').textContent = state.photo
    ? '照片會隨資料一併上傳，成功後不能更換或移除。'
    : '每筆可附一張照片，請在本次上傳前選取。未附單據送出後不能補傳。';
}

function signature() {
  return JSON.stringify([...Object.values(fields).map(id => $(id).value), state.photoVersion]);
}

function markChanged() {
  state.dirty = signature() !== state.signature;
  state.pendingSave = null;
  if (!state.conflict) setMessage('');
  syncControls();
}

function resetForm({ courier = '' } = {}) {
  clearNewPhoto();
  state.newId = crypto.randomUUID();
  state.pendingSave = null;
  state.conflict = false;
  $('delivery-form').reset();
  $('courier').value = courier;
  $('delivered-at').value = taipeiDateTime();
  $('form-mode').textContent = '新增外送';
  $('form-title').textContent = '記下一筆外送';
  clearErrors();
  state.signature = signature();
  state.dirty = false;
  syncControls();
}

async function api(action, body = {}, form = null) {
  if (!sameSession()) throw new ApiError('門市登入已變更，請回叫貨系統確認登入後再開啟外送記錄。', 403);
  const sessionToken = state.session.token;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), form ? 45000 : 25000);
  let response;
  try {
    response = await fetch(API, {
      method: 'POST', headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${sessionToken}` },
      body: form || JSON.stringify({ action, ...body }), signal: controller.signal,
    });
  } catch (error) {
    throw new ApiError(action === 'save'
      ? '連線中斷，尚無法確認這次儲存結果。輸入與照片已保留，請保持內容不變並再按儲存，系統會避免重複記錄。'
      : error.name === 'AbortError' ? '連線逾時，請檢查網路後重試。' : '無法連上雲端，請檢查網路後重試。');
  } finally { clearTimeout(timer); }
  if (!sameSession() || state.session.token !== sessionToken) throw new ApiError('門市登入已變更，請回叫貨系統重新開啟外送記錄。', 403);
  let data;
  try { data = await response.json(); }
  catch { throw new ApiError(action === 'save' ? '伺服器回應不完整，尚無法確認儲存結果。請保留輸入並重試。' : '伺服器回應不完整，請稍後再試。', response.status); }
  if (!sameSession()) throw new ApiError('門市登入已變更，請回叫貨系統重新開啟外送記錄。', 403);
  if (!response.ok) throw new ApiError(data.error || '操作未完成，請稍後再試。', response.status, data.code);
  return data;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function recordButton(label, action, record, className = '') {
  const button = element('button', `row-button ${className}`.trim(), label);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = record.id;
  button.setAttribute('aria-label', `${label}：${record.unit_name}`);
  return button;
}

function renderRecords() {
  $('history-body').replaceChildren();
  for (const row of state.records) {
    const tr = document.createElement('tr');
    const time = taipeiDateTime(row.delivered_at);
    const dateCell = document.createElement('td');
    dateCell.append(element('span', 'record-date', time.slice(0, 10).replaceAll('-', '/')), element('span', 'record-time', time.slice(11, 16)));
    const unitCell = document.createElement('td');
    unitCell.append(element('strong', 'record-unit', row.unit_name), element('span', 'record-address', row.address));
    const courierCell = element('td', '', row.courier);
    courierCell.dataset.label = '外送人員';
    const amountCell = element('td', 'record-number', `${format(row.amount)} 元`);
    amountCell.dataset.label = '金額';
    const distanceCell = element('td', 'record-number', `${format(row.distance_km)} 公里`);
    distanceCell.dataset.label = '距離';
    const actionCell = document.createElement('td');
    const actions = element('div', 'record-actions');
    actions.append(row.has_photo ? recordButton('查看單據', 'photo', row, 'photo') : element('span', 'no-photo', '未附單據'));
    actions.append(recordButton('刪除', 'delete', row, 'danger'));
    actionCell.append(actions);
    tr.append(dateCell, unitCell, courierCell, amountCell, distanceCell, actionCell);
    $('history-body').append(tr);
  }
  $('table-wrap').hidden = state.records.length === 0;
  $('list-state').hidden = state.records.length > 0;
  $('list-state').className = 'list-state';
  $('list-state').textContent = '這個月份還沒有外送紀錄。填寫上方資料，就能開始記錄。';
  $('pagination').hidden = state.totalCount <= 50;
  $('page-info').textContent = `第 ${state.page + 1}／${Math.max(1, Math.ceil(state.totalCount / 50))} 頁`;
}

function clearList(message, isError = false) {
  state.listReady = false;
  state.records = [];
  $('history-body').replaceChildren();
  $('table-wrap').hidden = true;
  $('pagination').hidden = true;
  $('list-state').hidden = false;
  $('list-state').className = `list-state${isError ? ' error' : ''}`;
  $('list-state').textContent = message;
  for (const id of ['total-count', 'total-amount', 'total-distance']) $(id).textContent = '—';
}

async function loadList({ initial = false } = {}) {
  if (!isValidMonth(state.month)) return false;
  const request = ++state.loadVersion;
  const month = state.month;
  const page = state.page;
  state.loading = true;
  if (initial) setGate('正在確認門市登入，並讀取雲端紀錄…', { login: false });
  clearList('正在讀取外送紀錄…');
  syncControls();
  try {
    const data = await api('load', { month, page });
    if (request !== state.loadVersion) return false;
    if (Number(data.store_id) !== Number(state.session?.store_id) || !Object.hasOwn(ALLOWED_STORES, Number(data.store_id))) {
      throw new ApiError('門市驗證未完成，請回叫貨系統重新登入。', 403);
    }
    if (data.month !== month || !Array.isArray(data.records) || !Number.isSafeInteger(Number(data.total_count)) || Number(data.total_count) < 0
      || !Number.isFinite(Number(data.total_amount)) || !Number.isFinite(Number(data.total_distance_km))) {
      throw new ApiError('紀錄資料不完整，請重新讀取。');
    }
    const lastPage = Math.max(0, Math.ceil(Number(data.total_count) / 50) - 1);
    if (page > lastPage) {
      state.page = lastPage;
      return await loadList({ initial });
    }
    state.loaded = true;
    state.listReady = true;
    state.records = data.records;
    state.totalCount = Number(data.total_count);
    state.hasMore = data.has_more === true;
    $('store-name').textContent = data.store_name || ALLOWED_STORES[Number(data.store_id)];
    $('workspace').hidden = false;
    $('access-gate').hidden = true;
    $('total-count').textContent = format(data.total_count);
    $('total-amount').textContent = format(data.total_amount);
    $('total-distance').textContent = format(data.total_distance_km);
    $('history-description').textContent = `${month.replace('-', ' 年 ')} 月 · 統計涵蓋全部 ${format(data.total_count)} 筆紀錄，日期時間皆為台灣時間。已上傳的資料與單據不能再編輯。`;
    renderRecords();
    return true;
  } catch (error) {
    if (request !== state.loadVersion) return false;
    if (handleFailure(error)) return false;
    clearList(`${error.message} 目前無法確認此月份的紀錄，請按「重新讀取」。`, true);
    if (initial || !state.loaded) setGate(error.message, { retry: true });
    return false;
  } finally {
    if (request === state.loadVersion) { state.loading = false; syncControls(); }
  }
}

function confirmDiscard(message = '目前內容尚未儲存，確定放棄這份草稿？') {
  return !state.dirty && !state.photoBusy || window.confirm(message);
}

async function saveRecord(event) {
  event.preventDefault();
  if (busy() || !state.loaded || state.photoBusy || state.photoError || state.conflict) return;
  clearErrors();
  const raw = Object.fromEntries(Object.entries(fields).map(([field, id]) => [field, $(id).value]));
  const validation = validateFields(raw);
  if (!validation.ok) {
    for (const [field, error] of Object.entries(validation.errors)) {
      const id = fields[field];
      $(id).setAttribute('aria-invalid', 'true');
      $(`${id}-error`).textContent = error;
      $(`${id}-error`).hidden = false;
    }
    $(fields[Object.keys(validation.errors)[0]]).focus();
    setMessage('請確認標示的欄位，再儲存這筆外送。', 'error');
    return;
  }
  const photoNotice = state.photo
    ? '單據照片將一併上傳，之後不能更換或移除。'
    : '本次未附單據；送出後不能補傳照片。';
  if (!window.confirm(`確認上傳「${validation.value.unit_name}」？\n\n上傳成功後，所有欄位與單據照片都不能再編輯。\n${photoNotice}\n請確認資料無誤後再上傳。`)) return;
  if (!state.pendingSave) {
    state.pendingSave = {
      action: 'save', ...validation.value, id: state.newId,
      request_id: crypto.randomUUID(), expected_version: 0, remove_photo: false,
    };
  }
  const payload = state.pendingSave;
  const form = new FormData();
  form.set('payload', JSON.stringify(payload));
  if (state.photo) form.set('photo', state.photo, 'delivery-receipt.jpg');
  state.mutating = true;
  setMessage('正在儲存外送資料與單據，請稍候…', 'info');
  syncControls();
  try {
    const data = await api('save', {}, form);
    if (!data.record || data.record.id !== payload.id || !Number.isInteger(data.record.version) || data.record.version < 1) {
      throw new ApiError('尚未收到完整的儲存確認，輸入與照片已保留。請保持內容不變並再按儲存確認。');
    }
    const hadPhoto = !!state.photo;
    const savedMonth = taipeiDateTime(data.record.delivered_at).slice(0, 7);
    resetForm({ courier: payload.courier });
    if (isValidMonth(savedMonth)) { state.month = savedMonth; $('history-month').value = savedMonth; }
    state.page = 0;
    const refreshed = await loadList();
    if (state.session) setMessage(`外送記錄已上傳並鎖定。${hadPhoto ? '單據照片已一併上傳。' : '本筆未附單據，之後不能補傳。'}${refreshed ? '' : '\n清單暫時無法更新，請稍後按「重新讀取」查看。'}`, refreshed ? '' : 'info');
  } catch (error) {
    if (!handleFailure(error)) {
      if (error.status === 409 || error.status === 403 && error.code === 'record_locked') state.conflict = true;
      setMessage(error.message, 'error');
    }
  } finally { state.mutating = false; syncControls(); }
}

async function deleteRecord(row) {
  if (busy()) return;
  const date = taipeiDateTime(row.delivered_at).replace('T', ' ');
  if (!window.confirm(`刪除「${row.unit_name}」\n${date} · ${format(row.amount)} 元\n\n這筆外送紀錄與附上的單據都會移除，確定刪除？`)) return;
  state.mutating = true;
  setMessage('正在刪除這筆外送紀錄…', 'info');
  syncControls();
  try {
    const data = await api('delete', { id: row.id, expected_version: row.version });
    if (data.ok !== true) throw new ApiError('尚無法確認刪除結果，請重新讀取清單確認。');
    if (state.records.length === 1 && state.page > 0) state.page--;
    const refreshed = await loadList();
    if (state.session) setMessage(refreshed ? '外送紀錄已刪除。' : '刪除已完成，清單暫時無法更新，請稍後重新讀取。', refreshed ? '' : 'info');
  } catch (error) {
    if (!handleFailure(error)) setMessage(error.status === 409 ? '這筆紀錄已在其他畫面變更，請重新讀取後再確認是否刪除。' : `${error.message}\n若連線中斷，請先重新讀取確認刪除結果。`, 'error');
  } finally { state.mutating = false; syncControls(); }
}

async function pickPhoto(file) {
  if (!file || busy()) return;
  clearNewPhoto();
  const version = state.photoVersion;
  state.photoBusy = true;
  state.pendingSave = null;
  state.dirty = true;
  syncControls();
  let originalURL = '';
  try {
    if (file.size === 0 || file.size > 30 * 1024 * 1024) throw new Error('請選擇 30MB 以內且內容完整的照片。');
    if (file.type && !/^image\/(?:jpeg|png|webp|heic|heif)$/i.test(file.type)) throw new Error('請選擇 JPG、PNG 或 WebP 照片。');
    originalURL = URL.createObjectURL(file);
    const image = new Image();
    image.src = originalURL;
    await image.decode();
    if (!image.width || !image.height) throw new Error('這張照片無法讀取。');
    if (version !== state.photoVersion || !state.session) return;
    const scale = Math.min(1, 2400 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('照片處理暫時無法使用。');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const photo = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (version !== state.photoVersion || !state.session) return;
    if (!photo || photo.size === 0 || photo.size > 8 * 1024 * 1024) throw new Error('照片縮小後仍超過 8MB，請換較小照片或截圖。');
    state.photo = photo;
    state.photoURL = URL.createObjectURL(photo);
    $('photo-preview').src = state.photoURL;
    state.photoError = '';
  } catch (error) {
    if (version === state.photoVersion) state.photoError = `照片尚未加入：${error.message} 若是 HEIC 照片，請先截圖或轉為 JPG 後再選取。`;
  } finally {
    if (originalURL) URL.revokeObjectURL(originalURL);
    if (version === state.photoVersion) { state.photoBusy = false; state.dirty = true; syncControls(); }
  }
}

function safePhotoURL(value) {
  try {
    const url = new URL(value);
    return url.origin === PHOTO_ORIGIN && !url.username && !url.password && url.pathname.startsWith('/storage/v1/object/sign/delivery-photos/') ? url.href : null;
  } catch { return null; }
}

async function viewPhoto(row) {
  if (busy() || !row?.has_photo) return;
  const request = ++state.viewerVersion;
  state.viewerId = row.id;
  $('viewer-title').textContent = `${row.unit_name} · 外送單據`;
  $('viewer-image').hidden = true;
  $('viewer-image').removeAttribute('src');
  $('viewer-message').textContent = '正在讀取單據…';
  $('viewer-message').hidden = false;
  $('retry-photo').hidden = true;
  if (!$('photo-dialog').open) {
    if (typeof $('photo-dialog').showModal === 'function') $('photo-dialog').showModal();
    else $('photo-dialog').setAttribute('open', '');
  }
  try {
    const data = await api('photo', { id: row.id });
    if (request !== state.viewerVersion) return;
    const url = safePhotoURL(data.url);
    if (!url) throw new ApiError('照片連結無效，請重新讀取。');
    const image = $('viewer-image');
    image.onload = () => {
      if (request !== state.viewerVersion) return;
      image.hidden = false;
      $('viewer-message').hidden = true;
    };
    image.onerror = () => {
      if (request !== state.viewerVersion) return;
      image.hidden = true;
      $('viewer-message').hidden = false;
      $('viewer-message').textContent = '照片暫時無法開啟或連結已過期，請重新讀取。';
      $('retry-photo').hidden = false;
    };
    image.src = url;
  } catch (error) {
    if (request !== state.viewerVersion || handleFailure(error)) return;
    $('viewer-message').textContent = error.message;
    $('retry-photo').hidden = false;
  }
}

$('delivery-form').addEventListener('submit', saveRecord);
$('delivery-form').addEventListener('input', event => {
  if (event.target.type === 'file') return;
  const id = event.target.id;
  if (Object.values(fields).includes(id)) { $(id).removeAttribute('aria-invalid'); $(`${id}-error`).hidden = true; }
  markChanged();
});
$('take-photo').addEventListener('click', () => $('camera-input').click());
$('choose-photo').addEventListener('click', () => $('gallery-input').click());
for (const id of ['camera-input', 'gallery-input']) $(id).addEventListener('change', () => { void pickPhoto($(id).files?.[0]); });
$('clear-photo').addEventListener('click', () => { clearNewPhoto(); markChanged(); });
$('reload-conflict').addEventListener('click', () => {
  if (busy() || !confirmDiscard('捨棄畫面上的草稿與待傳照片，重新讀取雲端紀錄？')) return;
  resetForm(); setMessage(''); void loadList();
});
$('history-month').addEventListener('change', () => {
  if (busy()) { $('history-month').value = state.month; return; }
  const month = $('history-month').value;
  if (!isValidMonth(month)) { $('history-month').value = state.month; setMessage('請選擇有效的查詢月份。', 'error'); return; }
  state.month = month; state.page = 0; void loadList();
});
$('refresh').addEventListener('click', () => { if (!busy()) void loadList(); });
$('access-retry').addEventListener('click', () => { if (!busy()) void loadList({ initial: true }); });
$('previous-page').addEventListener('click', () => { if (!busy() && state.page > 0) { state.page--; void loadList(); } });
$('next-page').addEventListener('click', () => { if (!busy() && state.hasMore) { state.page++; void loadList(); } });
$('history-body').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || busy()) return;
  const row = state.records.find(record => record.id === button.dataset.id);
  if (!row) return;
  if (button.dataset.action === 'delete') void deleteRecord(row);
  if (button.dataset.action === 'photo') void viewPhoto(row);
});
$('close-photo').addEventListener('click', closeViewer);
$('photo-dialog').addEventListener('cancel', event => { event.preventDefault(); closeViewer(); });
$('retry-photo').addEventListener('click', () => {
  const row = state.records.find(record => record.id === state.viewerId);
  if (row) void viewPhoto(row);
});

window.addEventListener('beforeunload', event => {
  if (state.dirty || state.mutating || state.photoBusy) { event.preventDefault(); event.returnValue = ''; }
});
document.querySelectorAll('a[href="index.html"]').forEach(link => link.addEventListener('click', event => {
  if (state.mutating) { event.preventDefault(); return; }
  if (!confirmDiscard('外送資料尚未儲存，確定放棄修改並回叫貨系統？')) event.preventDefault();
  else { state.dirty = false; clearNewPhoto(); }
}));

function checkSessionChange() {
  if (state.session && !sameSession()) invalidateSession('門市登入已變更，請回叫貨系統確認登入後再開啟外送記錄。');
}
window.addEventListener('pageshow', checkSessionChange);
window.addEventListener('focus', checkSessionChange);
window.addEventListener('storage', checkSessionChange);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSessionChange(); });

async function start() {
  state.session = readSession();
  resetForm();
  $('history-month').value = state.month;
  if (!isAllowedSession(state.session)) {
    setGate('外送記錄僅開放潮州店與木崎。請先回叫貨系統，使用這兩間門市的帳號登入。');
    return;
  }
  await loadList({ initial: true });
}
void start();
