'use strict';
/**
 * Tier 1: Feature Coverage - Multi-Format Document Generator
 * Verifies valid PDF and DOCX generation, and native RTL Arabic support (<w:bidi/>).
 */

const { TestSuite } = require('../helpers/test-harness');

/**
 * Reference document generator and validator
 */
class DocumentValidator {
  static validatePdfBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('PDF output must be a Buffer');
    }
    const strHeader = buffer.slice(0, 8).toString('binary');
    if (!strHeader.startsWith('%PDF-')) {
      throw new Error('Invalid PDF: Missing %PDF- magic header');
    }
    const strTail = buffer.slice(Math.max(0, buffer.length - 128)).toString('binary');
    if (!strTail.includes('%%EOF')) {
      throw new Error('Invalid PDF: Missing %%EOF trailer');
    }
    return true;
  }

  static validateDocxXml(documentXml, isRtl = false) {
    if (typeof documentXml !== 'string') {
      throw new Error('DOCX document.xml must be a string');
    }
    if (!documentXml.includes('<w:document') || !documentXml.includes('</w:document>')) {
      throw new Error('Invalid DOCX XML: Missing <w:document> envelope');
    }
    if (!documentXml.includes('<w:body>') || !documentXml.includes('</w:body>')) {
      throw new Error('Invalid DOCX XML: Missing <w:body> element');
    }
    if (isRtl) {
      if (!documentXml.includes('<w:bidi/>') && !documentXml.includes('<w:bidi')) {
        throw new Error('Invalid Arabic DOCX: Missing <w:bidi/> RTL direction tag');
      }
      if (!documentXml.includes('<w:jc w:val="right"/>')) {
        throw new Error('Invalid Arabic DOCX: Missing right-aligned justification <w:jc w:val="right"/>');
      }
    }
    return true;
  }
}

/**
 * Minimal reference generator for test verification
 */
class ReferenceDocGenerator {
  static createMinimalPdf(title, text) {
    const pdfContent = [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj',
      `4 0 obj << /Length ${text.length + 20} >> stream`,
      `BT /F1 12 Tf 72 720 Td (${title}: ${text}) Tj ET`,
      'endstream endobj',
      'xref',
      '0 5',
      '0000000000 65535 f ',
      '0000000010 00000 n ',
      '0000000060 00000 n ',
      '0000000115 00000 n ',
      '0000000200 00000 n ',
      'trailer << /Size 5 /Root 1 0 R >>',
      'startxref',
      '320',
      '%%EOF'
    ].join('\n');
    return Buffer.from(pdfContent, 'utf8');
  }

  static createDocxXml(content, isArabicRtl = false) {
    let pPr = '';
    if (isArabicRtl) {
      pPr = '<w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr>';
    }
    return [
      '<w:document xml:lang="en" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      '  <w:body>',
      `    <w:p>${pPr}<w:r><w:t>${content}</w:t></w:r></w:p>`,
      '  </w:body>',
      '</w:document>'
    ].join('\n');
  }
}

const { DocGenerator } = require('../../lib/honest-cv/doc-generator');

const suite = new TestSuite('Tier 1: Multi-Format Document Generator');

suite.test('PDF generator produces valid parseable binary structure with %PDF- and %%EOF', assert => {
  const buf = ReferenceDocGenerator.createMinimalPdf('CV_Morgan_Vance', 'Principal Platform Architect');
  assert.ok(DocumentValidator.validatePdfBuffer(buf));

  const prodBuf = DocGenerator.generateCvPdf({ candidate: { name: 'Morgan Vance', summary: 'Principal Architect' } });
  assert.ok(DocumentValidator.validatePdfBuffer(prodBuf));
});

suite.test('DOCX XML generator produces valid OpenXML body envelope', assert => {
  const xml = ReferenceDocGenerator.createDocxXml('Principal Platform Architect with 12+ years experience');
  assert.ok(DocumentValidator.validateDocxXml(xml, false));

  const prodXml = DocGenerator.buildDocxXml('Principal Platform Architect with 12+ years experience', false);
  assert.ok(DocumentValidator.validateDocxXml(prodXml, false));
});

suite.test('Arabic RTL document generator injects <w:bidi/> and right-alignment properties', assert => {
  const arabicText = 'مهندس معماري رئيسي للأنظمة الموزعة مع خبرة تزيد عن 12 عاماً';
  const rtlXml = ReferenceDocGenerator.createDocxXml(arabicText, true);
  assert.ok(DocumentValidator.validateDocxXml(rtlXml, true));

  const prodRtlXml = DocGenerator.buildDocxXml(arabicText, true);
  assert.ok(DocumentValidator.validateDocxXml(prodRtlXml, true));
});

suite.test('DocGenerator produces valid in-memory DOCX ZIP archive', assert => {
  const docxBuf = DocGenerator.generateCvDocx({ candidate: { name: 'Alex Rivera' } });
  assert.ok(Buffer.isBuffer(docxBuf));
  assert.ok(docxBuf.length > 100);
  // Valid PKZIP starts with PK\x03\x04
  assert.equal(docxBuf[0], 0x50);
  assert.equal(docxBuf[1], 0x4b);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
