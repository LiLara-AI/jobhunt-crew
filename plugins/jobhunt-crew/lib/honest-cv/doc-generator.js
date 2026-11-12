'use strict';

/**
 * JobHunt Crew — Multi-Format Document Generator
 *
 * Implements:
 * 1. MiniZipBuilder: Pure Node.js in-memory PKZIP 2.0 archiver using zlib.deflateRawSync and zlib.crc32.
 * 2. DocxGenerator: OpenXML WordprocessingML document assembler with single-column ATS layout
 *    and native RTL Arabic (<w:bidi/>, <w:jc w:val="right"/>).
 * 3. PdfGenerator: Headless-browser print-to-PDF driver (system Chrome/Chromium/Edge)
 *    with a multi-page binary PDF 1.4 writer as graceful fallback.
 * 4. TemplateRenderer: {{path}} / {{#each}} HTML & markdown template rendering.
 * 5. DocGenerator: Public API facade.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ============================================================================
// 1. IN-MEMORY PKZIP 2.0 ARCHIVER (MiniZipBuilder)
// ============================================================================

class MiniZipBuilder {
  constructor() {
    this.entries = [];
  }

  /**
   * Adds a file entry to the in-memory archive.
   * @param {string} filename Relative path inside the zip archive
   * @param {Buffer|string} content Buffer or string content
   */
  addFile(filename, content) {
    const rawBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = typeof zlib.crc32 === 'function' ? zlib.crc32(rawBuffer) : this._calculateCrc32(rawBuffer);

    // Compress using raw DEFLATE
    let compressed = zlib.deflateRawSync(rawBuffer);
    let method = 8; // DEFLATE

    // If compressed size is larger, store uncompressed
    if (compressed.length >= rawBuffer.length) {
      compressed = rawBuffer;
      method = 0; // STORED
    }

    this.entries.push({
      filename: filename.replace(/\\/g, '/'),
      uncompressedSize: rawBuffer.length,
      compressedSize: compressed.length,
      crc,
      method,
      data: compressed
    });
  }

  /**
   * Compiles and returns the complete binary ZIP buffer.
   * @returns {Buffer}
   */
  build() {
    const localChunks = [];
    const centralChunks = [];
    let currentOffset = 0;

    for (const entry of this.entries) {
      const nameBuf = Buffer.from(entry.filename, 'utf8');

      // 1. Local File Header (30 bytes + name + data)
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0); // signature
      localHeader.writeUInt16LE(20, 4);         // version needed (2.0)
      localHeader.writeUInt16LE(0, 6);          // flags
      localHeader.writeUInt16LE(entry.method, 8);// compression method
      localHeader.writeUInt16LE(0, 10);         // mod time
      localHeader.writeUInt16LE(0, 12);         // mod date
      localHeader.writeUInt32LE(entry.crc, 14); // crc-32
      localHeader.writeUInt32LE(entry.compressedSize, 18);
      localHeader.writeUInt32LE(entry.uncompressedSize, 22);
      localHeader.writeUInt16LE(nameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28);         // extra len

      localChunks.push(localHeader, nameBuf, entry.data);

      // 2. Central Directory File Header (46 bytes + name)
      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0); // signature
      centralHeader.writeUInt16LE(20, 4);          // version made by
      centralHeader.writeUInt16LE(20, 6);          // version needed
      centralHeader.writeUInt16LE(0, 8);           // flags
      centralHeader.writeUInt16LE(entry.method, 10);
      centralHeader.writeUInt16LE(0, 12);          // mod time
      centralHeader.writeUInt16LE(0, 14);          // mod date
      centralHeader.writeUInt32LE(entry.crc, 16);
      centralHeader.writeUInt32LE(entry.compressedSize, 20);
      centralHeader.writeUInt32LE(entry.uncompressedSize, 24);
      centralHeader.writeUInt16LE(nameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30);          // extra len
      centralHeader.writeUInt16LE(0, 32);          // comment len
      centralHeader.writeUInt16LE(0, 34);          // disk start
      centralHeader.writeUInt16LE(0, 36);          // int attr
      centralHeader.writeUInt32LE(0, 38);          // ext attr
      centralHeader.writeUInt32LE(currentOffset, 42); // relative offset

      centralChunks.push(centralHeader, nameBuf);

      currentOffset += 30 + nameBuf.length + entry.data.length;
    }

    const centralDirectoryOffset = currentOffset;
    let centralDirectorySize = 0;
    for (const chunk of centralChunks) {
      centralDirectorySize += chunk.length;
    }

    // 3. End of Central Directory Record (22 bytes)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // signature
    eocd.writeUInt16LE(0, 4);          // disk number
    eocd.writeUInt16LE(0, 6);          // start disk
    eocd.writeUInt16LE(this.entries.length, 8);  // entries on disk
    eocd.writeUInt16LE(this.entries.length, 10); // total entries
    eocd.writeUInt32LE(centralDirectorySize, 12);
    eocd.writeUInt32LE(centralDirectoryOffset, 16);
    eocd.writeUInt16LE(0, 20);         // comment len

    return Buffer.concat([...localChunks, ...centralChunks, eocd]);
  }

  _calculateCrc32(buf) {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
    }
    return (crc ^ ~0) >>> 0;
  }
}

// Fallback CRC-32 Lookup Table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c;
}

// ============================================================================
// 2. OPENXML DOCX GENERATOR (DocxGenerator)
// ============================================================================

function escapeXml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildDocxXml(content, isArabicRtl = false) {
  let pPr = '';
  let rPr = '';
  const langAttr = isArabicRtl ? 'xml:lang="ar-SA"' : 'xml:lang="en-US"';

  if (isArabicRtl) {
    pPr = '<w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr>';
    rPr = '<w:rPr><w:rtl/><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/></w:rPr>';
  } else {
    pPr = '<w:pPr><w:jc w:val="left"/></w:pPr>';
    rPr = '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr>';
  }

  // Handle multi-line content
  const paragraphs = String(content)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const xmlParagraphs = paragraphs.length > 0
    ? paragraphs.map(p => `    <w:p>${pPr}<w:r>${rPr}<w:t>${escapeXml(p)}</w:t></w:r></w:p>`).join('\n')
    : `    <w:p>${pPr}<w:r>${rPr}<w:t>${escapeXml(content)}</w:t></w:r></w:p>`;

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<w:document ${langAttr} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`,
    `  <w:body>`,
    xmlParagraphs,
    `  </w:body>`,
    `</w:document>`
  ].join('\n');
}

class DocxGenerator {
  static createContentTypesXml() {
    return [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
      `  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
      `  <Default Extension="xml" ContentType="application/xml"/>`,
      `  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
      `  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
      `</Types>`
    ].join('\n');
  }

  static createRelsXml() {
    return [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
      `  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`,
      `</Relationships>`
    ].join('\n');
  }

  static createDocumentRelsXml() {
    return [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`,
      `  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
      `</Relationships>`
    ].join('\n');
  }

  static createStylesXml() {
    return [
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
      `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`,
      `  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">`,
      `    <w:name w:val="Normal"/>`,
      `    <w:rPr>`,
      `      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>`,
      `      <w:sz w:val="21"/>`,
      `    </w:rPr>`,
      `  </w:style>`,
      `</w:styles>`
    ].join('\n');
  }

  /**
   * Builds a complete .docx buffer from text or CV object.
   */
  static buildDocxBuffer(contentOrCv, isArabicRtl = false) {
    let textContent = '';
    if (typeof contentOrCv === 'string') {
      textContent = contentOrCv;
    } else if (contentOrCv && typeof contentOrCv === 'object') {
      const parts = [];
      if (contentOrCv.candidate) {
        parts.push(contentOrCv.candidate.name || 'Candidate');
        if (contentOrCv.candidate.currentTitle) parts.push(contentOrCv.candidate.currentTitle);
        if (contentOrCv.candidate.summary) parts.push(contentOrCv.candidate.summary);
      }
      if (Array.isArray(contentOrCv.claims)) {
        for (const c of contentOrCv.claims) {
          parts.push(`- ${c.text}`);
        }
      }
      if (contentOrCv.content) {
        parts.push(contentOrCv.content);
      }
      textContent = parts.join('\n');
    }

    const documentXml = buildDocxXml(textContent, isArabicRtl);

    const zip = new MiniZipBuilder();
    zip.addFile('[Content_Types].xml', DocxGenerator.createContentTypesXml());
    zip.addFile('_rels/.rels', DocxGenerator.createRelsXml());
    zip.addFile('word/_rels/document.xml.rels', DocxGenerator.createDocumentRelsXml());
    zip.addFile('word/styles.xml', DocxGenerator.createStylesXml());
    zip.addFile('word/document.xml', documentXml);

    return zip.build();
  }
}

// ============================================================================
// 3. BINARY PDF 1.4 STRUCTURED WRITER (PdfGenerator)
// ============================================================================

const FONT_PAGE = { width: 595, height: 842, margin: 42, lineHeight: 14, titleSize: 16, bodySize: 10, linesPerPage: 48 };

class PdfGenerator {
  /**
   * Generates a valid multi-page binary PDF 1.4 buffer (fallback writer).
   * Starts with %PDF- and ends with %%EOF. Content is wrapped and paginated,
   * never truncated.
   */
  static generatePdf(title, content) {
    const safeTitle = String(title || 'Document').replace(/[()\\]/g, '');
    const wrapped = [];
    for (const rawLine of String(content || '').split('\n')) {
      const line = rawLine.trim().replace(/[()\\]/g, '');
      if (!line) continue;
      for (let i = 0; i < line.length; i += 95) wrapped.push(line.slice(i, i + 95));
    }
    const pages = [];
    for (let i = 0; i < Math.max(wrapped.length, 1); i += FONT_PAGE.linesPerPage) {
      pages.push(wrapped.slice(i, i + FONT_PAGE.linesPerPage));
    }

    const objects = [];
    objects.push({ id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
    const fontBoldId = 3 + pages.length * 2;
    const fontId = fontBoldId + 1;
    const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
    objects.push({ id: 2, body: `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>` });

    pages.forEach((pageLines, p) => {
      const contentId = 4 + p * 2;
      const streamOps = ['BT'];
      if (p === 0) {
        streamOps.push(`/F1 ${FONT_PAGE.titleSize} Tf`, `${FONT_PAGE.margin} 780 Td`, `(${safeTitle}) Tj`, '0 -24 Td');
      } else {
        streamOps.push(`${FONT_PAGE.margin} 790 Td`);
      }
      streamOps.push(`/F2 ${FONT_PAGE.bodySize} Tf`);
      for (const line of pageLines) {
        streamOps.push(`(${line}) Tj`, `0 -${FONT_PAGE.lineHeight} Td`);
      }
      streamOps.push('ET');
      const streamContent = streamOps.join('\n');
      objects.push({
        id: 3 + p * 2,
        body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${FONT_PAGE.width} ${FONT_PAGE.height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontBoldId} 0 R /F2 ${fontId} 0 R >> >> >>`
      });
      objects.push({ id: contentId, body: `<< /Length ${Buffer.byteLength(streamContent, 'utf8')} >>\nstream\n${streamContent}\nendstream` });
    });

    objects.push({ id: fontBoldId, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>' });
    objects.push({ id: fontId, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' });
    objects.sort((a, b) => a.id - b.id);

    // Assemble binary output with cross-reference table
    let output = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const xrefOffsets = [0]; // Entry 0 is free

    for (const obj of objects) {
      xrefOffsets[obj.id] = Buffer.byteLength(output, 'binary');
      output += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
    }

    const startXref = Buffer.byteLength(output, 'binary');

    output += `xref\n0 ${objects.length + 1}\n`;
    output += '0000000000 65535 f \n';
    for (let i = 1; i <= objects.length; i++) {
      const offsetStr = String(xrefOffsets[i]).padStart(10, '0');
      output += `${offsetStr} 00000 n \n`;
    }

    output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
    output += `startxref\n${startXref}\n%%EOF\n`;

    return Buffer.from(output, 'binary');
  }
}

// ============================================================================
// 3b. HEADLESS BROWSER PRINT DRIVER + TEMPLATE RENDERER
// ============================================================================

const BROWSER_CANDIDATES = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']
};

/** Finds a system Chrome/Chromium/Edge executable, or null. */
function findBrowserExecutable(options = {}) {
  const override = options.chromePath || process.env.CHROME_PATH || process.env.CREW_CHROME_PATH;
  if (override) return fs.existsSync(override) ? override : null;
  if (process.env.CREW_NO_BROWSER_PDF === '1') return null;
  const platform = process.platform;
  const candidates = [...(BROWSER_CANDIDATES[platform] || BROWSER_CANDIDATES.linux)];
  if (platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  for (const cand of candidates) {
    if (path.isAbsolute(cand)) {
      if (fs.existsSync(cand)) return cand;
    } else {
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (dir && fs.existsSync(path.join(dir, cand))) return path.join(dir, cand);
      }
    }
  }
  return null;
}

/**
 * Prints HTML to PDF via headless browser. Returns Buffer or null (never throws).
 */
function printHtmlToPdf(html, options = {}) {
  const browser = options.browser === false ? null : (options.browserPath || findBrowserExecutable(options));
  if (!browser) return null;
  const tmpDir = options.tmpDir || os.tmpdir();
  const stamp = `crew-pdf-${process.pid}-${Date.now()}`;
  const htmlPath = path.join(tmpDir, `${stamp}.html`);
  const pdfPath = options.outPath ? path.resolve(options.outPath) : path.join(tmpDir, `${stamp}.pdf`);
  try {
    fs.writeFileSync(htmlPath, html, 'utf8');
    execFileSync(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`
    ], { timeout: options.timeoutMs || 60000, stdio: 'pipe' });
    const buf = fs.readFileSync(pdfPath);
    return buf.length > 0 ? buf : null;
  } catch (err) {
    if (!options.quiet) console.warn(`[DocGenerator] Headless-browser PDF failed (${err.message}); falling back to built-in PDF writer.`);
    return null;
  } finally {
    try { fs.unlinkSync(htmlPath); } catch (_) {}
    if (!options.outPath) { try { fs.unlinkSync(pdfPath); } catch (_) {} }
  }
}

function lookupPath(obj, dotted) {
  let cur = obj;
  for (const key of String(dotted).split('.')) {
    if (cur === null || cur === undefined) return '';
    cur = cur[key];
  }
  if (Array.isArray(cur)) return cur.join(', ');
  return cur === null || cur === undefined ? '' : String(cur);
}

/** Renders {{dotted.path}} and {{#each list}}...{{/each}} blocks. */
function renderTemplate(template, data = {}) {
  let out = String(template || '');
  out = out.replace(/\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, listPath, block) => {
    let list = data;
    for (const key of listPath.split('.')) list = list ? list[key] : undefined;
    if (!Array.isArray(list)) return '';
    return list.map(item => block
      .replace(/\{\{this\}\}/g, String(item))
      .replace(/\{\{([\w.]+)\}\}/g, (m, p) => {
        const v = lookupPath(item, p);
        return v !== '' ? v : lookupPath(data, p);
      })).join('');
  });
  return out.replace(/\{\{([\w.]+)\}\}/g, (_, p) => lookupPath(data, p));
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function containsArabic(str) {
  return /[\u0600-\u06FF]/.test(String(str || ''));
}

const PRINT_CSS = '@page{size:A4;margin:15mm}body{font-family:Calibri,Arial,sans-serif;font-size:10.5pt;color:#1a1a1a;line-height:1.45}h1{font-size:20pt;margin:0 0 2px}h2{font-size:12pt;text-transform:uppercase;border-bottom:1px solid #999;margin:14px 0 6px}ul{padding-inline-start:18px}section,.job{page-break-inside:avoid}';

/** Builds a complete print-ready CV HTML document (dir=auto / RTL aware). */
function renderCvHtml(cvData, options = {}) {
  const d = (cvData && typeof cvData === 'object') ? cvData : {};
  const c = d.candidate || {};
  const allText = JSON.stringify(d);
  const rtl = Boolean(options.rtl || options.arabic || containsArabic(allText));
  const lang = rtl ? 'ar' : (options.lang || 'en');
  const claimsByEmp = (empId) => (d.claims || []).filter(cl => cl.employerId === empId);
  const jobs = (d.employers || []).map(emp => `
    <div class="job"><h3 dir="auto">${escapeHtml(emp.title)} — ${escapeHtml(emp.name)}</h3>
    <p dir="auto">${escapeHtml(emp.location)} · ${emp.startYear || ''} – ${emp.isCurrent ? 'Present' : (emp.endYear || '')}</p>
    <ul>${claimsByEmp(emp.id).map(cl => `<li dir="auto">${escapeHtml(cl.text)}</li>`).join('')}</ul></div>`).join('');
  const looseClaims = (d.employers && d.employers.length) ? '' :
    `<ul>${(d.claims || []).map(cl => `<li dir="auto">${escapeHtml(cl.text)}</li>`).join('')}</ul>`;
  const skills = Object.values(d.skills || {}).flat().filter(Boolean).join(', ');
  const bodyText = typeof cvData === 'string' ? `<p dir="auto">${escapeHtml(cvData)}</p>` : '';
  return [
    '<!DOCTYPE html>', `<html lang="${lang}" dir="${rtl ? 'rtl' : 'auto'}">`, '<head><meta charset="utf-8">',
    `<title>${escapeHtml(options.title || c.name || 'Curriculum Vitae')}</title>`, `<style>${PRINT_CSS}</style></head><body>`,
    `<h1 dir="auto">${escapeHtml(c.name || options.title || 'Curriculum Vitae')}</h1>`,
    `<p dir="auto">${escapeHtml(c.currentTitle || '')}</p>`,
    `<p dir="auto">${escapeHtml([c.email, c.phone, c.location].filter(Boolean).join(' · '))}</p>`,
    c.summary ? `<section><h2>Summary</h2><p dir="auto">${escapeHtml(c.summary)}</p></section>` : '',
    bodyText, jobs || looseClaims,
    (d.degrees && d.degrees.length) ? `<section><h2>Education</h2><ul>${d.degrees.map(deg => `<li dir="auto"><strong>${escapeHtml(deg.degree)}</strong>, ${escapeHtml(deg.institution)} (${deg.year || ''})</li>`).join('')}</ul></section>` : '',
    skills ? `<section><h2>Skills</h2><p dir="auto">${escapeHtml(skills)}</p></section>` : '',
    '</body></html>'
  ].join('\n');
}

/** Builds a complete print-ready cover-letter HTML document. */
function renderCoverLetterHtml(clData, options = {}) {
  const d = (clData && typeof clData === 'object') ? clData : {};
  const content = typeof clData === 'string' ? clData : (d.content || '');
  const rtl = Boolean(options.rtl || options.arabic || containsArabic(content));
  const paras = String(content).split(/\n+/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p dir="auto">${escapeHtml(p)}</p>`).join('\n');
  return [
    '<!DOCTYPE html>', `<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'auto'}">`,
    '<head><meta charset="utf-8">', `<title>${escapeHtml(options.title || 'Cover Letter')}</title>`,
    `<style>${PRINT_CSS}</style></head><body>`, paras, '</body></html>'
  ].join('\n');
}

function dossierToPlainContent(cvData, fallbackTitle) {
  if (typeof cvData === 'string') return cvData;
  if (!cvData || typeof cvData !== 'object') return '';
  if (cvData.content) return cvData.content;
  const parts = [];
  if (cvData.candidate) {
    if (cvData.candidate.currentTitle) parts.push(cvData.candidate.currentTitle);
    if (cvData.candidate.summary) parts.push(cvData.candidate.summary);
  }
  for (const cl of cvData.claims || []) parts.push(`- ${cl.text}`);
  return parts.join('\n') || fallbackTitle || '';
}

// ============================================================================
// 4. PUBLIC FACADE (DocGenerator)
// ============================================================================

class DocGenerator {
  static generateCvDocx(cvData, options = {}) {
    const isArabic = Boolean(options.rtl || options.arabic);
    return DocxGenerator.buildDocxBuffer(cvData, isArabic);
  }

  static generateCvPdf(cvData, options = {}) {
    const title = options.title || (cvData && cvData.candidate ? cvData.candidate.name : 'Curriculum Vitae');
    const html = options.template
      ? renderTemplate(options.template, (cvData && typeof cvData === 'object') ? cvData : { content: cvData })
      : renderCvHtml(cvData, { ...options, title });
    const browserPdf = printHtmlToPdf(html, options);
    if (browserPdf) return browserPdf;
    if (!options.quiet && options.browser !== false) {
      console.warn('[DocGenerator] No headless browser available; using built-in multi-page PDF writer (install Chrome/Chromium/Edge or set CHROME_PATH for print-quality output).');
    }
    return PdfGenerator.generatePdf(title, dossierToPlainContent(cvData, title));
  }

  static generateCvHtml(cvData, options = {}) {
    return options.template
      ? renderTemplate(options.template, (cvData && typeof cvData === 'object') ? cvData : { content: cvData })
      : renderCvHtml(cvData, options);
  }

  static renderTemplate(template, data) {
    return renderTemplate(template, data);
  }

  static findBrowserExecutable(options = {}) {
    return findBrowserExecutable(options);
  }

  static generateCoverLetterDocx(clData, options = {}) {
    const isArabic = Boolean(options.rtl || options.arabic);
    return DocxGenerator.buildDocxBuffer(clData, isArabic);
  }

  static generateCoverLetterPdf(clData, options = {}) {
    const title = options.title || 'Cover Letter';
    const html = options.template
      ? renderTemplate(options.template, (clData && typeof clData === 'object') ? clData : { content: clData })
      : renderCoverLetterHtml(clData, { ...options, title });
    const browserPdf = printHtmlToPdf(html, options);
    if (browserPdf) return browserPdf;
    const content = typeof clData === 'string' ? clData : (clData ? clData.content || '' : '');
    return PdfGenerator.generatePdf(title, content);
  }

  static generateCoverLetterHtml(clData, options = {}) {
    return options.template
      ? renderTemplate(options.template, (clData && typeof clData === 'object') ? clData : { content: clData })
      : renderCoverLetterHtml(clData, options);
  }

  static buildDocxXml(content, isArabicRtl = false) {
    return buildDocxXml(content, isArabicRtl);
  }
}

module.exports = {
  DocGenerator,
  MiniZipBuilder,
  DocxGenerator,
  PdfGenerator,
  buildDocxXml,
  findBrowserExecutable,
  printHtmlToPdf,
  renderTemplate,
  renderCvHtml,
  renderCoverLetterHtml,
  generateCvDocx: DocGenerator.generateCvDocx,
  generateCvPdf: DocGenerator.generateCvPdf,
  generateCoverLetterDocx: DocGenerator.generateCoverLetterDocx,
  generateCoverLetterPdf: DocGenerator.generateCoverLetterPdf
};
