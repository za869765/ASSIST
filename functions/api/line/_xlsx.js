// 最小 XLSX 產生器：純 JS、無依賴、在 Cloudflare Workers 可跑
// 全部 cell 用 inlineStr + text 格式（s="1"）避免 Excel 把 01234、超長數字、日期字串自動轉型失真

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[i] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// STORE（不壓縮）ZIP writer — 檔案筆數少、體積不大時足夠
function zipStore(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    const size = f.data.length;
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0, true);
    ldv.setUint16(8, 0, true);      // STORE
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, 0, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, size, true);
    ldv.setUint32(22, size, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    locals.push({ header: local, data: f.data });

    const cent = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cent.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    cent.set(nameBytes, 46);
    central.push(cent);
    offset += local.length + size;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralStart, true);

  const total = new Uint8Array(offset + centralSize + eocd.length);
  let pos = 0;
  for (const l of locals) { total.set(l.header, pos); pos += l.header.length; total.set(l.data, pos); pos += l.data.length; }
  for (const c of central) { total.set(c, pos); pos += c.length; }
  total.set(eocd, pos);
  return total;
}

function xmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function colLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// rows: string[][]，sheetName: string
// 回傳 Uint8Array（xlsx 檔內容）
export function buildXLSX(sheetName, rows) {
  const enc = new TextEncoder();
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEscape(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  // 樣式索引：
  //   1=預設(text)  2=標題(18pt 白字,深金底,置中)  3=區塊標題(12pt 白字,深藍底,置中)
  //   4=表頭(粗體,淺青底,邊框)                     5=資料列(邊框)
  //   6=合計列(粗體,淺金底,邊框)
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="49" formatCode="@"/></numFmts>
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><sz val="18"/><b/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><sz val="12"/><b/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><sz val="11"/><b/><color rgb="FF1F2937"/><name val="Calibri"/></font>
<font><sz val="11"/><b/><color rgb="FF78350F"/><name val="Calibri"/></font>
</fonts>
<fills count="6">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFB8860B"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFCCFBF1"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="3">
<border/>
<border><left style="thin"><color rgb="FF94A3B8"/></left><right style="thin"><color rgb="FF94A3B8"/></right><top style="thin"><color rgb="FF94A3B8"/></top><bottom style="thin"><color rgb="FF94A3B8"/></bottom></border>
<border><left style="medium"><color rgb="FFB8860B"/></left><right style="medium"><color rgb="FFB8860B"/></right><top style="medium"><color rgb="FFB8860B"/></top><bottom style="medium"><color rgb="FFB8860B"/></bottom></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="1" fillId="2" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="49" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="49" fontId="3" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="49" fontId="4" fillId="5" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
</cellXfs>
</styleSheet>`;

  // 分類每一列的樣式
  // 約定：
  //   row[0] 以 '■' 或 '任務：' 開頭 → 視為「區塊／標題列」
  //   緊跟在 '■' 列之後、且是多欄且無數字 → 視為「表頭列」
  //   row[0] 為 '合計' → 合計列
  //   其他有多欄內容 → 資料列
  const classify = (row, idx, prevStyle) => {
    const first = String(row[0] ?? '');
    if (idx === 0 && first.startsWith('任務：')) return 2; // 主標題
    if (first.startsWith('■')) return 3; // 區塊標題
    if (first === '合計') return 6;
    if (prevStyle === 3 && row.length > 1) return 4; // 表頭（區塊後第一列）
    if (row.length > 1) return 5; // 資料
    return 1;
  };

  // 估算欄寬
  const colMax = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const s = String(row[i] ?? '');
      let w = 0;
      for (const ch of s) w += ch.charCodeAt(0) > 127 ? 2 : 1;
      if (w > (colMax[i] || 0)) colMax[i] = w;
    }
  }
  // A4 直式：總寬控制在 ~78（A4 可用寬 ≒ 78 字元），等比縮放
  const rawWidths = colMax.map(w => Math.min(38, Math.max(8, w * 1.1 + 2)));
  const totalWidth = rawWidths.reduce((a, b) => a + b, 0);
  const A4_WIDTH = 78;
  const scale = totalWidth > A4_WIDTH ? (A4_WIDTH / totalWidth) : 1;
  const cols = rawWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${(w * scale).toFixed(1)}" customWidth="1"/>`).join('');

  // 最大欄數：用來把「主標題 / ■ 區塊標題」跨欄合併到滿版
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 1);
  const lastColLetter = colLetter(maxCols);

  const merges = [];
  let prevStyle = 0;
  const sheetRowsArr = rows.map((row, rIdx) => {
    const style = classify(row, rIdx, prevStyle);
    prevStyle = style;
    const r = rIdx + 1;
    const rowAttrs = style === 2 ? ` ht="28" customHeight="1"` : (style === 3 ? ` ht="22" customHeight="1"` : '');
    // 標題（style=2）與 ■ 區塊標題（style=3）：補空白 cell 讓整列套色、並登記跨欄合併置中
    let padded = row;
    if ((style === 2 || style === 3) && row.length < maxCols) {
      padded = row.concat(Array(maxCols - row.length).fill(''));
      merges.push(`A${r}:${lastColLetter}${r}`);
    }
    const cells = padded.map((v, cIdx) => {
      const ref = `${colLetter(cIdx + 1)}${r}`;
      const text = xmlEscape(v == null ? '' : String(v));
      return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${text}</t></is></c>`;
    }).join('');
    return `<row r="${r}"${rowAttrs}>${cells}</row>`;
  });
  const sheetRows = sheetRowsArr.join('');
  const mergeCellsXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    : '';

  // 凍結第 1 列（title）方便滾動
  const sheetPr = `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`;
  const frozen = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
  const sheetFormat = `<sheetFormatPr defaultRowHeight="18" x14ac:dyDescent="0.25"/>`;
  // A4 直式、等比縮到一頁寬、水平置中、邊界適中
  const pageMargins = `<pageMargins left="0.4" right="0.4" top="0.55" bottom="0.55" header="0.3" footer="0.3"/>`;
  const printOptions = `<printOptions horizontalCentered="1"/>`;
  const pageSetup = `<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">${sheetPr}${frozen}${sheetFormat}<cols>${cols}</cols><sheetData>${sheetRows}</sheetData>${mergeCellsXml}${printOptions}${pageMargins}${pageSetup}</worksheet>`;

  return zipStore([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
    { name: 'xl/styles.xml', data: enc.encode(styles) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) },
  ]);
}
