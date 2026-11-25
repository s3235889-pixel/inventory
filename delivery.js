import { ALLOWED_STORES, DEFAULT_DELIVERY_ADDRESS, isCountyPrefixOnly, vehicleTypeLabel, taipeiDateTime, isValidMonth, validateFields, isAllowedSession } from './delivery-core.mjs?v=20261125-vehicle1';

const API = 'https://rjetwgrelmvciatouwiw.supabase.co/functions/v1/delivery-api';
const PHOTO_ORIGIN = 'https://rjetwgrelmvciatouwiw.supabase.co';
const STORE_ORIGINS = Object.freeze({ 1: '屏東縣潮州鎮文化路42號', 2: '屏東縣潮州鎮東華路25號' });
const $ = id => document.getElementById(id);
const fields = { unit_name: 'unit-name', address: 'address', courier: 'courier', vehicle_type: 'vehicle-type', delivered_at: 'delivered-at', amount: 'amount', distance_km: 'distance-km' };
const numberFormat = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
const format = value => Number.isFinite(Number(value)) ? numberFormat.format(Number(value)) : '—';
const state = {
  session: null, loaded: false, listReady: false, loading: false, mutating: false,
  records: [], month: taipeiDateTime().slice(0, 7), page: 0, totalCount: 0, hasMore: false,
  newId: crypto.randomUUID(), dirty: false, signature: '', conflict: false,
  pendingSave: null, photo: null, photoURL: '', photoBusy: false, photoError: '',
  photoVersion: 0, loadVersion: 0, viewerVersion: 0, viewerId: null,
  distanceService: null, distanceVersion: 0, distanceTimer: null, distanceController: null,
  distanceStatus: 'idle', distanceAddress: '', distanceAttemptedAddress: '', distanceResult: null, distanceError: '',
  attachmentRow: null, attachmentVersion: 0, attachmentPhoto: null, attachmentPhotoURL: '',
  attachmentPhotoBusy: false, attachmentPhotoError: '', attachmentPending: null,
  attachmentUploading: false, attachmentLocked: false, attachmentController: null,
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

function setHistoryMessage(message, kind = '') {
  $('history-message').textContent = message;
  $('history-message').className = `message ${kind}`.trim();
  $('history-message').hidden = !message;
}

function setAttachmentMessage(message, kind = '') {
  $('attach-message').textContent = message;
  $('attach-message').className = `message ${kind}`.trim();
  $('attach-message').hidden = !message;
}

function setGate(message, { login = true, retry = false } = {}) {
  $('workspace').hidden = true;
  $('access-gate').hidden = false;
  $('access-message').textContent = message;
  $('access-login').hidden = !login;
  $('access-retry').hidden = !retry;
}

function fieldValue(field, id = fields[field]) {
  return field === 'vehicle_type' ? document.querySelector('input[name="vehicle_type"]:checked')?.value || '' : $(id).value;
}

function clearFieldError(id) {
  $(id).removeAttribute('aria-invalid');
  if (id === 'vehicle-type') document.querySelectorAll('#vehicle-type input').forEach(el => el.removeAttribute('aria-invalid'));
  $(`${id}-error`).hidden = true;
  $(`${id}-error`).textContent = '';
}

function clearErrors() {
  for (const id of Object.values(fields)) clearFieldError(id);
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
  resetDistance();
  state.distanceService = null;
  clearNewPhoto();
  closeViewer();
  closeAttachment({ force: true });
  $('delivery-form').reset();
  $('history-body').replaceChildren();
  $('store-name').textContent = '';
  for (const id of ['total-count', 'total-amount', 'total-distance']) $(id).textContent = '—';
  setMessage('');
  setHistoryMessage('');
  clearErrors();
  setGate(message);
}

function handleFailure(error) {
  if (error.status === 403 && ['record_locked', 'photo_locked'].includes(error.code)) return false;
  if (error.status === 401 || error.status === 403) {
    const message = error.message || '門市登入已失效。';
    invalidateSession(error.status === 401
      ? `${message} 尚未儲存的內容已清除，請回叫貨系統重新登入後再填寫。`
      : message);
    return true;
  }
  return false;
}

function busy() { return state.loading || state.mutating || state.attachmentUploading; }

function distancePending() { return state.distanceStatus === 'scheduled' || state.distanceStatus === 'loading'; }

function cancelDistanceWork() {
  state.distanceVersion++;
  if (state.distanceTimer !== null) clearTimeout(state.distanceTimer);
  state.distanceTimer = null;
  state.distanceController?.abort();
  state.distanceController = null;
  if (distancePending()) state.distanceStatus = 'idle';
}

function resetDistance() {
  cancelDistanceWork();
  state.distanceStatus = 'idle';
  state.distanceAddress = '';
  state.distanceAttemptedAddress = '';
  state.distanceResult = null;
  state.distanceError = '';
}

function configureDistanceService(service) {
  const origin = STORE_ORIGINS[Number(state.session?.store_id)] || '';
  const available = service?.available === true && service.origin_address === origin
    && service.mode === 'scooter' && service.provider === 'geoapify';
  if (state.distanceService && (state.distanceService.available !== available || state.distanceService.origin_address !== origin)) cancelDistanceWork();
  state.distanceService = { available, origin_address: origin, mode: 'scooter', provider: 'geoapify' };
}

function syncDistanceControls() {
  const service = state.distanceService;
  const address = $('address').value.trim();
  const origin = service?.origin_address || STORE_ORIGINS[Number(state.session?.store_id)];
  $('distance-origin').textContent = origin ? `出發門市：${origin}` : '正在確認出發門市…';
  let message;
  if (!state.loaded) message = '正在確認自動計算服務…';
  else if (!service?.available) message = '自動計算尚未啟用，可先手動填寫公里數';
  else if (state.pendingSave) message = '本次送出使用的距離已保留，重試不會重新計算。';
  else if (state.distanceStatus === 'loading') message = '正在計算機車單程道路距離…可按「手動填寫」停止等待。';
  else if (state.distanceStatus === 'scheduled') message = '地址輸入完成後將自動估算距離，也可直接手動填寫。';
  else if (state.distanceStatus === 'error') message = `${state.distanceError} 請確認地址後重新計算，或手動填寫公里數。`;
  else if (state.distanceStatus === 'success') message = `預估 ${Number(state.distanceResult.distance_km).toFixed(2)} 公里 · 對應地址：${state.distanceResult.matched_address}`;
  else if (state.distanceStatus === 'manual') message = '目前使用手動公里數；修改外送地址後，會清除舊值並重新估算。';
  else message = '輸入完整外送地址，停留約 1 秒或離開地址欄位後，將自動估算距離。';
  $('distance-feedback').textContent = message;
  $('distance-feedback').className = `distance-feedback${state.distanceStatus === 'error' ? ' error' : ''}`;
  $('distance-attribution').hidden = !state.distanceResult;
  $('recalculate-distance').disabled = busy() || !state.loaded || !service?.available || !address || isCountyPrefixOnly(address) || !!state.pendingSave || state.conflict || state.distanceStatus === 'loading';
  $('manual-distance').disabled = busy() || !state.loaded || !!state.pendingSave || state.conflict;
  $('distance-km').setAttribute('aria-busy', String(distancePending()));
}

function scheduleDistance() {
  const address = $('address').value.trim();
  if (busy() || !state.loaded || !state.distanceService?.available || !address || isCountyPrefixOnly(address) || state.pendingSave || state.conflict
    || distancePending() || state.distanceStatus === 'manual' || state.distanceAttemptedAddress === address) return;
  state.distanceStatus = 'scheduled';
  state.distanceTimer = setTimeout(() => { state.distanceTimer = null; void calculateDistance(); }, 1000);
  syncControls();
}

function addressChanged() {
  const address = $('address').value.trim();
  if (address !== state.distanceAddress) {
    cancelDistanceWork();
    state.distanceAddress = address;
    state.distanceAttemptedAddress = '';
    state.distanceResult = null;
    state.distanceError = '';
    state.distanceStatus = 'idle';
    $('distance-km').value = '';
    $('distance-km').removeAttribute('aria-invalid');
    $('distance-km-error').hidden = true;
  }
  markChanged();
  scheduleDistance();
}

function useManualDistance() {
  cancelDistanceWork();
  state.distanceStatus = 'manual';
  state.distanceResult = null;
  state.distanceError = '';
  state.distanceAttemptedAddress = $('address').value.trim();
}

async function calculateDistance({ force = false } = {}) {
  if (state.distanceTimer !== null) clearTimeout(state.distanceTimer);
  state.distanceTimer = null;
  if (state.distanceStatus === 'scheduled') state.distanceStatus = 'idle';
  const address = $('address').value.trim();
  if (busy() || !state.loaded || !state.distanceService?.available || !address || isCountyPrefixOnly(address) || state.pendingSave || state.conflict
    || state.distanceStatus === 'loading' || !force && (state.distanceStatus === 'manual' || state.distanceAttemptedAddress === address)) {
    syncControls();
    return;
  }
  cancelDistanceWork();
  const request = state.distanceVersion;
  const sessionToken = state.session.token;
  const storeId = Number(state.session.store_id);
  const origin = state.distanceService.origin_address;
  const controller = new AbortController();
  state.distanceController = controller;
  state.distanceStatus = 'loading';
  state.distanceAttemptedAddress = address;
  state.distanceResult = null;
  state.distanceError = '';
  $('distance-km').value = '';
  markChanged();
  try {
    const data = await api('distance', { address }, null, { signal: controller.signal, timeoutMs: 20000 });
    if (request !== state.distanceVersion || !sameSession() || state.session.token !== sessionToken || Number(state.session.store_id) !== storeId
      || $('address').value.trim() !== address || state.distanceService?.origin_address !== origin || state.mutating || state.pendingSave) return;
    if (typeof data.distance_km !== 'number' || !Number.isFinite(data.distance_km) || data.distance_km < 0 || data.distance_km > 99999.99
      || data.address !== address || data.origin_address !== origin || data.mode !== 'scooter' || data.provider !== 'geoapify'
      || typeof data.matched_address !== 'string' || !data.matched_address.trim()) {
      throw new ApiError('距離回應不完整，尚未填入公里數。', 0, 'distance_invalid_response');
    }
    state.distanceResult = data;
    state.distanceStatus = 'success';
    $('distance-km').value = data.distance_km.toFixed(2);
    $('distance-km').removeAttribute('aria-invalid');
    $('distance-km-error').hidden = true;
    markChanged();
  } catch (error) {
    if (request !== state.distanceVersion) return;
    if (!String(error.code || '').startsWith('distance_') && handleFailure(error)) return;
    state.distanceStatus = 'error';
    state.distanceError = error.message || '暫時無法計算距離。';
  } finally {
    if (request === state.distanceVersion) {
      state.distanceController = null;
      if (state.distanceStatus === 'loading') state.distanceStatus = 'idle';
      syncControls();
    }
  }
}

function syncControls() {
  const blocked = busy();
  document.querySelectorAll('#delivery-form input, #delivery-form textarea, #delivery-form button').forEach(el => { el.disabled = blocked; });
  for (const id of ['history-month', 'refresh', 'access-retry', 'reload-conflict']) $(id).disabled = blocked;
  $('save').disabled = blocked || !state.loaded || state.photoBusy || !!state.photoError || state.conflict || distancePending();
  $('save').textContent = state.mutating ? '儲存中…' : state.photoBusy ? '照片處理中…' : '儲存外送記錄';
  $('save-hint').textContent = state.photoError ? '請重新選照片或取消新照片' : distancePending() ? '正在估算距離，可改用手動填寫' : state.dirty ? '有尚未儲存的內容' : '金額以新台幣記錄';
  $('delivery-form').setAttribute('aria-busy', String(state.mutating || state.photoBusy || distancePending()));
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
    ? '照片會隨資料一併上傳，成功後僅供查看，不能更換或移除。'
    : '每筆可附一張照片，也可先儲存資料，再從紀錄補傳單據。';
  syncDistanceControls();
  syncAttachmentControls();
}

function signature() {
  return JSON.stringify([...Object.keys(fields).map(field => field === 'address' && isCountyPrefixOnly(fieldValue(field)) ? DEFAULT_DELIVERY_ADDRESS : fieldValue(field)), state.photoVersion]);
}

function markChanged() {
  state.dirty = signature() !== state.signature;
  state.pendingSave = null;
  if (!state.conflict) setMessage('');
  syncControls();
}

function resetForm({ courier = '' } = {}) {
  clearNewPhoto();
  resetDistance();
  state.newId = crypto.randomUUID();
  state.pendingSave = null;
  state.conflict = false;
  $('delivery-form').reset();
  $('address').value = DEFAULT_DELIVERY_ADDRESS;
  state.distanceAddress = DEFAULT_DELIVERY_ADDRESS;
  $('courier').value = courier;
  $('delivered-at').value = taipeiDateTime();
  $('form-mode').textContent = '新增外送';
  $('form-title').textContent = '記下一筆外送';
  clearErrors();
  state.signature = signature();
  state.dirty = false;
  syncControls();
}

async function api(action, body = {}, form = null, { signal, timeoutMs } = {}) {
  if (!sameSession()) throw new ApiError('門市登入已變更，請回叫貨系統確認登入後再開啟外送記錄。', 403);
  const sessionToken = state.session.token;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs || (form ? 45000 : 25000));
  let response;
  try {
    response = await fetch(API, {
      method: 'POST', headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${sessionToken}` },
      body: form || JSON.stringify({ action, ...body }), signal: controller.signal,
    });
  } catch (error) {
    throw new ApiError(action === 'attach_photo'
      ? '連線中斷，尚無法確認補傳結果。這張照片已保留，請按「重試補傳」，系統會避免重複上傳。'
      : action === 'save'
      ? '連線中斷，尚無法確認這次儲存結果。輸入與照片已保留，請保持內容不變並再按儲存，系統會避免重複記錄。'
      : error.name === 'AbortError' ? action === 'distance' ? '距離計算逾時，尚未填入公里數。' : '連線逾時，請檢查網路後重試。' : '無法連上雲端，請檢查網路後重試。');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  if (!sameSession() || state.session.token !== sessionToken) throw new ApiError('門市登入已變更，請回叫貨系統重新開啟外送記錄。', 403);
  let data;
  try { data = await response.json(); }
  catch { throw new ApiError(action === 'attach_photo' ? '伺服器回應不完整，尚無法確認補傳結果。這張照片已保留，請按「重試補傳」。' : action === 'save' ? '伺服器回應不完整，尚無法確認儲存結果。請保留輸入並重試。' : '伺服器回應不完整，請稍後再試。', response.status); }
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
    const courierCell = element('td', 'record-courier');
    courierCell.dataset.label = '外送人員';
    const vehicle = element('span', 'record-vehicle', vehicleTypeLabel(row.vehicle_type));
    vehicle.setAttribute('aria-label', `使用車輛：${vehicleTypeLabel(row.vehicle_type)}`);
    courierCell.append(element('span', 'courier-name', row.courier), vehicle);
    const amountCell = element('td', 'record-number', `${format(row.amount)} 元`);
    amountCell.dataset.label = '金額';
    const distanceCell = element('td', 'record-number', `${format(row.distance_km)} 公里`);
    distanceCell.dataset.label = '距離';
    const actionCell = document.createElement('td');
    const actions = element('div', 'record-actions');
    if (row.has_photo) actions.append(recordButton('查看單據', 'photo', row, 'photo'));
    else actions.append(element('span', 'no-photo', '未附單據'), recordButton('補傳單據', 'attach', row, 'photo'));
    actionCell.append(actions);
    tr.append(dateCell, unitCell, courierCell, amountCell, distanceCell, actionCell);
    $('history-body').append(tr);
  }
  $('table-wrap').hidden = state.records.length === 0;
  $('list-state').hidden = state.records.length > 0;
  $('list-state').className = 'list-state';
  $('list-state').textContent = '這個月份還沒有外送紀錄。填寫上方資料即可新增；上傳後僅供查詢。';
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
    configureDistanceService(data.distance_service);
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
    $('history-description').textContent = `${month.replace('-', ' 年 ')} 月 · 統計涵蓋全部 ${format(data.total_count)} 筆紀錄，日期時間皆為台灣時間。資料不能編輯或刪除；未附單據可補傳一張照片，已有單據僅供查看。`;
    renderRecords();
    return true;
  } catch (error) {
    if (request !== state.loadVersion) return false;
    if (handleFailure(error)) return false;
    clearList(`${error.message} 目前無法確認此月份的紀錄，請按「重新讀取」。`, true);
    if (initial || !state.loaded) setGate(error.message, { retry: true });
    return false;
  } finally {
    if (request === state.loadVersion) { state.loading = false; syncControls(); scheduleDistance(); }
  }
}

function confirmDiscard(message = '目前內容尚未儲存，確定放棄這份草稿？') {
  return !state.dirty && !state.photoBusy || window.confirm(message);
}

async function saveRecord(event) {
  event.preventDefault();
  if (busy() || !state.loaded || state.photoBusy || state.photoError || state.conflict || distancePending()) return;
  clearErrors();
  const raw = Object.fromEntries(Object.keys(fields).map(field => [field, fieldValue(field)]));
  const validation = validateFields(raw);
  if (!validation.ok) {
    for (const [field, error] of Object.entries(validation.errors)) {
      const id = fields[field];
      $(id).setAttribute('aria-invalid', 'true');
      if (field === 'vehicle_type') document.querySelectorAll('#vehicle-type input').forEach(el => el.setAttribute('aria-invalid', 'true'));
      $(`${id}-error`).textContent = error;
      $(`${id}-error`).hidden = false;
    }
    const firstField = Object.keys(validation.errors)[0];
    $(firstField === 'vehicle_type' ? 'vehicle-personal' : fields[firstField]).focus();
    setMessage('請確認標示的欄位，再儲存這筆外送。', 'error');
    return;
  }
  const photoNotice = state.photo
    ? '單據照片將一併上傳，之後不能更換或移除。'
    : '本次未附單據；之後可從紀錄補傳一張照片，成功後不能更換或移除。';
  if (!window.confirm(`確認上傳「${validation.value.unit_name}」？\n使用車輛：${vehicleTypeLabel(validation.value.vehicle_type)}\n\n資料上傳後僅供查詢，所有欄位都不能編輯或刪除。\n${photoNotice}\n請確認資料無誤後再上傳。`)) return;
  cancelDistanceWork();
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
    const photoMessage = hadPhoto
      ? '單據照片已一併上傳，不能更換或移除。'
      : data.record.has_photo === true ? '這筆已有單據，可從紀錄查看，不能更換或移除。' : '本筆未附單據，可從紀錄補傳一張照片。';
    const savedMonth = taipeiDateTime(data.record.delivered_at).slice(0, 7);
    resetForm({ courier: payload.courier });
    if (isValidMonth(savedMonth)) { state.month = savedMonth; $('history-month').value = savedMonth; }
    state.page = 0;
    const refreshed = await loadList();
    if (state.session) setMessage(`外送記錄已上傳並鎖定，資料僅供查詢，不能編輯或刪除。${photoMessage}${refreshed ? '' : '\n清單暫時無法更新，請稍後按「重新讀取」查看。'}`, refreshed ? '' : 'info');
  } catch (error) {
    if (!handleFailure(error)) {
      if (error.status === 409 || error.status === 403 && error.code === 'record_locked') state.conflict = true;
      setMessage(error.message, 'error');
    }
  } finally { state.mutating = false; syncControls(); }
}

async function prepareReceiptPhoto(file, isCurrent) {
  let originalURL = '';
  try {
    if (file.size === 0 || file.size > 30 * 1024 * 1024) throw new Error('請選擇 30MB 以內且內容完整的照片。');
    if (file.type && !/^image\/(?:jpeg|png|webp|heic|heif)$/i.test(file.type)) throw new Error('請選擇 JPG、PNG 或 WebP 照片。');
    originalURL = URL.createObjectURL(file);
    const image = new Image();
    image.src = originalURL;
    await image.decode();
    if (!image.width || !image.height) throw new Error('這張照片無法讀取。');
    if (!isCurrent()) return null;
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
    if (!isCurrent()) return null;
    if (!photo || photo.size === 0 || photo.size > 8 * 1024 * 1024) throw new Error('照片縮小後仍超過 8MB，請換較小照片或截圖。');
    return photo;
  } finally { if (originalURL) URL.revokeObjectURL(originalURL); }
}

async function pickPhoto(file) {
  if (!file || busy()) return;
  clearNewPhoto();
  const version = state.photoVersion;
  state.photoBusy = true;
  state.pendingSave = null;
  state.dirty = true;
  syncControls();
  try {
    const photo = await prepareReceiptPhoto(file, () => version === state.photoVersion && !!state.session);
    if (!photo) return;
    state.photo = photo;
    state.photoURL = URL.createObjectURL(photo);
    $('photo-preview').src = state.photoURL;
    state.photoError = '';
  } catch (error) {
    if (version === state.photoVersion) state.photoError = `照片尚未加入：${error.message} 若是 HEIC 照片，請先截圖或轉為 JPG 後再選取。`;
  } finally {
    if (version === state.photoVersion) { state.photoBusy = false; state.dirty = true; syncControls(); }
  }
}

function clearAttachmentPhoto() {
  state.attachmentVersion++;
  state.attachmentPhoto = null;
  state.attachmentPhotoBusy = false;
  state.attachmentPhotoError = '';
  state.attachmentPending = null;
  if (state.attachmentPhotoURL) URL.revokeObjectURL(state.attachmentPhotoURL);
  state.attachmentPhotoURL = '';
  $('attach-preview').removeAttribute('src');
  $('attach-camera-input').value = '';
  $('attach-gallery-input').value = '';
}

function syncAttachmentControls() {
  const blocked = state.loading || state.mutating || state.attachmentUploading;
  const photoLocked = blocked || !!state.attachmentPending || state.attachmentLocked;
  for (const id of ['attach-take-photo', 'attach-choose-photo', 'attach-camera-input', 'attach-gallery-input', 'clear-attach-photo']) $(id).disabled = photoLocked;
  $('confirm-attach').disabled = blocked || !state.attachmentRow || !state.attachmentPhoto || state.attachmentPhotoBusy || !!state.attachmentPhotoError || state.attachmentLocked;
  $('confirm-attach').textContent = state.attachmentUploading ? '補傳中…' : state.attachmentLocked ? '無法再補傳' : state.attachmentPending ? '重試補傳' : '確認補傳';
  $('attach-preview-wrap').hidden = !state.attachmentPhotoURL;
  $('clear-attach-photo').hidden = !state.attachmentPhoto && !state.attachmentPhotoBusy && !state.attachmentPhotoError;
  $('attach-photo-feedback').textContent = state.attachmentPhotoBusy ? '正在整理照片，完成後即可補傳…' : state.attachmentPhotoError;
  $('attach-photo-feedback').className = `photo-feedback${state.attachmentPhotoError ? ' error' : ''}`;
  $('attach-photo-feedback').hidden = !state.attachmentPhotoBusy && !state.attachmentPhotoError;
  $('attach-form').setAttribute('aria-busy', String(state.attachmentUploading || state.attachmentPhotoBusy));
}

function closeAttachment({ force = false } = {}) {
  if (!force && (state.attachmentPhoto || state.attachmentPhotoBusy || state.attachmentPending || state.attachmentUploading)) {
    const question = state.attachmentUploading
      ? '補傳仍在進行，關閉不一定能取消伺服器上傳。關閉後請重新讀取紀錄確認，確定關閉？'
      : state.attachmentPending && !state.attachmentLocked
        ? '這次補傳結果尚未確認。關閉會清除待傳照片，請重新讀取紀錄確認；確定關閉？'
        : '關閉會取消這張尚未補傳的照片，確定關閉？';
    if (!window.confirm(question)) return false;
  }
  state.attachmentController?.abort();
  state.attachmentController = null;
  clearAttachmentPhoto();
  state.attachmentRow = null;
  state.attachmentUploading = false;
  state.attachmentLocked = false;
  $('attach-summary').replaceChildren();
  setAttachmentMessage('');
  if (typeof $('attach-dialog').close === 'function') $('attach-dialog').close();
  else $('attach-dialog').removeAttribute('open');
  syncControls();
  scheduleDistance();
  return true;
}

function openAttachment(row) {
  if (busy() || !row || row.has_photo) return;
  if (state.attachmentRow && !closeAttachment()) return;
  clearAttachmentPhoto();
  state.attachmentRow = { ...row };
  state.attachmentLocked = false;
  setAttachmentMessage('');
  setHistoryMessage('');
  $('attach-summary').replaceChildren();
  for (const [label, value] of [
    ['外送單位', row.unit_name], ['外送地址', row.address], ['外送人員', row.courier], ['使用車輛', vehicleTypeLabel(row.vehicle_type)],
    ['日期與時間', taipeiDateTime(row.delivered_at).replace('T', ' ')], ['金額', `${format(row.amount)} 元`], ['距離', `${format(row.distance_km)} 公里`],
  ]) {
    const item = element('div', 'attachment-detail');
    item.append(element('dt', '', label), element('dd', '', value));
    $('attach-summary').append(item);
  }
  syncControls();
  if (typeof $('attach-dialog').showModal === 'function') $('attach-dialog').showModal();
  else $('attach-dialog').setAttribute('open', '');
}

async function pickAttachmentPhoto(file) {
  if (!file || busy() || !state.attachmentRow || state.attachmentPending || state.attachmentLocked) return;
  clearAttachmentPhoto();
  const version = state.attachmentVersion;
  state.attachmentPhotoBusy = true;
  setAttachmentMessage('');
  syncAttachmentControls();
  try {
    const photo = await prepareReceiptPhoto(file, () => version === state.attachmentVersion && !!state.attachmentRow && !!state.session);
    if (!photo) return;
    state.attachmentPhoto = photo;
    state.attachmentPhotoURL = URL.createObjectURL(photo);
    $('attach-preview').src = state.attachmentPhotoURL;
  } catch (error) {
    if (version === state.attachmentVersion) state.attachmentPhotoError = `照片尚未加入：${error.message} 若是 HEIC 照片，請先截圖或轉為 JPG 後再選取。`;
  } finally {
    if (version === state.attachmentVersion) { state.attachmentPhotoBusy = false; syncAttachmentControls(); }
  }
}

async function attachPhoto(event) {
  event.preventDefault();
  if (busy() || !state.attachmentRow || !state.attachmentPhoto || state.attachmentPhotoBusy || state.attachmentPhotoError || state.attachmentLocked) return;
  if (!state.attachmentPending) state.attachmentPending = {
    action: 'attach_photo', id: state.attachmentRow.id, request_id: crypto.randomUUID(), expected_version: state.attachmentRow.version,
  };
  const payload = state.attachmentPending;
  const version = ++state.attachmentVersion;
  const controller = new AbortController();
  state.attachmentController = controller;
  state.attachmentUploading = true;
  const form = new FormData();
  form.set('payload', JSON.stringify(payload));
  form.set('photo', state.attachmentPhoto, 'delivery-receipt.jpg');
  setAttachmentMessage('正在補傳單據，請稍候…', 'info');
  syncControls();
  try {
    const data = await api('attach_photo', {}, form, { signal: controller.signal, timeoutMs: 45000 });
    if (version !== state.attachmentVersion) return;
    if (!data.record || data.record.id !== payload.id || data.record.has_photo !== true || !Number.isInteger(data.record.version) || data.record.version <= payload.expected_version) {
      throw new ApiError('尚未收到完整的補傳確認，照片已保留。請按「重試補傳」。');
    }
    state.records = state.records.map(row => row.id === payload.id ? data.record : row);
    renderRecords();
    const unitName = data.record.unit_name;
    closeAttachment({ force: true });
    setHistoryMessage(`「${unitName}」的單據已補傳並鎖定，成功後不能更換或移除。外送資料維持不變。`);
  } catch (error) {
    if (version !== state.attachmentVersion || handleFailure(error)) return;
    state.attachmentLocked = ['photo_locked', 'record_locked'].includes(error.code) || [404, 409].includes(error.status);
    setAttachmentMessage(state.attachmentLocked
      ? `${error.message}\n這張待傳照片仍保留在視窗。請關閉後重新讀取紀錄確認。`
      : `${error.message}${error.message.includes('已保留') ? '' : '\n照片已保留，請按「重試補傳」。'}`, 'error');
  } finally {
    if (version === state.attachmentVersion) {
      state.attachmentUploading = false;
      state.attachmentController = null;
      syncControls();
      scheduleDistance();
    }
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
  const id = event.target.name === 'vehicle_type' ? 'vehicle-type' : event.target.id;
  if (Object.values(fields).includes(id)) clearFieldError(id);
  if (id === 'address') { addressChanged(); return; }
  if (id === 'distance-km') useManualDistance();
  markChanged();
});
$('address').addEventListener('blur', () => { void calculateDistance(); });
$('recalculate-distance').addEventListener('click', () => { void calculateDistance({ force: true }); });
$('manual-distance').addEventListener('click', () => {
  if (busy() || !state.loaded || state.pendingSave || state.conflict) return;
  useManualDistance(); syncControls(); $('distance-km').focus();
});
$('take-photo').addEventListener('click', () => $('camera-input').click());
$('choose-photo').addEventListener('click', () => $('gallery-input').click());
for (const id of ['camera-input', 'gallery-input']) $(id).addEventListener('change', () => { void pickPhoto($(id).files?.[0]); });
$('clear-photo').addEventListener('click', () => { clearNewPhoto(); markChanged(); });
$('attach-form').addEventListener('submit', attachPhoto);
$('attach-take-photo').addEventListener('click', () => $('attach-camera-input').click());
$('attach-choose-photo').addEventListener('click', () => $('attach-gallery-input').click());
for (const id of ['attach-camera-input', 'attach-gallery-input']) $(id).addEventListener('change', () => { void pickAttachmentPhoto($(id).files?.[0]); });
$('clear-attach-photo').addEventListener('click', () => {
  if (busy() || state.attachmentPending || state.attachmentLocked) return;
  clearAttachmentPhoto(); setAttachmentMessage(''); syncAttachmentControls();
});
for (const id of ['close-attachment', 'cancel-attach']) $(id).addEventListener('click', () => { closeAttachment(); });
$('attach-dialog').addEventListener('cancel', event => { event.preventDefault(); closeAttachment(); });
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
  if (button.dataset.action === 'photo') void viewPhoto(row);
  if (button.dataset.action === 'attach') openAttachment(row);
});
$('close-photo').addEventListener('click', closeViewer);
$('photo-dialog').addEventListener('cancel', event => { event.preventDefault(); closeViewer(); });
$('retry-photo').addEventListener('click', () => {
  const row = state.records.find(record => record.id === state.viewerId);
  if (row) void viewPhoto(row);
});

window.addEventListener('beforeunload', event => {
  if (state.dirty || state.mutating || state.photoBusy || state.attachmentPhoto || state.attachmentPhotoBusy || state.attachmentUploading) { event.preventDefault(); event.returnValue = ''; }
});
document.querySelectorAll('a[href="index.html"]').forEach(link => link.addEventListener('click', event => {
  if (state.mutating) { event.preventDefault(); return; }
  if (!confirmDiscard('外送資料尚未儲存，確定放棄修改並回叫貨系統？')) event.preventDefault();
  else { state.dirty = false; clearNewPhoto(); cancelDistanceWork(); }
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
