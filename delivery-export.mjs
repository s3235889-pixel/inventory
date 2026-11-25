import { ALLOWED_STORES, taipeiDateTime, vehicleTypeLabel } from './delivery-core.mjs?v=20261125-vehicle1';

// A small, dependency-free SpreadsheetML package. User values are always inline
// strings, never formulas; dates, amounts and kilometres are native Excel numbers.
const encoder = new TextEncoder();
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const MONEY_MAX = 99999999.99;
const DISTANCE_MAX = 99999.99;

function xmlText(value) {
  return String(value ?? '')
    .replace(/_x[0-9a-f]{4}_/gi, match => `_x005F_${match.slice(1)}`)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function textCell(ref, text, style = 3) {
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

function numberCell(ref, number, style = 4) {
  if (!Number.isFinite(number)) throw new Error('匯出資料包含無效數字，請重新載入。');
  return `<c r="${ref}" s="${style}"><v>${number}</v></c>`;
}

function decimal(value, max, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === ''
      || (typeof value === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(value))) {
    throw new Error(`${label}格式不正確，請重新載入後再匯出。`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max
      || Math.abs(number * 100 - Math.round(number * 100)) > 0.00001) {
    throw new Error(`${label}格式不正確，請重新載入後再匯出。`);
  }
  return Math.round(number * 100);
}

function excelDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new Error('外送日期格式不正確，請重新載入後再匯出。');
  }
  const local = taipeiDateTime(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match || Number(match[1]) < 1900) throw new Error('外送日期超出可匯出範圍。');
  const [, year, month, day, hour, minute] = match.map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  // Excel includes the fictitious 1900-02-29 in its 1900 date system.
  return (utc - Date.UTC(1899, 11, 31)) / 86400000 + (utc >= Date.UTC(1900, 2, 1) ? 1 : 0);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, initial) => {
  let value = initial;
  for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const chunks = [], directory = [];
  let offset = 0;
  for (const [filename, content] of files) {
    const name = encoder.encode(filename), data = encoder.encode(content), crc = crc32(data);
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); lv.setUint16(12, 0x21, true); // UTF-8, stored, 1980-01-01.
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); central.set(name, 46);
    chunks.push(local, data); directory.push(central); offset += local.length + data.length;
  }
  const directorySize = directory.reduce((total, item) => total + item.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true); ev.setUint32(16, offset, true);
  const output = new Uint8Array(offset + directorySize + end.length);
  let written = 0;
  for (const chunk of [...chunks, ...directory, end]) { output.set(chunk, written); written += chunk.length; }
  return output;
}

const STYLES = `${XML}<styleSheet xmlns="${NS}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy/mm/dd hh:mm"/><numFmt numFmtId="165" formatCode="#,##0.00;[Red](#,##0.00);0.00"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Microsoft JhengHei"/><color rgb="FF1E293B"/></font><font><b/><sz val="18"/><name val="Microsoft JhengHei"/><color rgb="FF0F172A"/></font><font><b/><sz val="11"/><name val="Microsoft JhengHei"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="11"/><name val="Microsoft JhengHei"/><color rgb="FF0F766E"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0FDFA"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="hair"><color rgb="FFE2E8F0"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="165" fontId="3" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Export every supplied record in the supplied (filtered and sorted) order. */
export function createDeliveryWorkbook(records, meta = {}) {
  if (!Array.isArray(records) || records.length > 10000) throw new Error('匯出資料不完整或超過 10,000 筆，請縮小查詢範圍。');
  const exportedAt = taipeiDateTime(meta.exportedAt ?? new Date());
  const scope = [meta.month && `月份：${meta.month}`, `門市：${meta.storeLabel || '全部門市'}`,
    meta.search && `關鍵字：${meta.search}`, meta.vehicleLabel && `車輛：${meta.vehicleLabel}`,
    meta.sortLabel && `排序：${meta.sortLabel}`, `匯出：${exportedAt.replace('T', ' ')}（台灣時間）`].filter(Boolean).join('　｜　');
  const headers = ['序號', '門市', '外送日期與時間（台灣時間）', '外送單位名稱', '外送地址', '外送人員', '使用車輛', '金額（元）', '距離（公里）', '單據狀態'];
  const rows = [
    `<row r="1" ht="32" customHeight="1">${textCell('A1', '外送記錄', 1)}</row>`,
    `<row r="2" ht="42" customHeight="1">${textCell('A2', scope, 8)}</row>`,
    `<row r="3" ht="24" customHeight="1">${textCell('A3', `共 ${records.length} 筆　｜　金額：新台幣　｜　距離：單程公里`, 8)}</row>`,
    `<row r="4" ht="34" customHeight="1">${headers.map((label, col) => textCell(`${String.fromCharCode(65 + col)}4`, label, 2)).join('')}</row>`,
  ];
  let amountCents = 0, distanceHundredths = 0;
  records.forEach((record, index) => {
    if (!record || !Number.isInteger(record.store_id) || !Object.hasOwn(ALLOWED_STORES, record.store_id)) throw new Error('匯出資料包含無效門市。');
    if (![null, 'personal', 'store'].includes(record.vehicle_type ?? null)) throw new Error('匯出資料包含無效車輛類別。');
    if (typeof record.has_photo !== 'boolean') throw new Error('匯出資料包含無效單據狀態。');
    for (const key of ['unit_name', 'address', 'courier']) {
      if (typeof record[key] !== 'string') throw new Error('匯出資料不完整，請重新載入。');
    }
    const row = index + 5, amount = decimal(record.amount, MONEY_MAX, '金額'), distance = decimal(record.distance_km, DISTANCE_MAX, '距離');
    amountCents += amount; distanceHundredths += distance;
    rows.push(`<row r="${row}" ht="36" customHeight="1">${[
      numberCell(`A${row}`, index + 1, 3), textCell(`B${row}`, ALLOWED_STORES[record.store_id]),
      numberCell(`C${row}`, excelDate(record.delivered_at), 5), textCell(`D${row}`, record.unit_name),
      textCell(`E${row}`, record.address), textCell(`F${row}`, record.courier),
      textCell(`G${row}`, vehicleTypeLabel(record.vehicle_type)), numberCell(`H${row}`, amount / 100),
      numberCell(`I${row}`, distance / 100), textCell(`J${row}`, record.has_photo ? '已附' : '未附'),
    ].join('')}</row>`);
  });
  const lastData = records.length + 4, totalRow = lastData + 1;
  const totalCell = (column, value) => records.length
    ? `<c r="${column}${totalRow}" s="6"><f>SUM(${column}5:${column}${lastData})</f><v>${value}</v></c>`
    : numberCell(`${column}${totalRow}`, 0, 6);
  rows.push(`<row r="${totalRow}" ht="28" customHeight="1">${textCell(`A${totalRow}`, '合計', 7)}${textCell(`B${totalRow}`, `${records.length} 筆`, 7)}${totalCell('H', amountCents / 100)}${totalCell('I', distanceHundredths / 100)}</row>`);
  const widths = [7, 17, 25, 28, 48, 18, 14, 18, 17, 13];
  const sheet = `${XML}<worksheet xmlns="${NS}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:J${totalRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A5" sqref="A5"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="20"/><cols>${widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.join('')}</sheetData><autoFilter ref="A4:J${lastData}"/><mergeCells count="3"><mergeCell ref="A1:J1"/><mergeCell ref="A2:J2"/><mergeCell ref="A3:J3"/></mergeCells><printOptions horizontalCentered="1"/><pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  return zip([
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><bookViews><workbookView/></bookViews><sheets><sheet name="外送記錄" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'外送記錄'!$4:$4</definedName></definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES], ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

export function deliveryExportFilename({ month, storeLabel } = {}) {
  const safe = value => String(value || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim().slice(0, 80);
  return `外送記錄_${safe(month) || '查詢結果'}_${safe(storeLabel) || '全部門市'}.xlsx`;
}
