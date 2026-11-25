import { ALLOWED_STORES, DEFAULT_DELIVERY_ADDRESS, vehicleTypeLabel, taipeiDateTime, isValidMonth, isCountyPrefixOnly, PAGE_SIZE, MAX_RECORDS, STORE_ORIGINS, SORT_LABELS, VEHICLE_FILTER_LABELS, validateAdminFields, isCompleteRecord, filterAndSortRecords, recordTotals } from './delivery-admin-core.mjs?v=20261125-admin1';
import { createDeliveryWorkbook, deliveryExportFilename } from './delivery-export.mjs?v=20261125-admin1';

const API_ORIGIN = 'https://rjetwgrelmvciatouwiw.supabase.co';
const API = `${API_ORIGIN}/functions/v1/delivery-admin-api`;
const LOGIN_API = `${API_ORIGIN}/functions/v1/receipt-api`;
const SESSION_KEY = 'receipt-admin-session';
const $ = id => document.getElementById(id);
const currency = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
const decimal = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const state = {
  token: '', session: 0, verified: false, loginBusy: false, loading: false, loaded: false, exporting: false,
  records: [], filtered: [], page: 1, loadVersion: 0, scope: null, services: {}, controllers: new Set(), operation: null,
  editor: null, attachment: null, deletion: null, viewer: null,
};

class ApiError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.status = status; this.code = code; }
}
function storedToken() { try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch { return state.token; } }
function storeToken(token) { try { if (token) sessionStorage.setItem(SESSION_KEY, token); else sessionStorage.removeItem(SESSION_KEY); } catch { /* This tab can still hold a verified session in memory. */ } }
function isSameSession(token = state.token, generation = state.session) {
  return !!token && token === state.token && generation === state.session && storedToken() === token;
}
function requireSession() {
  if (!isSameSession()) {
    invalidateSession('主管登入已變更，請重新登入。', false);
    throw new ApiError('主管登入已變更。', 0, 'stale_session');
  }
}
function notice(id, message = '', kind = 'info') {
  const node = $(id); node.textContent = message; node.className = `message ${kind}`; node.hidden = !message;
}
function element(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text); return node;
}
function showDialog(id) { const dialog = $(id); if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
function hideDialog(id) { const dialog = $(id); if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); }
function mainBusy() { return state.loading || state.loginBusy || state.exporting || !!state.operation; }
function unconfirmedWork() {
  return !!state.operation || !!state.editor && (state.editor.dirty || state.editor.photo.busy || !!state.editor.photo.blob || !!state.editor.pending)
    || !!state.attachment && (state.attachment.photo.busy || !!state.attachment.photo.blob || !!state.attachment.pending)
    || !!state.deletion?.pending;
}
function confirmDiscard() {
  const uncertain = state.operation || state.editor?.pending && !state.editor.conflict || state.attachment?.pending && !state.attachment.conflict || state.deletion?.pending && !state.deletion.conflict;
  return !unconfirmedWork() || window.confirm(uncertain
    ? '這次送出的結果尚未確認，雲端可能已完成。離開會捨棄本頁草稿；回來後請先重新查詢，避免重複新增。確定離開？'
    : '尚有未儲存的資料或照片，確定捨棄並離開？');
}
function clearList() {
  state.records = []; state.filtered = []; state.loaded = false; state.scope = null; state.page = 1;
  $('rows').replaceChildren(); $('table-wrap').hidden = true; $('pagination').hidden = true;
  for (const id of ['total-count', 'total-amount', 'total-distance']) $(id).textContent = '—';
  $('scope-description').textContent = '日期時間皆為台灣時間，金額單位為新台幣。';
  $('export').disabled = true;
}
function invalidateSession(message = '請使用主管密碼登入。', removeStored = true) {
  const oldToken = state.token;
  state.session += 1; state.loadVersion += 1; state.token = ''; state.verified = false;
  state.loginBusy = false; state.loading = false; state.exporting = false;
  for (const controller of state.controllers) controller.abort(); state.controllers.clear();
  closeEditor(true); closeAttachment(true); closeDeletion(true); closeViewer(); state.operation = null;
  if (removeStored && storedToken() === oldToken) storeToken('');
  state.services = {}; clearList(); $('password').value = ''; $('workspace').hidden = true; $('login').hidden = false;
  $('search').value = ''; $('vehicle-filter').value = 'all'; $('sort-by').value = 'delivered_at'; $('sort-direction').value = 'desc';
  $('login-retry').hidden = true; notice('message'); notice('login-message', message); syncControls();
}

async function api(action, payload = {}, photo = null, { signal, timeout = photo ? 45000 : 25000 } = {}) {
  requireSession();
  const token = state.token, generation = state.session, controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  state.controllers.add(controller);
  const timer = setTimeout(abort, timeout);
  const multipart = action === 'save' || action === 'attach_photo';
  let body;
  if (multipart) {
    body = new FormData(); body.append('payload', JSON.stringify({ action, ...payload }));
    if (photo) body.append('photo', photo, 'receipt.jpg');
  } else body = JSON.stringify({ action, ...payload });
  try {
    const response = await fetch(API, {
      method: 'POST', headers: { ...(multipart ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` },
      body, signal: controller.signal,
    });
    if (!isSameSession(token, generation)) throw new ApiError('登入已變更。', 0, 'stale_session');
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError('伺服器回應不完整，請重試確認結果。', response.status >= 400 ? response.status : 0); }
    if (!isSameSession(token, generation)) throw new ApiError('登入已變更。', 0, 'stale_session');
    if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : '操作未完成，請稍後再試。', response.status, data.code || '');
    return data;
  } catch (error) {
    if (!isSameSession(token, generation)) {
      if (state.token === token && state.session === generation) invalidateSession('主管登入已變更，請重新登入。', false);
      throw new ApiError('登入已變更。', 0, 'stale_session');
    }
    const failure = error instanceof ApiError ? error : new ApiError(controller.signal.aborted ? '連線逾時，請重試確認結果。' : '無法連上雲端，請檢查網路後重試。');
    if ((failure.status === 401 || failure.status === 403) && !['photo_locked', 'record_locked'].includes(failure.code)) {
      invalidateSession('主管登入已失效或沒有管理權限，請重新登入。');
      failure.code = 'stale_session';
    }
    throw failure;
  } finally { clearTimeout(timer); state.controllers.delete(controller); signal?.removeEventListener('abort', abort); }
}

async function login(event) {
  event.preventDefault(); if (state.loginBusy || state.loading) return;
  const password = $('password').value;
  if (!password) { notice('login-message', '請輸入主管密碼。', 'error'); $('password').focus(); return; }
  const generation = ++state.session, controller = new AbortController();
  state.controllers.add(controller); state.loginBusy = true; notice('login-message', '正在驗證主管登入…'); syncControls();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(LOGIN_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'admin_login', password }), signal: controller.signal });
    const data = await response.json();
    if (generation !== state.session) return;
    if (!response.ok || typeof data.token !== 'string' || !data.token) throw new Error(typeof data.error === 'string' ? data.error : '登入失敗，請確認主管密碼。');
    $('password').value = ''; state.token = data.token; storeToken(state.token); state.loginBusy = false;
    await loadRecords();
  } catch (error) {
    if (generation === state.session) notice('login-message', error.name === 'AbortError' ? '登入連線逾時，請稍後重試。' : error.message || '登入失敗，請稍後重試。', 'error');
  } finally {
    clearTimeout(timer); state.controllers.delete(controller);
    if (generation === state.session) { $('password').value = ''; state.loginBusy = false; syncControls(); }
  }
}

async function loadRecords({ success = '' } = {}) {
  if (state.operation) return false;
  const month = $('month').value, storeId = $('store-filter').value ? Number($('store-filter').value) : null;
  if (!isValidMonth(month) || storeId !== null && !Object.hasOwn(ALLOWED_STORES, storeId)) {
    notice(state.verified ? 'message' : 'login-message', '請選擇有效的月份與門市。', 'error'); return false;
  }
  const version = ++state.loadVersion, token = state.token, generation = state.session;
  state.loading = true; clearList(); notice('message'); $('list-state').hidden = false; $('list-state').className = 'list-state'; $('list-state').textContent = '正在讀取整月資料…';
  if (!state.verified) notice('login-message', '正在驗證主管權限與讀取資料…');
  $('login-retry').hidden = true; syncControls();
  try {
    const data = await api('load', { month, store_id: storeId });
    if (version !== state.loadVersion || !isSameSession(token, generation)) return false;
    const rows = data.records;
    if (!Array.isArray(rows) || rows.length > MAX_RECORDS || !Number.isInteger(data.total_count) || data.total_count !== rows.length
      || new Set(rows.map(row => row?.id)).size !== rows.length
      || rows.some(row => !isCompleteRecord(row) || taipeiDateTime(row.delivered_at).slice(0, 7) !== month || storeId !== null && row.store_id !== storeId)) {
      throw new ApiError('本月資料未完整讀取，為避免漏筆，目前停止查詢與匯出。請重新讀取。', 0, 'incomplete_records');
    }
    state.records = rows; state.scope = { month, storeId }; state.loaded = true; state.verified = true;
    state.services = {};
    for (const id of [1, 2]) {
      const service = data.distance_services?.[String(id)];
      state.services[id] = { available: service?.available === true && service.origin_address === STORE_ORIGINS[id] && service.mode === 'scooter' && service.provider === 'geoapify', origin_address: STORE_ORIGINS[id] };
    }
    $('login').hidden = true; $('workspace').hidden = false; notice('login-message');
    renderRecords(true); if (success) notice('message', success, 'success'); return true;
  } catch (error) {
    if (version !== state.loadVersion || !isSameSession(token, generation)) return false;
    clearList(); $('list-state').hidden = false; $('list-state').className = 'list-state error'; $('list-state').textContent = error.message || '無法讀取資料，請重新連線。';
    notice(state.verified ? 'message' : 'login-message', error.message || '讀取失敗，請重試。', 'error');
    $('login-retry').hidden = state.verified; return false;
  } finally { if (version === state.loadVersion) { state.loading = false; syncControls(); } }
}

function recordButton(label, action, row, className = '') {
  const button = element('button', `row-button ${className}`.trim(), label);
  button.type = 'button'; button.dataset.action = action; button.dataset.id = row.id; button.setAttribute('aria-label', `${label}：${row.unit_name}`); return button;
}
function renderRecords(resetPage = false) {
  if (!state.loaded) return;
  if (resetPage) state.page = 1;
  state.filtered = filterAndSortRecords(state.records, { search: $('search').value, vehicle: $('vehicle-filter').value, sort: $('sort-by').value, direction: $('sort-direction').value });
  const pages = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE)); state.page = Math.min(state.page, pages);
  const totals = recordTotals(state.filtered);
  $('total-count').textContent = currency.format(totals.count); $('total-amount').textContent = currency.format(totals.amount); $('total-distance').textContent = decimal.format(totals.distance);
  const fragment = document.createDocumentFragment();
  for (const row of state.filtered.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE)) {
    const tr = element('tr'); tr.dataset.id = row.id;
    const date = taipeiDateTime(row.delivered_at);
    const when = element('td'); when.append(element('span', 'record-date', date.slice(0, 10)), element('span', 'record-time', date.slice(11)), element('span', 'record-store', ALLOWED_STORES[row.store_id]));
    const where = element('td'); where.append(element('strong', 'record-unit', row.unit_name), element('span', 'record-address', row.address));
    const courier = element('td'); courier.dataset.label = '外送人員'; courier.append(element('span', 'courier-name', row.courier), element('span', 'record-vehicle', vehicleTypeLabel(row.vehicle_type)));
    const amount = element('td', 'number', currency.format(row.amount)); amount.dataset.label = '金額（元）';
    const distance = element('td', 'number', decimal.format(row.distance_km)); distance.dataset.label = '距離（公里）';
    const actions = element('td'), buttons = element('div', 'record-actions');
    buttons.append(recordButton(row.has_photo ? '查看單據' : '補傳單據', row.has_photo ? 'photo' : 'attach', row, 'photo'), recordButton('編輯', 'edit', row), recordButton('刪除', 'delete', row, 'danger')); actions.append(buttons);
    tr.append(when, where, courier, amount, distance, actions); fragment.append(tr);
  }
  $('rows').replaceChildren(fragment); $('table-wrap').hidden = !state.filtered.length; $('list-state').hidden = !!state.filtered.length;
  $('list-state').textContent = state.records.length ? '目前的關鍵字與車輛條件沒有符合的紀錄。' : '這個月份尚無外送紀錄，可按「新增外送」建立。';
  $('list-state').className = 'list-state';
  $('pagination').hidden = state.filtered.length <= PAGE_SIZE; $('page-info').textContent = `第 ${state.page} / ${pages} 頁，共 ${totals.count} 筆`;
  $('scope-description').textContent = `${state.scope.month} · ${ALLOWED_STORES[state.scope.storeId] || '全部門市'} · 目前篩選 ${totals.count} 筆；日期時間皆為台灣時間。`;
  document.querySelectorAll('th [data-sort]').forEach(button => button.parentElement.setAttribute('aria-sort', button.dataset.sort === $('sort-by').value ? ($('sort-direction').value === 'asc' ? 'ascending' : 'descending') : 'none'));
  syncControls();
}

function photoState() { return { blob: null, url: '', busy: false, version: 0, error: '' }; }
function clearPhoto(kind) {
  const owner = state[kind]; if (!owner) return;
  const photo = owner.photo; photo.version += 1; if (photo.url) URL.revokeObjectURL(photo.url);
  photo.blob = null; photo.url = ''; photo.busy = false; photo.error = '';
  for (const source of ['camera', 'gallery']) $(`${kind}-${source}-input`).value = '';
  $(`${kind}-photo-preview`).removeAttribute('src'); $(`${kind}-photo-preview-wrap`).hidden = true;
  $(`${kind}-photo-feedback`).textContent = ''; $(`${kind}-photo-feedback`).hidden = true;
}
function drawPhoto(kind) {
  const photo = state[kind]?.photo; if (!photo) return;
  const feedback = $(`${kind}-photo-feedback`);
  feedback.textContent = photo.busy ? '正在縮小照片…' : photo.error || (photo.blob ? `照片已備妥，約 ${Math.ceil(photo.blob.size / 1024)} KB。` : '');
  feedback.hidden = !feedback.textContent; feedback.className = photo.error ? 'field-error' : 'field-hint';
  $(`${kind}-photo-preview-wrap`).hidden = !photo.url && !photo.error;
  $(`${kind}-photo-preview`).hidden = !photo.url; if (photo.url) $(`${kind}-photo-preview`).src = photo.url;
}

function renderSummary(id, row) {
  const items = [['外送單位', row.unit_name], ['外送地址', row.address], ['門市', ALLOWED_STORES[row.store_id]], ['外送日期時間', taipeiDateTime(row.delivered_at).replace('T', ' ')], ['外送人員', row.courier], ['使用車輛', vehicleTypeLabel(row.vehicle_type)], ['金額', `${currency.format(row.amount)} 元`], ['單程距離', `${decimal.format(row.distance_km)} 公里`]];
  $(id).replaceChildren(...items.map(([label, value]) => { const item = element('div'); item.append(element('dt', '', label), element('dd', '', value)); return item; }));
}

function syncControls() {
  const busy = mainBusy();
  $('login-submit').disabled = state.loginBusy || state.loading; $('password').disabled = state.loginBusy || state.loading;
  $('login-retry').disabled = state.loginBusy || state.loading;
  for (const id of ['month', 'store-filter', 'refresh', 'search', 'vehicle-filter', 'sort-by', 'sort-direction']) $(id).disabled = busy;
  $('new-record').disabled = busy || !state.loaded;
  $('export').disabled = busy || !state.loaded || !state.filtered.length;
  $('export').textContent = state.exporting ? '正在產生 Excel…' : '匯出 Excel';
  $('previous-page').disabled = busy || state.page <= 1; $('next-page').disabled = busy || state.page * PAGE_SIZE >= state.filtered.length;
  document.querySelectorAll('#rows button, th [data-sort]').forEach(button => { button.disabled = busy || !state.loaded; });
  const editor = state.editor;
  if (editor) {
    const locked = !!editor.pending || editor.conflict || !!state.operation;
    document.querySelectorAll('#editor-form input:not([type=file]), #editor-form textarea, #editor-form select').forEach(node => { node.disabled = locked || node.id === 'edit-store' && !!editor.row; });
    for (const id of ['editor-camera', 'editor-gallery', 'editor-clear-photo']) $(id).disabled = locked || editor.photo.busy;
    $('save-record').disabled = !!state.operation || editor.photo.busy || !!editor.photo.error || editor.conflict || editor.distance.status === 'loading' || editor.distance.status === 'scheduled';
    $('save-record').textContent = state.operation?.owner === editor ? '正在儲存…' : editor.pending ? '重試確認儲存' : editor.row ? '確認儲存' : '確認新增';
    $('reload-editor').disabled = !!state.operation;
    syncDistance();
  }
  const attachment = state.attachment;
  if (attachment) {
    const locked = !!attachment.pending || attachment.conflict || !!state.operation;
    for (const id of ['attachment-camera', 'attachment-gallery', 'attachment-clear-photo']) $(id).disabled = locked || attachment.photo.busy;
    $('confirm-attachment').disabled = !!state.operation || attachment.photo.busy || !!attachment.photo.error || !attachment.photo.blob || attachment.conflict;
    $('confirm-attachment').textContent = state.operation?.owner === attachment ? '正在補傳…' : attachment.pending ? '重試補傳' : '確認補傳';
  }
  if (state.deletion) {
    $('confirm-delete').disabled = !!state.operation || state.deletion.conflict;
    $('confirm-delete').textContent = state.operation?.owner === state.deletion ? '正在刪除…' : state.deletion.pending ? '重試確認刪除' : '確認刪除';
  }
}

const FIELD_IDS = { store_id: 'edit-store', delivered_at: 'edit-date', unit_name: 'edit-unit', address: 'edit-address', courier: 'edit-courier', vehicle_type: 'edit-vehicle', amount: 'edit-amount', distance_km: 'edit-distance' };
function clearErrors() { for (const id of Object.values(FIELD_IDS)) { $(id).removeAttribute('aria-invalid'); $(`${id}-error`).hidden = true; $(`${id}-error`).textContent = ''; } }
function showErrors(errors) {
  clearErrors(); for (const [key, message] of Object.entries(errors)) {
    const id = FIELD_IDS[key]; if (!id) continue; $(id).setAttribute('aria-invalid', 'true'); $(`${id}-error`).textContent = message; $(`${id}-error`).hidden = false;
  }
  const first = Object.keys(errors)[0]; if (first === 'vehicle_type') $('edit-personal').focus(); else $(FIELD_IDS[first])?.focus();
}
function rawEditorFields() {
  return { store_id: $('edit-store').value, delivered_at: $('edit-date').value, unit_name: $('edit-unit').value, address: $('edit-address').value,
    courier: $('edit-courier').value, amount: $('edit-amount').value, distance_km: $('edit-distance').value,
    vehicle_type: document.querySelector('#editor-form input[name=vehicle_type]:checked')?.value ?? '' };
}
function canOpenAction() { return state.loaded && !mainBusy() && !state.editor && !state.attachment && !state.deletion; }
function openEditor(row = null) {
  if (!canOpenAction()) return;
  const editor = { row, dirty: false, photo: photoState(), pending: null, conflict: false, distance: { generation: 0, timer: null, controller: null, status: 'idle', attempted: '', result: null, error: '' } };
  state.editor = editor; $('editor-form').reset(); clearErrors(); notice('editor-message'); $('editor-conflict').hidden = true;
  $('editor-mode').textContent = row ? '資料更正' : '新增外送'; $('editor-title').textContent = row ? '編輯外送記錄' : '新增外送記錄';
  $('editor-note').textContent = row ? '門市保持不變；可更正外送資料。已上傳的單據保留，未附單據可在列表另行補傳。' : '地址已預填屏東縣，請接續填寫；使用車輛請擇一。';
  $('edit-store').value = String(row?.store_id || Number($('store-filter').value) || 1);
  $('edit-date').value = row ? taipeiDateTime(row.delivered_at) : taipeiDateTime();
  $('edit-unit').value = row?.unit_name || ''; $('edit-address').value = row?.address || DEFAULT_DELIVERY_ADDRESS; $('edit-courier').value = row?.courier || '';
  $('edit-amount').value = row ? String(row.amount) : ''; $('edit-distance').value = row ? String(row.distance_km) : '';
  $('legacy-vehicle-option').hidden = !row || row.vehicle_type !== null;
  if (row?.vehicle_type === 'personal') $('edit-personal').checked = true;
  else if (row?.vehicle_type === 'store') $('edit-store-vehicle').checked = true;
  else if (row) $('edit-unknown').checked = true;
  $('editor-photo-section').hidden = !!row; clearPhoto('editor');
  if (row) editor.distance.status = 'recorded';
  syncControls(); showDialog('editor-dialog'); $('edit-unit').focus();
}
function abortOwner(owner) { if (state.operation?.owner === owner) { state.operation.controller.abort(); state.operation = null; } }
function closeEditor(force = false) {
  const editor = state.editor; if (!editor) { hideDialog('editor-dialog'); return true; }
  if (!force && (editor.dirty || editor.photo.busy || editor.photo.blob || editor.pending || state.operation?.owner === editor) && !confirmDiscard()) return false;
  cancelDistance(editor); abortOwner(editor); clearPhoto('editor'); state.editor = null;
  $('editor-form').reset(); clearErrors(); notice('editor-message'); $('editor-conflict').hidden = true; hideDialog('editor-dialog'); syncControls(); return true;
}

function cancelDistance(editor = state.editor) {
  if (!editor) return;
  const distance = editor.distance; distance.generation += 1;
  if (distance.timer !== null) clearTimeout(distance.timer); distance.timer = null;
  distance.controller?.abort(); distance.controller = null;
}
function syncDistance() {
  const editor = state.editor; if (!editor) return;
  const storeId = Number($('edit-store').value), service = state.services[storeId], distance = editor.distance;
  $('distance-origin').textContent = `出發門市：${STORE_ORIGINS[storeId] || '請選擇門市'}`;
  let message = '輸入完整地址，停留約 1 秒或離開欄位後將自動估算。';
  if (editor.pending) message = '本次送出的距離已保留，重試使用相同內容。';
  else if (!service?.available) message = '自動計算暫時無法使用，請手動填寫公里數。';
  else if (distance.status === 'loading') message = '正在計算機車單程道路距離…可按「手動填寫」停止等待。';
  else if (distance.status === 'scheduled') message = '輸入完成後將自動估算，也可直接手動填寫。';
  else if (distance.status === 'manual') message = '目前使用手動公里數；地址或門市變更後會清除舊值。';
  else if (distance.status === 'recorded') message = '目前為已儲存的公里數；可手動修改或重新計算。';
  else if (distance.status === 'success') message = `預估 ${decimal.format(distance.result.distance_km)} 公里 · 對應地址：${distance.result.matched_address}`;
  else if (distance.status === 'error') message = `${distance.error} 請確認地址後重試，或手動填寫公里數。`;
  $('distance-feedback').textContent = message; $('distance-feedback').className = distance.status === 'error' ? 'error' : '';
  $('distance-attribution').hidden = !distance.result;
  const locked = !!state.operation || !!editor.pending || editor.conflict;
  const address = $('edit-address').value.trim();
  $('calculate-distance').disabled = locked || !service?.available || !address || isCountyPrefixOnly(address) || distance.status === 'loading';
  $('manual-distance').disabled = locked; $('edit-distance').setAttribute('aria-busy', String(['loading', 'scheduled'].includes(distance.status)));
}
function scheduleDistance() {
  const editor = state.editor; if (!editor || editor.pending || editor.conflict || state.operation) return;
  const address = $('edit-address').value.trim(), distance = editor.distance;
  if (!state.services[Number($('edit-store').value)]?.available || !address || isCountyPrefixOnly(address) || ['manual', 'loading', 'scheduled'].includes(distance.status) || distance.attempted === address) return;
  distance.status = 'scheduled'; distance.timer = setTimeout(() => { distance.timer = null; void calculateDistance(); }, 1000); syncControls();
}
function addressChanged() {
  const editor = state.editor; if (!editor || editor.pending || editor.conflict) return;
  cancelDistance(editor); Object.assign(editor.distance, { status: 'idle', result: null, error: '', attempted: '' });
  $('edit-distance').value = ''; $('edit-distance').removeAttribute('aria-invalid'); $('edit-distance-error').hidden = true; editor.dirty = true;
  scheduleDistance(); syncControls();
}
function useManualDistance(focus = false) {
  const editor = state.editor; if (!editor || editor.pending || editor.conflict || state.operation) return;
  cancelDistance(editor); Object.assign(editor.distance, { status: 'manual', result: null, error: '', attempted: $('edit-address').value.trim() }); editor.dirty = true;
  syncControls(); if (focus) $('edit-distance').focus();
}
async function calculateDistance(force = false) {
  const editor = state.editor; if (!editor || editor.pending || editor.conflict || state.operation) return;
  const storeId = Number($('edit-store').value), address = $('edit-address').value.trim(), distance = editor.distance;
  if (!state.services[storeId]?.available || !address || isCountyPrefixOnly(address) || !force && distance.status === 'manual') return;
  cancelDistance(editor); const version = distance.generation, controller = new AbortController(); distance.controller = controller;
  Object.assign(distance, { status: 'loading', attempted: address, result: null, error: '' }); $('edit-distance').value = ''; editor.dirty = true; syncControls();
  const current = () => state.editor === editor && distance.generation === version && $('edit-address').value.trim() === address && Number($('edit-store').value) === storeId;
  try {
    const data = await api('distance', { store_id: storeId, address }, null, { signal: controller.signal, timeout: 20000 });
    if (!current()) return;
    if (typeof data.distance_km !== 'number' || !Number.isFinite(data.distance_km) || data.distance_km < 0 || data.distance_km > 99999.99 || data.address !== address
      || data.origin_address !== STORE_ORIGINS[storeId] || data.mode !== 'scooter' || data.provider !== 'geoapify' || typeof data.matched_address !== 'string' || !data.matched_address.trim()) throw new ApiError('距離回應不完整。');
    distance.result = data; distance.status = 'success'; $('edit-distance').value = data.distance_km.toFixed(2); $('edit-distance-error').hidden = true; $('edit-distance').removeAttribute('aria-invalid');
  } catch (error) { if (current()) { distance.status = 'error'; distance.error = error.message || '距離暫時無法計算。'; } }
  finally { if (current()) { distance.controller = null; syncControls(); } }
}

async function preparePhoto(file, isCurrent) {
  let sourceURL = '';
  try {
    if (!file.size || file.size > 30 * 1024 * 1024) throw new Error('請選擇 30MB 以內且內容完整的照片。');
    if (file.type && !/^image\/(?:jpeg|png|webp|heic|heif)$/i.test(file.type)) throw new Error('請選擇 JPG、PNG 或 WebP 照片。');
    sourceURL = URL.createObjectURL(file); const image = new Image(); image.src = sourceURL; await image.decode();
    if (!isCurrent()) return null; if (!image.width || !image.height) throw new Error('這張照片無法讀取。');
    const scale = Math.min(1, 2400 / Math.max(image.width, image.height)), canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('照片處理暫時無法使用。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const photo = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!isCurrent()) return null;
    if (!photo || !photo.size || photo.size > 8 * 1024 * 1024) throw new Error('照片縮小後仍超過 8MB，請換較小照片或截圖。');
    return photo;
  } finally { if (sourceURL) URL.revokeObjectURL(sourceURL); }
}
async function pickPhoto(kind, file) {
  const owner = state[kind]; if (!owner || !file || owner.pending || owner.conflict || state.operation || kind === 'editor' && owner.row) return;
  clearPhoto(kind); const photo = owner.photo, version = photo.version; photo.busy = true; drawPhoto(kind); syncControls();
  const current = () => state[kind] === owner && photo.version === version;
  try {
    const blob = await preparePhoto(file, current); if (!current() || !blob) return;
    photo.blob = blob; photo.url = URL.createObjectURL(blob); if (kind === 'editor') owner.dirty = true;
  } catch (error) { if (current()) photo.error = error.message || '這張照片無法讀取，請重新選取。'; }
  finally { if (current()) { photo.busy = false; drawPhoto(kind); syncControls(); } }
}

function startOperation(owner) { const operation = { owner, controller: new AbortController() }; state.operation = operation; syncControls(); return operation; }
function finishOperation(operation) { if (state.operation === operation) { state.operation = null; syncControls(); } }
function mutationError(owner, kind, error) {
  if (state[kind] !== owner || error.code === 'stale_session') return;
  const target = kind === 'editor' ? 'editor-message' : kind === 'attachment' ? 'attachment-message' : 'delete-message';
  if (error.status === 409 || error.code === 'photo_locked' || error.status === 404) {
    owner.conflict = true;
    notice(target, `${error.message}\n草稿與照片仍保留。請先核對最新資料，避免覆寫他人的變更。`, 'error');
    if (kind === 'editor') $('editor-conflict').hidden = false;
  } else if ([400, 413, 415, 422].includes(error.status)) {
    owner.pending = null; notice(target, error.message, 'error');
  } else notice(target, `${error.message}\n尚無法確認這次操作結果，已保留相同內容。請使用「重試」確認，系統會避免重複處理。`, 'error');
}
async function saveEditor(event) {
  event.preventDefault(); const editor = state.editor;
  if (!editor || state.operation || editor.conflict || editor.photo.busy || editor.photo.error || ['loading', 'scheduled'].includes(editor.distance.status)) return;
  if (!editor.pending) {
    const result = validateAdminFields(rawEditorFields(), { allowUnrecordedVehicle: editor.row?.vehicle_type === null });
    if (editor.row && result.value.store_id !== editor.row.store_id) result.errors.store_id = '既有紀錄不可更換門市。';
    if (Object.keys(result.errors).length) { showErrors(result.errors); notice('editor-message', '請完成標示的欄位。', 'error'); return; }
    clearErrors();
    if (!window.confirm(`${editor.row ? '確認儲存更正' : '確認新增外送'}？\n${ALLOWED_STORES[result.value.store_id]} · ${result.value.unit_name}\n${taipeiDateTime(result.value.delivered_at).replace('T', ' ')} · ${currency.format(result.value.amount)} 元 · ${vehicleTypeLabel(result.value.vehicle_type)}`)) return;
    cancelDistance(editor);
    editor.pending = { payload: { ...result.value, id: editor.row?.id || crypto.randomUUID(), request_id: crypto.randomUUID(), expected_version: editor.row?.version || 0 }, photo: editor.row ? null : editor.photo.blob };
  }
  const pending = editor.pending, operation = startOperation(editor); notice('editor-message', '正在儲存，請稍候…');
  try {
    const data = await api('save', pending.payload, pending.photo, { signal: operation.controller.signal });
    if (state.editor !== editor || state.operation !== operation) return;
    if (!isCompleteRecord(data.record) || data.record.id !== pending.payload.id || data.record.store_id !== pending.payload.store_id || data.record.version < 1) throw new ApiError('儲存回應不完整。');
    finishOperation(operation); closeEditor(true);
    $('month').value = taipeiDateTime(pending.payload.delivered_at).slice(0, 7);
    if ($('store-filter').value && Number($('store-filter').value) !== pending.payload.store_id) $('store-filter').value = String(pending.payload.store_id);
    await loadRecords({ success: '外送記錄已儲存，已重新讀取最新資料。' });
  } catch (error) { mutationError(editor, 'editor', error); }
  finally { finishOperation(operation); }
}

function openAttachment(row) {
  if (!canOpenAction() || row.has_photo) return;
  state.attachment = { row, photo: photoState(), pending: null, conflict: false };
  renderSummary('attachment-summary', row); notice('attachment-message'); clearPhoto('attachment'); syncControls(); showDialog('attachment-dialog');
}
function closeAttachment(force = false) {
  const attachment = state.attachment; if (!attachment) { hideDialog('attachment-dialog'); return true; }
  if (!force && (attachment.photo.blob || attachment.photo.busy || attachment.pending || state.operation?.owner === attachment) && !confirmDiscard()) return false;
  abortOwner(attachment); clearPhoto('attachment'); state.attachment = null; $('attachment-summary').replaceChildren(); notice('attachment-message'); hideDialog('attachment-dialog'); syncControls(); return true;
}
async function saveAttachment(event) {
  event.preventDefault(); const attachment = state.attachment;
  if (!attachment || state.operation || attachment.conflict || attachment.photo.busy || attachment.photo.error || !attachment.photo.blob) return;
  if (!attachment.pending) {
    if (!window.confirm(`確認補傳這筆外送單據？\n${ALLOWED_STORES[attachment.row.store_id]} · ${attachment.row.unit_name}\n照片上傳成功後僅供查看。`)) return;
    attachment.pending = { payload: { store_id: attachment.row.store_id, id: attachment.row.id, request_id: crypto.randomUUID(), expected_version: attachment.row.version }, photo: attachment.photo.blob };
  }
  const pending = attachment.pending, operation = startOperation(attachment); notice('attachment-message', '正在補傳單據，請稍候…');
  try {
    const data = await api('attach_photo', pending.payload, pending.photo, { signal: operation.controller.signal });
    if (state.attachment !== attachment || state.operation !== operation) return;
    if (!isCompleteRecord(data.record) || data.record.id !== pending.payload.id || data.record.store_id !== pending.payload.store_id || data.record.has_photo !== true) throw new ApiError('補傳回應不完整。');
    finishOperation(operation); closeAttachment(true); await loadRecords({ success: '單據已補傳，照片成功上傳後僅供查看。' });
  } catch (error) { mutationError(attachment, 'attachment', error); }
  finally { finishOperation(operation); }
}

function openDeletion(row) {
  if (!canOpenAction()) return;
  state.deletion = { row, pending: null, conflict: false }; renderSummary('delete-summary', row); notice('delete-message'); syncControls(); showDialog('delete-dialog'); $('cancel-delete').focus();
}
function closeDeletion(force = false) {
  const deletion = state.deletion; if (!deletion) { hideDialog('delete-dialog'); return true; }
  if (!force && deletion.pending && !confirmDiscard()) return false;
  abortOwner(deletion); state.deletion = null; $('delete-summary').replaceChildren(); notice('delete-message'); hideDialog('delete-dialog'); syncControls(); return true;
}
async function deleteRecord() {
  const deletion = state.deletion; if (!deletion || state.operation || deletion.conflict) return;
  if (!deletion.pending) deletion.pending = { store_id: deletion.row.store_id, id: deletion.row.id, request_id: crypto.randomUUID(), expected_version: deletion.row.version };
  const pending = deletion.pending, operation = startOperation(deletion); notice('delete-message', '正在刪除，請稍候…');
  try {
    const data = await api('delete', pending, null, { signal: operation.controller.signal });
    if (state.deletion !== deletion || state.operation !== operation) return;
    if (data.deleted !== true || data.id !== pending.id || data.store_id !== pending.store_id) throw new ApiError('刪除回應不完整。');
    finishOperation(operation); closeDeletion(true); await loadRecords({ success: '外送記錄已刪除，統計與匯出已更新。' });
  } catch (error) { mutationError(deletion, 'deletion', error); }
  finally { finishOperation(operation); }
}

function closeViewer() {
  if (state.viewer) state.viewer.controller?.abort(); state.viewer = null;
  const image = $('photo-image'); image.onload = null; image.onerror = null; image.removeAttribute('src'); image.hidden = true;
  $('photo-title').textContent = '外送單據'; $('photo-message').textContent = ''; $('retry-photo').hidden = true; hideDialog('photo-dialog');
}
async function viewPhoto(row, retry = false) {
  if (!retry && !canOpenAction()) return;
  closeViewer(); const viewer = { row, controller: new AbortController() }; state.viewer = viewer;
  $('photo-title').textContent = `外送單據 · ${row.unit_name}`; $('photo-message').textContent = '正在讀取單據…'; showDialog('photo-dialog');
  try {
    const data = await api('photo', { store_id: row.store_id, id: row.id }, null, { signal: viewer.controller.signal });
    if (state.viewer !== viewer) return;
    let url; try { url = new URL(data.url); } catch { throw new ApiError('照片連結無效，請重新讀取。'); }
    if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/storage/v1/object/sign/delivery-photos/') || url.username || url.password) throw new ApiError('照片連結無效，請重新讀取。');
    const image = $('photo-image');
    image.onload = () => { if (state.viewer === viewer) { image.hidden = false; $('photo-message').textContent = `${ALLOWED_STORES[row.store_id]} · ${taipeiDateTime(row.delivered_at).replace('T', ' ')}`; } };
    image.onerror = () => { if (state.viewer === viewer) { image.hidden = true; $('photo-message').textContent = '照片暫時無法顯示，請重新讀取。'; $('retry-photo').hidden = false; } };
    image.src = url.href;
  } catch (error) { if (state.viewer === viewer) { $('photo-message').textContent = error.message || '照片讀取失敗。'; $('retry-photo').hidden = false; } }
}

async function exportRecords() {
  if (!state.loaded || !state.filtered.length || mainBusy()) return;
  try { requireSession(); } catch { return; }
  const token = state.token, generation = state.session, records = state.filtered.map(row => ({ ...row }));
  const meta = { month: state.scope.month, storeLabel: ALLOWED_STORES[state.scope.storeId] || '全部門市', search: $('search').value.trim(), vehicleLabel: VEHICLE_FILTER_LABELS[$('vehicle-filter').value], sortLabel: `${SORT_LABELS[$('sort-by').value]}（${$('sort-direction').value === 'asc' ? '升冪' : '降冪'}）`, exportedAt: new Date() };
  state.exporting = true; syncControls();
  try {
    const bytes = await createDeliveryWorkbook(records, meta);
    if (!isSameSession(token, generation)) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const anchor = element('a'); anchor.href = url; anchor.download = deliveryExportFilename(meta); anchor.hidden = true; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000); notice('message', `已匯出目前篩選的全部 ${records.length} 筆外送紀錄。`, 'success');
  } catch (error) { if (isSameSession(token, generation)) notice('message', error.message || 'Excel 產生失敗，請重試。', 'error'); }
  finally { if (state.session === generation) { state.exporting = false; syncControls(); } }
}

$('month').value = taipeiDateTime().slice(0, 7);
$('login-form').addEventListener('submit', login);
$('login-retry').addEventListener('click', () => { void loadRecords(); });
$('logout').addEventListener('click', () => { if (confirmDiscard()) invalidateSession('已登出主管帳號。'); });
$('query-form').addEventListener('submit', event => { event.preventDefault(); if (!mainBusy()) void loadRecords(); });
for (const id of ['month', 'store-filter']) $(id).addEventListener('change', () => { if (!mainBusy()) void loadRecords(); });
for (const id of ['search', 'vehicle-filter', 'sort-by', 'sort-direction']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { if (!mainBusy()) renderRecords(true); });
document.querySelectorAll('th [data-sort]').forEach(button => button.addEventListener('click', () => {
  if (mainBusy()) return;
  if ($('sort-by').value === button.dataset.sort) $('sort-direction').value = $('sort-direction').value === 'asc' ? 'desc' : 'asc';
  else { $('sort-by').value = button.dataset.sort; $('sort-direction').value = 'asc'; }
  renderRecords(true);
}));
$('previous-page').addEventListener('click', () => { if (!mainBusy() && state.page > 1) { state.page -= 1; renderRecords(); } });
$('next-page').addEventListener('click', () => { if (!mainBusy() && state.page * PAGE_SIZE < state.filtered.length) { state.page += 1; renderRecords(); } });
$('new-record').addEventListener('click', () => openEditor());
$('export').addEventListener('click', () => { void exportRecords(); });
$('rows').addEventListener('click', event => {
  const button = event.target.closest('button[data-action]'); if (!button || button.disabled || !canOpenAction()) return;
  const row = state.records.find(item => item.id === button.dataset.id); if (!row) return;
  if (button.dataset.action === 'edit') openEditor(row);
  else if (button.dataset.action === 'delete') openDeletion(row);
  else if (button.dataset.action === 'attach') openAttachment(row);
  else if (button.dataset.action === 'photo') void viewPhoto(row);
});
$('editor-form').addEventListener('input', event => {
  const editor = state.editor; if (!editor || editor.pending || editor.conflict) return;
  editor.dirty = true;
  if (event.target.id === 'edit-address') addressChanged();
  else if (event.target.id === 'edit-distance') useManualDistance();
  else { if (event.target.id && $(`${event.target.id}-error`)) { event.target.removeAttribute('aria-invalid'); $(`${event.target.id}-error`).hidden = true; } syncControls(); }
});
$('edit-store').addEventListener('change', addressChanged);
$('edit-address').addEventListener('blur', () => { if (state.editor?.distance.status === 'scheduled') void calculateDistance(); else scheduleDistance(); });
$('manual-distance').addEventListener('click', () => useManualDistance(true));
$('calculate-distance').addEventListener('click', () => { void calculateDistance(true); });
$('editor-form').addEventListener('submit', saveEditor);
$('reload-editor').addEventListener('click', async () => {
  const rowId = state.editor?.row?.id; if (!closeEditor()) return;
  if (await loadRecords()) { const row = state.records.find(item => item.id === rowId); if (row) openEditor(row); else notice('message', '已讀取最新資料；原紀錄已刪除或不在目前月份。'); }
});
for (const id of ['close-editor', 'cancel-editor']) $(id).addEventListener('click', () => closeEditor());
for (const id of ['close-attachment', 'cancel-attachment']) $(id).addEventListener('click', () => closeAttachment());
for (const id of ['close-delete', 'cancel-delete']) $(id).addEventListener('click', () => closeDeletion());
$('close-photo').addEventListener('click', closeViewer);
$('retry-photo').addEventListener('click', () => { if (state.viewer) void viewPhoto(state.viewer.row, true); });
$('attachment-form').addEventListener('submit', saveAttachment);
$('confirm-delete').addEventListener('click', () => { void deleteRecord(); });
for (const [id, close] of [['editor-dialog', closeEditor], ['attachment-dialog', closeAttachment], ['delete-dialog', closeDeletion], ['photo-dialog', closeViewer]]) $(id).addEventListener('cancel', event => { event.preventDefault(); close(); });
for (const kind of ['editor', 'attachment']) {
  for (const source of ['camera', 'gallery']) {
    $(`${kind}-${source}`).addEventListener('click', () => { const owner = state[kind]; if (owner && !owner.pending && !owner.conflict && !owner.photo.busy && !state.operation) $(`${kind}-${source}-input`).click(); });
    $(`${kind}-${source}-input`).addEventListener('change', event => { const file = event.target.files?.[0]; if (file) void pickPhoto(kind, file); });
  }
  $(`${kind}-clear-photo`).addEventListener('click', () => { const owner = state[kind]; if (owner && !owner.pending && !owner.conflict && !state.operation) { clearPhoto(kind); syncControls(); } });
}
document.querySelector('.back-link').addEventListener('click', event => {
  if (!confirmDiscard()) { event.preventDefault(); return; }
  closeEditor(true); closeAttachment(true); closeDeletion(true); closeViewer();
});
window.addEventListener('beforeunload', event => { if (unconfirmedWork()) { event.preventDefault(); event.returnValue = ''; } });
function checkSession() { if (state.token && storedToken() !== state.token) invalidateSession('主管登入已變更，請重新登入。', false); }
window.addEventListener('focus', checkSession);
window.addEventListener('storage', event => { if (event.key === SESSION_KEY || event.key === null) checkSession(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); });
state.token = storedToken();
syncControls();
if (state.token) void loadRecords();
