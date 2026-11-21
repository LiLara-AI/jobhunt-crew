'use strict';

/**
 * JobHunt Crew — Multi-Format Document Generator
 *
 * Implements:
 * 1. MiniZipBuilder: Pure Node.js in-memory PKZIP 2.0 archiver using zlib.deflateRawSync and zlib.crc32.
 * 2. DocxGenerator: OpenXML WordprocessingML document assembler with single-column ATS layout
 *    and opt-in RTL Arabic (<w:bidi/> paragraphs, <w:rtl/> runs).
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
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // control chars are illegal in XML 1.0; Word refuses the file
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** RTL is opt-in only (options.language === 'ar'); stray Arabic characters never flip a document. */
function isRtl(options = {}) {
  return Boolean(options.rtl || options.arabic || options.language === 'ar' || options.lang === 'ar');
}

/**
 * Structured CV content shared by the DOCX, HTML and fallback-PDF renderers, so
 * all three carry the same sections. Only facts present in the dossier are used.
 */
function buildCvModel(cvData) {
  const d = (cvData && typeof cvData === 'object') ? cvData : {};
  const c = d.candidate || {};
  const str = v => (v === null || v === undefined ? '' : String(v).trim());
  const join = (parts, sep) => parts.map(str).filter(Boolean).join(sep);
  const list = v => (Array.isArray(v) ? v : []);
  // Unverified ([CONFIRM]) claims never reach a rendered CV.
  const claims = list(d.claims).filter(cl => cl && str(cl.text) && (!cl.status || cl.status === 'VERIFIED'));
  const endOf = e => ((e.isCurrent || !e.endYear) ? Infinity : Number(e.endYear));
  const byEndThenStart = (a, b) => {
    const ea = endOf(a), eb = endOf(b);
    return ea === eb ? (Number(b.startYear) || 0) - (Number(a.startYear) || 0) : (eb > ea ? 1 : -1);
  };
  const employers = list(d.employers).filter(Boolean).slice().sort(byEndThenStart);
  const experience = employers.map(e => ({
    heading: join([e.title, e.name], ' | '),
    meta: join([e.location, join([e.startYear, e.isCurrent ? 'Present' : e.endYear], ' - ')], ' | '),
    bullets: claims.filter(cl => cl.employerId === e.id).map(cl => str(cl.text))
  }));
  const employerIds = new Set(employers.map(e => e.id));
  const loose = claims.filter(cl => !employerIds.has(cl.employerId)).map(cl => str(cl.text));
  if (loose.length) experience.push({ heading: '', meta: '', bullets: loose });
  const dated = (a, b, year) => join([join([a, b], ', '), str(year) ? `(${str(year)})` : ''], ' ');
  const content = typeof cvData === 'string' ? cvData : str(d.content);
  return {
    name: str(c.name),
    title: str(c.currentTitle),
    contact: join([c.phone, c.email, c.location, c.linkedin || c.linkedIn || c.linkedinUrl], ' | '),
    summary: str(c.summary),
    experience,
    education: list(d.degrees).filter(Boolean).map(g => dated(g.degree, g.institution, g.year)).filter(Boolean),
    certifications: list(d.certifications).filter(Boolean).map(g => dated(g.name, g.issuer, g.year)).filter(Boolean),
    skills: [...new Set((Array.isArray(d.skills) ? d.skills : Object.values(d.skills || {}).flat()).map(str).filter(Boolean))],
    body: content.split('\n').map(l => l.trim()).filter(Boolean)
  };
}

/** Flattens the CV model into ordered { kind, text } blocks (single column, standard ATS headings). */
function cvBlocks(model) {
  const blocks = [];
  const add = (kind, text) => { if (text) blocks.push({ kind, text }); };
  add('name', model.name);
  add('title', model.title);
  add('contact', model.contact);
  if (model.summary) { add('heading', 'Professional Summary'); add('body', model.summary); }
  if (model.experience.length) {
    add('heading', 'Experience');
    for (const job of model.experience) {
      add('job', job.heading);
      add('meta', job.meta);
      job.bullets.forEach(t => add('bullet', t));
    }
  }
  if (model.education.length) { add('heading', 'Education'); model.education.forEach(t => add('body', t)); }
  if (model.certifications.length) { add('heading', 'Certifications'); model.certifications.forEach(t => add('body', t)); }
  if (model.skills.length) { add('heading', 'Skills'); add('body', model.skills.join(', ')); }
  model.body.forEach(t => add('body', t));
  return blocks;
}

// Paragraph formatting per block kind. Real text only (no tables, no text boxes) so ATS parsers read it.
const DOCX_KINDS = {
  name: { style: 'Title' },
  title: { run: '<w:sz w:val="24"/><w:szCs w:val="24"/>' },
  heading: { style: 'Heading1' },
  job: { keepNext: true, run: '<w:b/><w:bCs/>' },
  meta: { keepNext: true, run: '<w:i/><w:iCs/>' },
  bullet: { ind: '<w:ind w:left="360" w:hanging="180"/>', prefix: '\u2022 ' }
};

/**
 * Builds word/document.xml from plain text (one paragraph per line) or from
 * { kind, text } blocks produced by cvBlocks().
 */
function buildDocxXml(content, isArabicRtl = false) {
  const blocks = Array.isArray(content) ? content.slice()
    : String(content).split('\n').map(line => line.trim()).filter(Boolean).map(text => ({ kind: 'body', text }));
  if (blocks.length === 0) blocks.push({ kind: 'body', text: '' });
  const langAttr = isArabicRtl ? 'xml:lang="ar-SA"' : 'xml:lang="en-US"';
  const fonts = isArabicRtl
    ? '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/>'
    : '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>';

  const xmlParagraphs = blocks.map(({ kind, text }) => {
    const k = DOCX_KINDS[kind] || {};
    // No <w:jc> in RTL: a bidi paragraph starts at the right edge by default, and Word reads
    // jc="right" on a bidi paragraph as the trailing (left) edge.
    const pPr = '<w:pPr>' + (k.style ? `<w:pStyle w:val="${k.style}"/>` : '') + (k.keepNext ? '<w:keepNext/>' : '') +
      (isArabicRtl ? '<w:bidi/>' : '') + (k.ind || '') + (isArabicRtl ? '' : '<w:jc w:val="left"/>') + '</w:pPr>';
    const rPr = `<w:rPr>${fonts}${k.run || ''}${isArabicRtl ? '<w:rtl/>' : ''}</w:rPr>`;
    return `    <w:p>${pPr}<w:r>${rPr}<w:t>${escapeXml((k.prefix || '') + String(text))}</w:t></w:r></w:p>`;
  }).join('\n');

  return [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<w:document ${langAttr} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`,
    `  <w:body>`,
    xmlParagraphs,
    `    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`,
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
      `    <w:pPr><w:spacing w:after="60"/></w:pPr>`,
      `    <w:rPr>`,
      `      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>`,
      `      <w:sz w:val="21"/>`,
      `    </w:rPr>`,
      `  </w:style>`,
      `  <w:style w:type="paragraph" w:styleId="Title">`,
      `    <w:name w:val="Title"/><w:basedOn w:val="Normal"/>`,
      `    <w:pPr><w:spacing w:after="40"/></w:pPr>`,
      `    <w:rPr><w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>`,
      `  </w:style>`,
      `  <w:style w:type="paragraph" w:styleId="Heading1">`,
      `    <w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>`,
      `    <w:pPr><w:keepNext/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr>`,
      `    <w:rPr><w:b/><w:bCs/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>`,
      `  </w:style>`,
      `</w:styles>`
    ].join('\n');
  }

  /**
   * Builds a complete .docx buffer from text or CV object.
   */
  static buildDocxBuffer(contentOrCv, isArabicRtl = false) {
    const documentXml = buildDocxXml(cvBlocks(buildCvModel(contentOrCv)), isArabicRtl);

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

const PDF_NON_LATIN_MESSAGE = 'PDF_UNAVAILABLE: this document contains Arabic or other non-Latin text, which the built-in PDF writer cannot render, and headless Chrome/Edge printing is not available. Use the DOCX or HTML output instead, or install Chrome/Edge (or set CHROME_PATH) and retry.';

/** Maps text to what the WinAnsi-encoded fallback fonts can show. Throws rather than writing mojibake. */
function toPdfText(value) {
  const text = String(value === null || value === undefined ? '' : value)
    .replace(/[\u2013\u2014\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2022\u25CF\u25AA]/g, '-').replace(/\u2026/g, '...').replace(/\u00A0/g, ' ');
  if (/(?![\u0000-\u00FF])\p{L}/u.test(text)) throw new Error(PDF_NON_LATIN_MESSAGE);
  return text.replace(/[^\x20-\x7E\xA1-\xFF]/g, '?');
}

function wrapWords(text, width) {
  const lines = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > width) { lines.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
    while (cur.length > width) { lines.push(cur.slice(0, width)); cur = cur.slice(width); }
  }
  if (cur) lines.push(cur);
  return lines;
}

class PdfGenerator {
  /**
   * Generates a valid multi-page binary PDF 1.4 buffer (fallback writer).
   * Starts with %PDF- and ends with %%EOF. Content is word-wrapped and paginated,
   * never truncated. `content` is text, or an array of lines / { text, bold }
   * entries ('' = blank spacer). Latin text only: throws PDF_UNAVAILABLE on Arabic etc.
   */
  static generatePdf(title, content) {
    const esc = s => s.replace(/[()\\]/g, '\\$&');
    const safeTitle = esc(toPdfText(title || 'Document'));
    const wrapped = [];
    for (const entry of (Array.isArray(content) ? content : String(content || '').split('\n'))) {
      const bold = Boolean(entry && entry.bold);
      const line = toPdfText(entry && typeof entry === 'object' ? entry.text : entry).trim();
      if (!line) {
        if (wrapped.length && wrapped[wrapped.length - 1].text) wrapped.push({ text: '' });
        continue;
      }
      for (const part of wrapWords(line, 90)) wrapped.push({ text: esc(part), bold });
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
      for (const line of pageLines) {
        if (line.text) streamOps.push(`/${line.bold ? 'F1' : 'F2'} ${FONT_PAGE.bodySize} Tf`, `(${line.text}) Tj`);
        streamOps.push(`0 -${FONT_PAGE.lineHeight} Td`);
      }
      streamOps.push('ET');
      const streamContent = streamOps.join('\n');
      objects.push({
        id: 3 + p * 2,
        body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${FONT_PAGE.width} ${FONT_PAGE.height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontBoldId} 0 R /F2 ${fontId} 0 R >> >> >>`
      });
      // The file is written as latin1 below, so the stream length is counted the same way.
      objects.push({ id: contentId, body: `<< /Length ${Buffer.byteLength(streamContent, 'latin1')} >>\nstream\n${streamContent}\nendstream` });
    });

    objects.push({ id: fontBoldId, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>' });
    objects.push({ id: fontId, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' });
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

const PRINT_CSS = '@page{size:A4;margin:15mm}body{font-family:Calibri,Arial,sans-serif;font-size:10.5pt;color:#1a1a1a;line-height:1.45}h1{font-size:20pt;margin:0 0 2px}h2{font-size:12pt;text-transform:uppercase;border-bottom:1px solid #999;margin:14px 0 6px}h3{font-size:11pt;margin:8px 0 0}p{margin:0 0 4px}.meta{color:#555;font-style:italic}ul{margin:2px 0 6px;padding-inline-start:18px}h2,h3,.meta{break-after:avoid}li{break-inside:avoid}';

const HTML_TAGS = { name: 'h1', heading: 'h2', job: 'h3', bullet: 'li' };

/** Renders cvBlocks() as semantic single-column HTML (h1/h2/h3/p/ul only, no layout tables). */
function blocksToHtml(blocks) {
  const out = [];
  let inList = false;
  for (const { kind, text } of blocks) {
    if ((kind === 'bullet') !== inList) { out.push(inList ? '</ul>' : '<ul>'); inList = !inList; }
    const tag = HTML_TAGS[kind];
    out.push(tag ? `<${tag}>${escapeHtml(text)}</${tag}>` : `<p class="${kind}">${escapeHtml(text)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

/** Builds a complete print-ready CV HTML document. RTL only when requested (options.language === 'ar'). */
function renderCvHtml(cvData, options = {}) {
  const model = buildCvModel(cvData);
  const rtl = isRtl(options);
  return [
    '<!DOCTYPE html>', `<html lang="${rtl ? 'ar' : (options.lang || 'en')}" dir="${rtl ? 'rtl' : 'ltr'}">`, '<head><meta charset="utf-8">',
    `<title>${escapeHtml(options.title || model.name || 'Curriculum Vitae')}</title>`, `<style>${PRINT_CSS}</style></head><body>`,
    blocksToHtml(cvBlocks(model)),
    '</body></html>'
  ].join('\n');
}

/** Template data: the raw dossier plus `cv` (escaped, pre-rendered sections) for {{cv.html}} shells. */
function cvTemplateData(cvData, options = {}) {
  const model = buildCvModel(cvData);
  const rtl = isRtl(options);
  return {
    ...((cvData && typeof cvData === 'object') ? cvData : { content: cvData }),
    cv: { html: blocksToHtml(cvBlocks(model)), name: escapeHtml(model.name), lang: rtl ? 'ar' : (options.lang || 'en'), dir: rtl ? 'rtl' : 'ltr' }
  };
}

/** Builds a complete print-ready cover-letter HTML document. */
function renderCoverLetterHtml(clData, options = {}) {
  const d = (clData && typeof clData === 'object') ? clData : {};
  const content = typeof clData === 'string' ? clData : (d.content || '');
  const rtl = isRtl(options);
  const paras = String(content).split(/\n+/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p dir="auto">${escapeHtml(p)}</p>`).join('\n');
  return [
    '<!DOCTYPE html>', `<html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">`,
    '<head><meta charset="utf-8">', `<title>${escapeHtml(options.title || 'Cover Letter')}</title>`,
    `<style>${PRINT_CSS}</style></head><body>`, paras, '</body></html>'
  ].join('\n');
}

/** Lines for the fallback PDF writer: same sections as the DOCX; the name is printed as the PDF title. */
function cvPdfLines(model) {
  const lines = [];
  for (const { kind, text } of cvBlocks(model)) {
    if (kind === 'name') continue;
    if (kind === 'heading') lines.push('', { text: text.toUpperCase(), bold: true });
    else lines.push({ text: (kind === 'bullet' ? '- ' : '') + text, bold: kind === 'job' });
  }
  return lines;
}

// ============================================================================
// 4. PUBLIC FACADE (DocGenerator)
// ============================================================================

class DocGenerator {
  static generateCvDocx(cvData, options = {}) {
    return DocxGenerator.buildDocxBuffer(cvData, isRtl(options));
  }

  /**
   * Print-quality PDF via headless Chrome/Edge, with the built-in Latin-only writer as fallback.
   * Throws PDF_UNAVAILABLE when the text is Arabic/non-Latin and no browser could print it.
   */
  static generateCvPdf(cvData, options = {}) {
    const model = buildCvModel(cvData);
    const title = options.title || model.name || 'Curriculum Vitae';
    const browserPdf = printHtmlToPdf(DocGenerator.generateCvHtml(cvData, { ...options, title }), options);
    if (browserPdf) return browserPdf;
    if (!options.quiet && options.browser !== false) {
      console.warn('[DocGenerator] No headless browser available; using built-in multi-page PDF writer (install Chrome/Chromium/Edge or set CHROME_PATH for print-quality output).');
    }
    return PdfGenerator.generatePdf(title, cvPdfLines(model));
  }

  static generateCvHtml(cvData, options = {}) {
    return options.template
      ? renderTemplate(options.template, cvTemplateData(cvData, options))
      : renderCvHtml(cvData, options);
  }

  static renderTemplate(template, data) {
    return renderTemplate(template, data);
  }

  static findBrowserExecutable(options = {}) {
    return findBrowserExecutable(options);
  }

  static generateCoverLetterDocx(clData, options = {}) {
    return DocxGenerator.buildDocxBuffer(clData, isRtl(options));
  }

  static generateCoverLetterPdf(clData, options = {}) {
    const title = options.title || 'Cover Letter';
    const html = options.template
      ? renderTemplate(options.template, (clData && typeof clData === 'object') ? clData : { content: clData })
      : renderCoverLetterHtml(clData, { ...options, title });
    const browserPdf = printHtmlToPdf(html, options);
    if (browserPdf) return browserPdf;
    const content = typeof clData === 'string' ? clData : (clData ? clData.content || '' : '');
    // Blank line between paragraphs; the fallback writer throws PDF_UNAVAILABLE on Arabic text.
    return PdfGenerator.generatePdf(title, String(content).replace(/\n+/g, '\n\n'));
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
