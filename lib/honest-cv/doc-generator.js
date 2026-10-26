'use strict';

/**
 * JobHunt Crew — Multi-Format Document Generator
 *
 * Implements:
 * 1. MiniZipBuilder: Pure Node.js in-memory PKZIP 2.0 archiver using zlib.deflateRawSync and zlib.crc32.
 * 2. DocxGenerator: OpenXML WordprocessingML document assembler with single-column ATS layout
 *    and native RTL Arabic (<w:bidi/>, <w:jc w:val="right"/>).
 * 3. PdfGenerator: Valid binary PDF 1.4 structured writer (starts with %PDF- and ends with %%EOF).
 * 4. DocGenerator: Public API facade.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const zlib = require('zlib');

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

class PdfGenerator {
  /**
   * Generates a valid binary PDF 1.4 buffer matching PDF specification.
   * Starts with %PDF- and ends with %%EOF.
   */
  static generatePdf(title, content) {
    const safeTitle = String(title || 'Document').replace(/[()\\]/g, '');
    const cleanLines = String(content || '')
      .split('\n')
      .map(l => l.trim().replace(/[()\\]/g, ''))
      .filter(Boolean)
      .slice(0, 30); // Max lines per single page

    const streamOps = [
      'BT',
      '/F1 16 Tf',
      '72 740 Td',
      `(${safeTitle}) Tj`,
      '/F2 10 Tf',
      '0 -24 Td'
    ];

    for (const line of cleanLines) {
      streamOps.push(`(${line}) Tj`);
      streamOps.push('0 -16 Td');
    }
    streamOps.push('ET');

    const streamContent = streamOps.join('\n');
    const streamLen = Buffer.byteLength(streamContent, 'utf8');

    const objects = [];

    // Object 1: Catalog
    objects.push({ id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });

    // Object 2: Pages root
    objects.push({ id: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' });

    // Object 3: Page object
    objects.push({
      id: 3,
      body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>'
    });

    // Object 4: Stream object
    objects.push({
      id: 4,
      body: `<< /Length ${streamLen} >>\nstream\n${streamContent}\nendstream`
    });

    // Object 5: Font F1 (Helvetica-Bold)
    objects.push({
      id: 5,
      body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'
    });

    // Object 6: Font F2 (Helvetica)
    objects.push({
      id: 6,
      body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    });

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
// 4. PUBLIC FACADE (DocGenerator)
// ============================================================================

class DocGenerator {
  static generateCvDocx(cvData, options = {}) {
    const isArabic = Boolean(options.rtl || options.arabic);
    return DocxGenerator.buildDocxBuffer(cvData, isArabic);
  }

  static generateCvPdf(cvData, options = {}) {
    const title = options.title || (cvData && cvData.candidate ? cvData.candidate.name : 'Curriculum Vitae');
    const content = typeof cvData === 'string' ? cvData : (cvData ? cvData.content || (cvData.candidate ? cvData.candidate.summary : '') : '');
    return PdfGenerator.generatePdf(title, content);
  }

  static generateCoverLetterDocx(clData, options = {}) {
    const isArabic = Boolean(options.rtl || options.arabic);
    return DocxGenerator.buildDocxBuffer(clData, isArabic);
  }

  static generateCoverLetterPdf(clData, options = {}) {
    const title = options.title || 'Cover Letter';
    const content = typeof clData === 'string' ? clData : (clData ? clData.content || '' : '');
    return PdfGenerator.generatePdf(title, content);
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
  generateCvDocx: DocGenerator.generateCvDocx,
  generateCvPdf: DocGenerator.generateCvPdf,
  generateCoverLetterDocx: DocGenerator.generateCoverLetterDocx,
  generateCoverLetterPdf: DocGenerator.generateCoverLetterPdf
};
