'use strict';
/**
 * Tier 2: Boundary & Corner Cases - Empty, Truncated & Malformed Inputs
 * Verifies resilience to empty strings, missing fields, corrupted JSONL lines,
 * and ledger recovery without data loss.
 */

const { TestSuite } = require('../helpers/test-harness');

class RobustLedgerParser {
  static parseLines(rawContent) {
    if (!rawContent || rawContent.trim().length === 0) {
      return { validEvents: [], corruptedLines: [] };
    }

    const lines = rawContent.split(/\r?\n/);
    const validEvents = [];
    const corruptedLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue; // skip blank lines gracefully

      try {
        const obj = JSON.parse(line);
        if (!obj.seq || !obj.type || !obj.payload) {
          corruptedLines.push({ lineNumber: i + 1, content: line, reason: 'MISSING_MANDATORY_FIELDS' });
        } else {
          validEvents.push(obj);
        }
      } catch (err) {
        corruptedLines.push({ lineNumber: i + 1, content: line, reason: 'JSON_SYNTAX_ERROR', error: err.message });
      }
    }

    return { validEvents, corruptedLines };
  }
}

const suite = new TestSuite('Tier 2: Empty & Malformed Input Handling');

suite.test('Empty ledger content parses to empty array without crashing', assert => {
  const r1 = RobustLedgerParser.parseLines('');
  assert.equal(r1.validEvents.length, 0);
  assert.equal(r1.corruptedLines.length, 0);

  const r2 = RobustLedgerParser.parseLines('   \n\n  \t  \n');
  assert.equal(r2.validEvents.length, 0);
  assert.equal(r2.corruptedLines.length, 0);
});

suite.test('Corrupted or truncated JSONL lines are quarantined while preserving valid events', assert => {
  const content = [
    '{"seq":1,"timestamp":"2026-10-24T10:00:00Z","type":"JOB_DISCOVERED","payload":{"id":"j1"},"hash":"h1"}',
    '{"seq":2,"timestamp":"TRUNCATED_JSON_LINE_HERE...',
    'MALFORMED_GARBAGE_CHARACTERS_XYZ',
    '{"seq":3,"timestamp":"2026-10-24T10:05:00Z","type":"JOB_TRIAGED","payload":{"id":"j1","score":4.2},"hash":"h3"}',
    '{"seq":4,"missing_type_and_payload":true}'
  ].join('\n');

  const { validEvents, corruptedLines } = RobustLedgerParser.parseLines(content);

  assert.equal(validEvents.length, 2, 'Must recover exactly the 2 valid events');
  assert.equal(validEvents[0].seq, 1);
  assert.equal(validEvents[1].seq, 3);

  assert.equal(corruptedLines.length, 3, 'Must record the 3 invalid/corrupt lines');
  assert.equal(corruptedLines[0].reason, 'JSON_SYNTAX_ERROR');
  assert.equal(corruptedLines[1].reason, 'JSON_SYNTAX_ERROR');
  assert.equal(corruptedLines[2].reason, 'MISSING_MANDATORY_FIELDS');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
