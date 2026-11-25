import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import { createDeliveryWorkbook, deliveryExportFilename } from '../delivery-export.mjs';

function unzip(bytes) {
  assert.ok(bytes instanceof Uint8Array);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), files = new Map();
  let cursor = 0;
  while (view.getUint32(cursor, true) === 0x04034b50) {
    assert.equal(view.getUint16(cursor + 8, true), 0);
    const length = view.getUint32(cursor + 18, true), nameLength = view.getUint16(cursor + 26, true), extra = view.getUint16(cursor + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 30, cursor + 30 + nameLength));
    const start = cursor + 30 + nameLength + extra, data = bytes.subarray(start, start + length);
    assert.equal(crc32(data), view.getUint32(cursor + 14, true), name);
    files.set(name, new TextDecoder().decode(data));
    cursor = start + length;
  }
  assert.equal(view.getUint32(cursor, true), 0x02014b50);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 12, true), files.size);
  assert.equal(view.getUint32(bytes.length - 6, true), cursor);
  return files;
}

const record = (overrides = {}) => ({
  store_id: 1, unit_name: '測試單位', address: '屏東縣潮州鎮測試路1號', courier: '測試人員',
  delivered_at: '2026-11-25T01:23:00Z', vehicle_type: 'personal', amount: 120.5, distance_km: 1.25, has_photo: false,
  ...overrides,
});
const sheetFor = records => unzip(createDeliveryWorkbook(records, { month: '2026-11', exportedAt: '2026-11-25T00:00:00Z' })).get('xl/worksheets/sheet1.xml');

test('a true XLSX ZIP contains related workbook, sheet and styles with valid CRCs', () => {
  const files = unzip(createDeliveryWorkbook([record()]));
  assert.equal(files.size, 6);
  assert.match(files.get('[Content_Types].xml'), /spreadsheetml\.sheet\.main\+xml/);
  assert.match(files.get('xl/_rels/workbook.xml.rels'), /Target="worksheets\/sheet1.xml"/);
  assert.match(files.get('xl/styles.xml'), /formatCode="yyyy\/mm\/dd hh:mm"/);
  assert.match(files.get('xl/workbook.xml'), /sheet name="外送記錄"/);
});

test('all supplied filtered rows are exported in order, including records beyond page 50', () => {
  const records = Array.from({ length: 103 }, (_, i) => record({ unit_name: `單位-${103 - i}` }));
  const sheet = sheetFor(records);
  assert.equal((sheet.match(/<row /g) || []).length, 108);
  assert.match(sheet, /r="D5"[^>]*><is><t[^>]*>單位-103<\/t>/);
  assert.match(sheet, /r="D107"[^>]*><is><t[^>]*>單位-1<\/t>/);
  assert.match(sheet, /<autoFilter ref="A4:J107"/);
  assert.match(sheet, /<f>SUM\(H5:H107\)<\/f><v>12411\.5<\/v>/);
  assert.match(sheet, /ySplit="4" topLeftCell="A5"/);
});

test('numeric amounts and kilometre values retain native number types and exact cent totals', () => {
  const sheet = sheetFor([record({ amount: 0.1, distance_km: 0.2 }), record({ amount: '0.20', distance_km: '0.10' })]);
  assert.match(sheet, /<c r="H5" s="4"><v>0\.1<\/v><\/c>/);
  assert.match(sheet, /<c r="H7" s="6"><f>SUM\(H5:H6\)<\/f><v>0\.3<\/v>/);
  assert.match(sheet, /<c r="I7" s="6"><f>SUM\(I5:I6\)<\/f><v>0\.3<\/v>/);
});

test('delivery dates become Taiwan-local Excel serial numbers across a year boundary', () => {
  const sheet = sheetFor([record({ delivered_at: '2026-12-31T16:05:00Z' })]);
  const number = Number(/<c r="C5" s="5"><v>([^<]+)<\/v>/.exec(sheet)[1]);
  assert.ok(Math.abs(number - (46388 + 5 / 1440)) < 0.000000001);
  assert.match(sheetFor([record({ delivered_at: '1900-01-01T00:00:00+08:00' })]), /<c r="C5" s="5"><v>1<\/v>/);
});

test('untrusted spreadsheet text stays literal and invalid XML controls are removed', () => {
  const sheet = sheetFor([record({ unit_name: '=HYPERLINK("https://example.test","x")', address: '+<script>&\u0001_x0041_😀', courier: '@SUM(1,2)' })]);
  assert.match(sheet, /<c r="D5" s="3" t="inlineStr"><is><t[^>]*>=HYPERLINK\(&quot;/);
  assert.match(sheet, /\+&lt;script&gt;&amp;_x005F_x0041_😀/);
  assert.match(sheet, />@SUM\(1,2\)<\/t>/);
  assert.ok(!sheet.includes('\u0001'));
  assert.equal((sheet.match(/<f>/g) || []).length, 2);
});

test('legacy vehicle data and attachment status are displayed without exporting private paths', () => {
  const sheet = sheetFor([record({ store_id: 2, vehicle_type: null, has_photo: true, photo_path: 'private-secret-path', token: 'secret-token' })]);
  assert.match(sheet, /木崎\(C2\)/); assert.match(sheet, /未記錄/); assert.match(sheet, /已附/);
  assert.ok(!sheet.includes('private-secret-path')); assert.ok(!sheet.includes('secret-token'));
});

test('empty results produce a valid zero-total sheet without circular sums', () => {
  const sheet = sheetFor([]);
  assert.match(sheet, /共 0 筆/); assert.match(sheet, /<c r="H5" s="6"><v>0<\/v>/);
  assert.ok(!sheet.includes('<f>'));
});

test('malformed values are rejected instead of silently exporting incorrect totals', () => {
  for (const amount of [null, undefined, '', ' ', '1e2', NaN, Infinity, -1, 0.001]) assert.throws(() => sheetFor([record({ amount })]));
  for (const store_id of [0, 3, '1']) assert.throws(() => sheetFor([record({ store_id })]));
  assert.throws(() => sheetFor([record({ delivered_at: null })]));
  assert.throws(() => sheetFor([record({ has_photo: 'false' })]));
  assert.throws(() => sheetFor(Array(10001).fill(record())));
});

test('export metadata identifies the filters and filenames are safe on common platforms', () => {
  const files = unzip(createDeliveryWorkbook([record()], { month: '2026-11', storeLabel: '潮州店', search: '配送', vehicleLabel: '自用車', sortLabel: '金額：由高到低', exportedAt: '2026-11-25T00:00:00Z' }));
  const sheet = files.get('xl/worksheets/sheet1.xml');
  for (const expected of ['月份：2026-11', '門市：潮州店', '關鍵字：配送', '車輛：自用車', '排序：金額：由高到低', '2026-11-25 08:00']) assert.ok(sheet.includes(expected), expected);
  assert.equal(deliveryExportFilename({ month: '2026-11', storeLabel: '潮州/木崎' }), '外送記錄_2026-11_潮州_木崎.xlsx');
});
