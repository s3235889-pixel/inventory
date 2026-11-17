import { MEATS, taipeiToday, shiftDate, isValidDate, readPortions, calculateUsage, forecast, validateDay } from './meat-core.mjs?v=20261117';

const API = 'https://rjetwgrelmvciatouwiw.supabase.co/functions/v1/meat-inventory-api';
const $ = id => document.getElementById(id);
const FIELDS = ['closing', 'thaw', 'extra', 'waste', 'target'];
const state = {
  session: null, records: [], date: taipeiToday(), today: taipeiToday(),
  original: null, dirty: false, busy: false, loaded: false, conflict: false,
  signature: '', pendingSave: null
};
const numberFormat = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 1 });
const displayNumber = value => Number.isFinite(value) ? numberFormat.format(value) : '—';
const getRow = date => state.records.find(row => row.business_date === date) || null;
const shortDate = date => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

function cardMarkup({ id, name }, index) {
  return `<article class="meat-card" aria-labelledby="${id}-title">
    <div class="meat-card-head"><h2 id="${id}-title">${name}</h2><span class="meat-code">0${index + 1} / 份</span></div>
    <div class="meat-body">
      <div class="opening"><span>今天可用</span><strong id="${id}-available">—</strong></div>
      <div class="opening-detail" id="${id}-opening-detail">由昨晚冷藏與退冰自動帶入</div>
      <label class="field-label" for="${id}-closing">① 今晚冷藏剩餘 <small>退冰前先盤</small></label>
      <div class="input-wrap"><input id="${id}-closing" name="${id}-closing" type="number" min="0" max="10000" step="0.1" inputmode="decimal" required placeholder="請填盤點份數" aria-describedby="${id}-usage-note"><span>份</span></div>
      <div class="usage" id="${id}-usage-box"><span>今日使用</span><strong><span id="${id}-usage">—</span><small>份</small></strong></div>
      <p class="usage-note" id="${id}-usage-note">先填今晚冷藏剩餘</p>
      <details class="adjustments"><summary>今日臨時追加退冰／耗損（沒有則填 0）</summary>
        <div class="adjustments-grid">
          <label for="${id}-extra">今日追加退冰<div class="input-wrap"><input id="${id}-extra" name="${id}-extra" type="number" min="0" max="10000" step="0.1" inputmode="decimal" value="0"><span>份</span></div></label>
          <label for="${id}-waste">今日耗損<div class="input-wrap"><input id="${id}-waste" name="${id}-waste" type="number" min="0" max="10000" step="0.1" inputmode="decimal" value="0"><span>份</span></div></label>
        </div>
        <p class="small-note">追加退冰是今天臨時補用的肉；耗損另計，不列入今日使用。</p>
      </details>
      <div class="forecast-box">
        <div class="forecast-label">明天怎麼備？</div>
        <div class="forecast-line"><span>建議今晚退冰</span><strong><span id="${id}-suggested">—</span><small>份</small></strong></div>
        <p class="forecast-source" id="${id}-forecast-source">累積用量後自動預估</p>
        <div class="target-row"><label for="${id}-target">明日預計用量<br>留白使用平均，可自行調整</label><div class="input-wrap"><input id="${id}-target" name="${id}-target" type="number" min="0" max="10000" step="0.1" inputmode="decimal" placeholder="自動"><span>份</span></div></div>
        <button type="button" class="apply-button" id="${id}-apply">填入建議退冰</button>
      </div>
      <label class="field-label" for="${id}-thaw">② 今晚退冰 <small>供明天使用</small></label>
      <div class="input-wrap"><input id="${id}-thaw" name="${id}-thaw" type="number" min="0" max="10000" step="0.1" inputmode="decimal" required placeholder="實際從冷凍拿出份數"><span>份</span></div>
      <div class="next-available"><span>明天可用 <span id="${id}-next-date"></span></span><strong><span id="${id}-next">—</span> 份</strong></div>
    </div>
  </article>`;
}
$('meat-cards').innerHTML = MEATS.map(cardMarkup).join('');

function setMessage(text, kind = '') {
  $('message').textContent = text;
  $('message').className = `message ${kind}`.trim();
  $('message').hidden = !text;
}

function setGate(text, { login = true, retry = false } = {}) {
  $('workspace').hidden = true;
  $('access-gate').hidden = false;
  $('access-message').textContent = text;
  $('access-login').hidden = !login;
  $('access-retry').hidden = !retry;
}

function setBusy(value) {
  state.busy = value;
  document.querySelectorAll('#inventory-form input, #inventory-form textarea, #inventory-form button, .date-bar button, .date-bar input, #export, #reload-conflict, #access-retry').forEach(element => { element.disabled = value; });
  document.querySelectorAll('#history-body button').forEach(element => { element.disabled = value; });
  $('save').textContent = value ? '處理中…' : '儲存今晚盤點';
  $('inventory-form').setAttribute('aria-busy', String(value));
  if (!value && state.loaded) updateCalculations();
}

class ApiError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

async function api(action, body = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  let response;
  try {
    response = await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.session.token}` },
      body: JSON.stringify({ action, ...body }), signal: controller.signal
    });
  } catch (error) {
    throw new ApiError(action === 'save'
      ? '連線中斷，尚無法確認這次儲存結果。畫面內容已保留，可按儲存再次確認；系統會避免重複記錄。'
      : (error.name === 'AbortError' ? '連線逾時，請檢查網路後重試。' : '無法連上雲端，請檢查網路後重試。'));
  } finally { clearTimeout(timeout); }
  let data;
  try { data = await response.json(); }
  catch { throw new ApiError(action === 'save' ? '伺服器回應不完整，尚無法確認儲存結果。請保留輸入並重試。' : '伺服器回應不完整，請稍後再試。', response.status); }
  if (!response.ok) throw new ApiError(data.error || data.message || '操作未完成，請稍後重試。', response.status);
  return data;
}

function currentDraft() {
  const meats = {};
  for (const { id } of MEATS) {
    meats[id] = {};
    for (const field of FIELDS) {
      const input = $(`${id}-${field}`);
      const raw = input.value;
      const parsed = field === 'target' && raw.trim() === '' ? null : readPortions(raw, { optional: field === 'extra' || field === 'waste' });
      // Keep invalid input distinguishable from an intentional blank or zero.
      meats[id][field] = input.validity.badInput ? NaN : (raw.trim() !== '' && parsed === null ? raw : parsed);
    }
  }
  return { business_date: state.date, meats, note: $('day-note').value, version: state.original?.version || 0 };
}

function formSignature() {
  return JSON.stringify([...MEATS.flatMap(({ id }) => FIELDS.map(field => $(`${id}-${field}`).value)), $('day-note').value]);
}

function markChanged() {
  state.dirty = formSignature() !== state.signature;
  state.pendingSave = null;
  if (!state.conflict) setMessage('');
  updateCalculations();
}

function updateCalculations() {
  const draft = currentDraft();
  const previous = getRow(shiftDate(state.date, -1));
  for (const { id } of MEATS) {
    const result = calculateUsage(previous, draft, id);
    const suggestion = forecast(state.records, state.date, id, draft);
    $(`${id}-available`).textContent = Number.isFinite(result.available) ? `${displayNumber(result.available)} 份` : (previous ? '待確認' : '待昨日資料');
    const prior = previous?.meats?.[id];
    $(`${id}-opening-detail`).textContent = prior
      ? `昨晚冷藏 ${displayNumber(prior.closing)} ＋ 昨晚退冰 ${displayNumber(prior.thaw)}${draft.meats[id].extra ? ` ＋ 今日追加 ${displayNumber(draft.meats[id].extra)}` : ''}`
      : '缺少前一天盤點；本次儲存後，可作為明天的基準。';
    $(`${id}-usage`).textContent = displayNumber(result.usage);
    $(`${id}-usage-box`).classList.toggle('invalid', result.status === 'invalid');
    $(`${id}-usage-note`).classList.toggle('error', result.status === 'invalid');
    if (result.status === 'invalid') {
      $(`${id}-usage-note`).textContent = '盤點數字不一致，請確認冷藏、今日追加退冰及耗損。';
    } else if (!previous) {
      $(`${id}-usage-note`).textContent = '今日用量待昨日資料，不會以 0 計入平均。';
    } else if (Number.isFinite(result.usage)) {
      $(`${id}-usage-note`).textContent = '今天可用 − 今晚冷藏剩餘 − 今日耗損';
    } else {
      $(`${id}-usage-note`).textContent = '請填今晚冷藏剩餘，沒有剩餘請填 0。';
    }
    $(`${id}-next`).textContent = displayNumber(result.nextAvailable);
    $(`${id}-next-date`).textContent = `(${shortDate(shiftDate(state.date, 1))})`;
    $(`${id}-suggested`).textContent = displayNumber(suggestion.suggested);
    let source;
    if ($(`${id}-target`).validity.badInput || ($(`${id}-target`).value.trim() !== '' && readPortions($(`${id}-target`).value) === null)) {
      source = '明日預計用量請填 0～10,000，最多小數一位。';
    } else if (suggestion.source === 'manual') {
      source = `手動預計 ${displayNumber(suggestion.target)} 份，扣除今晚冷藏後向上取整。`;
    } else if (suggestion.samples > 0) {
      source = `近 7 天 ${suggestion.samples} 筆有效用量，平均 ${displayNumber(suggestion.average)} 份；預計備 ${displayNumber(suggestion.target)} 份。`;
    } else {
      source = '尚無有效用量，請先填「明日預計用量」或自行決定退冰份數。';
    }
    if (suggestion.target !== null && draft.meats[id].closing === null) source += ' 請先填冷藏剩餘。';
    $(`${id}-forecast-source`).textContent = source;
    $(`${id}-target`).placeholder = Number.isFinite(suggestion.average) ? displayNumber(Math.ceil(suggestion.average)) : '自動';
    $(`${id}-apply`).disabled = state.busy || !Number.isFinite(suggestion.suggested);
  }
  const originalTime = state.original?.updated_at;
  let savedText = '尚無這天的盤點紀錄';
  if (originalTime) {
    const timestamp = new Date(originalTime);
    savedText = Number.isFinite(timestamp.getTime())
      ? `已儲存 · ${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(timestamp)}`
      : '已有這天的盤點紀錄';
  }
  $('record-status').textContent = state.dirty ? '內容已修改，尚未儲存' : savedText;
  $('record-status').classList.toggle('dirty', state.dirty);
  $('save-hint').textContent = state.conflict ? '請先重新讀取雲端資料' : (state.dirty ? '尚未儲存 · 三種肉一次存' : '三種肉一次儲存');
  $('save').disabled = state.busy || state.conflict || !state.loaded;
  $('next-day').disabled = state.busy || state.date >= state.today;
  $('previous-day').disabled = state.busy || state.date <= '1900-01-01';
  $('export').disabled = state.busy || !monthRows().length;
  $('date-context').textContent = `為 ${shortDate(shiftDate(state.date, 1))} 備料`;
}

function fillForm() {
  const row = state.original;
  for (const { id } of MEATS) {
    for (const field of FIELDS) {
      const value = row?.meats?.[id]?.[field];
      $(`${id}-${field}`).value = value === null || value === undefined ? (field === 'extra' || field === 'waste' ? '0' : '') : String(value);
    }
  }
  $('day-note').value = row?.note || '';
  $('business-date').value = state.date;
  $('business-date').max = state.today;
  state.signature = formSignature();
  state.dirty = false;
  state.pendingSave = null;
  state.conflict = false;
  $('conflict').hidden = true;
  updateCalculations();
}

function monthRows() {
  return state.records.filter(row => row.business_date.startsWith(state.date.slice(0, 7))).sort((a, b) => b.business_date.localeCompare(a.business_date));
}

function renderHistory() {
  const rows = monthRows();
  const label = `${state.date.slice(0, 4)} 年 ${Number(state.date.slice(5, 7))} 月`;
  $('history-title').textContent = `${label}用量`;
  $('month-summary').replaceChildren();
  for (const { id, name } of MEATS) {
    const usages = rows.map(row => calculateUsage(getRow(shiftDate(row.business_date, -1)), row, id)).filter(result => result.status === 'ok' && Number.isFinite(result.usage) && result.usage >= 0);
    const total = Math.round(usages.reduce((sum, result) => sum + result.usage, 0) * 10) / 10;
    const card = document.createElement('div'); card.className = 'summary-card';
    const title = document.createElement('h3'); title.textContent = name;
    const amount = document.createElement('strong'); amount.textContent = usages.length ? displayNumber(total) : '—';
    const unit = document.createElement('small'); unit.textContent = '份'; amount.append(unit);
    const count = document.createElement('p'); count.textContent = `${usages.length} 天有效用量`;
    card.append(title, amount, count); $('month-summary').append(card);
  }
  const body = $('history-body'); body.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr'); const td = document.createElement('td');
    td.colSpan = 5; td.className = 'empty-history'; td.textContent = '這個月還沒有盤點紀錄，先儲存第一天吧。'; tr.append(td); body.append(tr);
  }
  for (const row of rows) {
    const tr = document.createElement('tr'); tr.classList.toggle('selected', row.business_date === state.date);
    const dateCell = document.createElement('td'); const dateButton = document.createElement('button');
    dateButton.type = 'button'; dateButton.className = 'history-date'; dateButton.textContent = shortDate(row.business_date); dateButton.dataset.date = row.business_date;
    dateButton.setAttribute('aria-label', `查看 ${row.business_date} 盤點`); dateCell.append(dateButton); tr.append(dateCell);
    for (const { id } of MEATS) {
      const result = calculateUsage(getRow(shiftDate(row.business_date, -1)), row, id);
      const cell = document.createElement('td');
      cell.textContent = result.status === 'ok' && result.usage >= 0 ? displayNumber(result.usage) : (result.status === 'invalid' ? '待確認' : '—');
      if (result.status === 'invalid') cell.className = 'invalid-cell';
      tr.append(cell);
    }
    const action = document.createElement('td'); const open = document.createElement('button'); open.type = 'button'; open.className = 'history-open'; open.textContent = '查看'; open.dataset.date = row.business_date;
    open.setAttribute('aria-label', `查看 ${row.business_date} 盤點`); action.append(open); tr.append(action); body.append(tr);
  }
  $('export').disabled = state.busy || !rows.length;
}

function acceptLoad(data, date) {
  if (Number(data.store_id) !== 2 || !Array.isArray(data.records) || !isValidDate(data.today)) throw new ApiError('門市驗證未完成，請回叫貨系統重新登入木崎。', 403);
  state.records = data.records;
  state.date = date;
  state.today = data.today;
  state.original = getRow(date);
  state.loaded = true;
  $('store-name').textContent = data.store_name;
  $('access-gate').hidden = true;
  $('workspace').hidden = false;
  fillForm(); renderHistory();
}

function handleAuthError(error) {
  if (error.status !== 401 && error.status !== 403) return false;
  state.loaded = false;
  setGate(error.status === 403 ? '此功能僅限木崎。請先回叫貨系統，使用木崎門市登入。' : '登入已逾時。請回叫貨系統重新驗證木崎門市。');
  return true;
}

async function loadDate(date, { initial = false } = {}) {
  if (state.busy) return;
  if (!isValidDate(date) || date < '1900-01-01' || date > state.today) {
    $('business-date').value = state.date;
    setMessage('請選擇今天或以前的有效盤點日期。', 'error');
    return;
  }
  if (!initial && state.dirty && !window.confirm('目前有尚未儲存的盤點。要放棄這些修改並讀取所選日期嗎？')) {
    $('business-date').value = state.date; return;
  }
  setBusy(true);
  if (initial) setGate('正在確認木崎登入，並讀取雲端盤點…', { login: false });
  else setMessage('正在讀取雲端盤點…', 'info');
  try {
    const data = await api('load', { date });
    acceptLoad(data, date); setMessage('');
  } catch (error) {
    $('business-date').value = state.date;
    if (!handleAuthError(error)) {
      if (initial) setGate(error.message, { retry: true });
      else setMessage(`${error.message}\n目前畫面的輸入仍保留。`, 'error');
    }
  } finally { setBusy(false); }
}

function validationErrors(draft) {
  const errors = [];
  const labels = { closing: '今晚冷藏剩餘', thaw: '今晚退冰', extra: '今日追加退冰', waste: '今日耗損', target: '明日預計用量' };
  for (const { id, name } of MEATS) {
    for (const field of FIELDS) {
      const input = $(`${id}-${field}`);
      if (input.validity.badInput || input.validity.rangeUnderflow || input.validity.rangeOverflow || input.validity.stepMismatch || (input.value.trim() !== '' && readPortions(input.value) === null)) {
        errors.push(`${name}「${labels[field]}」請填 0～10,000，最多小數一位。`);
      }
    }
  }
  errors.push(...validateDay(draft, getRow(shiftDate(state.date, -1)), getRow(shiftDate(state.date, 1))));
  if ($('day-note').value.length > 500) errors.push('備註請在 500 字以內。');
  return [...new Set(errors)];
}

function mergeSavedRecord(record) {
  state.records = [...state.records.filter(row => row.business_date !== record.business_date), record];
  state.original = record;
  fillForm(); renderHistory();
}

$('inventory-form').addEventListener('input', markChanged);
$('inventory-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy || !state.loaded || state.conflict) return;
  const draft = currentDraft();
  const errors = validationErrors(draft);
  if (errors.length) {
    setMessage(errors.join('\n'), 'error');
    $('message').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const body = { date: state.date, meats: draft.meats, note: draft.note.trim(), expected_version: state.original?.version || 0 };
  const bodyKey = JSON.stringify(body);
  if (!state.pendingSave || state.pendingSave.key !== bodyKey) state.pendingSave = { key: bodyKey, body: { ...body, request_id: crypto.randomUUID() } };
  const request = state.pendingSave.body;
  setBusy(true); setMessage('正在儲存三種肉的盤點…', 'info');
  try {
    const data = await api('save', request);
    if (!data.record || data.record.business_date !== state.date || !Number.isInteger(data.record.version)) throw new ApiError('未收到完整儲存確認，請保留目前輸入並重試。');
    mergeSavedRecord(data.record);
    setMessage('已儲存今晚盤點，三種肉的明日備量已更新。');
    try {
      const fresh = await api('load', { date: state.date });
      acceptLoad(fresh, state.date);
      setMessage('已儲存今晚盤點，三種肉的明日備量已更新。');
    } catch (refreshError) {
      if (!handleAuthError(refreshError)) setMessage(`盤點已成功儲存。\n最新歷史資料暫時無法重新讀取，可稍後按「重新讀取」。`, 'info');
    }
  } catch (error) {
    if (error.status === 409) {
      state.conflict = true; $('conflict').hidden = false;
      setMessage(error.message || '資料已更新，請重新讀取後再修改。', 'error');
    } else if (!handleAuthError(error)) setMessage(error.message, 'error');
  } finally { setBusy(false); }
});

for (const { id } of MEATS) {
  $(`${id}-apply`).addEventListener('click', () => {
    if (state.busy) return;
    const suggested = forecast(state.records, state.date, id, currentDraft()).suggested;
    if (!Number.isFinite(suggested)) return;
    $(`${id}-thaw`).value = String(suggested);
    markChanged();
  });
}
$('business-date').addEventListener('change', event => loadDate(event.target.value));
$('previous-day').addEventListener('click', () => loadDate(shiftDate(state.date, -1)));
$('next-day').addEventListener('click', () => loadDate(shiftDate(state.date, 1)));
$('go-today').addEventListener('click', () => { state.today = taipeiToday(); loadDate(state.today); });
$('refresh').addEventListener('click', () => loadDate(state.date));
$('reload-conflict').addEventListener('click', () => loadDate(state.date));
$('access-retry').addEventListener('click', () => loadDate(state.date, { initial: true }));
$('history-body').addEventListener('click', event => {
  const button = event.target.closest('button[data-date]');
  if (button && !state.busy) loadDate(button.dataset.date);
});

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
$('export').addEventListener('click', () => {
  if (state.busy) return;
  const rows = monthRows().slice().reverse();
  const csv = [['日期', '肉品', '昨日冷藏剩餘', '昨日退冰', '今日追加退冰', '今天可用', '今晚冷藏剩餘', '今日耗損', '今日使用', '今晚退冰（供明日）', '明天可用', '手動明日預計用量', '用量狀態', '備註', '儲存時間']];
  for (const row of rows) {
    const previous = getRow(shiftDate(row.business_date, -1));
    for (const { id, name } of MEATS) {
      const meat = row.meats[id], result = calculateUsage(previous, row, id);
      const labels = { ok: '有效', missing_previous: '缺少昨日盤點', incomplete: '欄位不完整', invalid: '數字待確認' };
      csv.push([row.business_date, name, previous?.meats?.[id]?.closing, previous?.meats?.[id]?.thaw, meat.extra, result.available, meat.closing, meat.waste, result.status === 'ok' ? result.usage : null, meat.thaw, result.nextAvailable, meat.target, labels[result.status] || '待確認', row.note, row.updated_at]);
    }
  }
  const blob = new Blob(['\uFEFF' + csv.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `木崎肉品庫存_${state.date.slice(0, 7)}.csv`; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  if (state.dirty) setMessage('已匯出雲端已儲存的紀錄；目前尚未儲存的修改不會包含在 CSV。', 'info');
});

window.addEventListener('beforeunload', event => {
  if (state.dirty || state.busy) { event.preventDefault(); event.returnValue = ''; }
});
document.querySelectorAll('a[href="index.html"]').forEach(link => link.addEventListener('click', event => {
  if (state.busy) { event.preventDefault(); return; }
  if (state.dirty) {
    if (!window.confirm('盤點還沒儲存，要放棄修改並回叫貨系統嗎？')) event.preventDefault();
    else state.dirty = false;
  }
}));

async function start() {
  try { state.session = JSON.parse(sessionStorage.getItem('receipt-session') || 'null'); }
  catch { state.session = null; }
  if (!state.session || Number(state.session.store_id) !== 2 || typeof state.session.token !== 'string' || !state.session.token) {
    setGate('請先回叫貨系統，使用木崎門市登入。'); return;
  }
  await loadDate(state.date, { initial: true });
}
start();
