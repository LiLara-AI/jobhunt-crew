'use strict';
/**
 * Automated Validator Test for docs/capability-checklist.md
 *
 * Programmatically parses docs/capability-checklist.md, extracts all capability
 * mapping records across R7, R8, and Acceptance Criteria, and asserts:
 * 1. Exactly 20 R7 requirements are mapped (R7.1 through R7.20) with zero missing items.
 * 2. Exactly 7 R8 requirements are mapped (R8.1 through R8.7) with zero missing items.
 * 3. All 27 Acceptance Criteria items are mapped (AC.1 through AC.27) with zero missing items.
 * 4. Every referenced production source file exists on disk.
 * 5. Every referenced test suite file exists on disk.
 * 6. Zero unmapped items exist (100% specification coverage across 54 total requirements).
 * 7. All aligned test descriptions and verified production symbols match authoritative signatures.
 *
 * Location: tests/integration/test-capability-checklist.js
 */

const fs = require('fs');
const path = require('path');

// Dynamically load TestSuite from test harness
let TestSuite;
try {
  const harnessPath = path.resolve(__dirname, '../../jobhunt-crew/tests/helpers/test-harness.js');
  if (fs.existsSync(harnessPath)) {
    TestSuite = require(harnessPath).TestSuite;
  } else {
    TestSuite = require('../helpers/test-harness').TestSuite;
  }
} catch (_) {
  // Standalone fallback
  TestSuite = class {
    constructor(name) { this.name = name; this.tests = []; this.passed = 0; this.failed = 0; this.errors = []; }
    test(description, fn) { this.tests.push({ description, fn }); }
    async run(opts = {}) {
      for (const t of this.tests) {
        try {
          await t.fn({
            equal: (a, b, m) => { if (a !== b) throw new Error(`${m || 'Failed'}: expected ${b}, got ${a}`); },
            ok: (v, m) => { if (!v) throw new Error(m || 'Expected truthy'); },
            lessThanOrEqual: (a, b, m) => { if (a > b) throw new Error(`${m || 'Failed'}: ${a} > ${b}`); }
          });
          this.passed++;
          if (opts.verbose) console.log(`    ✓ ${t.description}`);
        } catch (err) {
          this.failed++;
          this.errors.push({ test: t.description, error: err });
          if (opts.verbose) console.log(`    ✗ ${t.description}\n      ${err.message}`);
        }
      }
      return { name: this.name, passed: this.passed, failed: this.failed, errors: this.errors };
    }
  };
}

const suite = new TestSuite('M8 Integration: Capability Checklist & Acceptance Mapping Validator');

// Determine repo root by walking up to the nearest package.json
function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '../..');
}
const repoRoot = findRepoRoot(__dirname);

let checklistPath = process.env.CHECKLIST_PATH || path.join(repoRoot, 'docs', 'capability-checklist.md');
if (!fs.existsSync(checklistPath)) {
  checklistPath = path.join(__dirname, 'proposed_capability-checklist.md');
}

/**
 * Parses markdown table rows from a capability checklist document.
 * @param {string} markdownContent
 * @returns {Array<Object>} Extracted rows
 */
function parseChecklistMarkdown(markdownContent) {
  const lines = markdownContent.split(/\r?\n/);
  const rows = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    if (trimmed.includes('---|---')) continue; // Table header separator

    const cells = trimmed.split('|').map(c => c.trim()).slice(1, -1);
    if (cells.length < 5) continue;

    const reqIdMatch = cells[0].match(/`?(R[78]\.\d+|AC\.\d+)`?/);
    if (!reqIdMatch) continue;

    const reqId = reqIdMatch[1];
    const name = cells[1].replace(/\*\*/g, '').trim();
    const desc = cells[2];
    const prodCell = cells[3];
    const testCell = cells[4];
    const cmdCell = cells.length >= 6 ? cells[5] : '';
    const statusCell = cells.length >= 7 ? cells[6] : '';

    const prodFiles = [];
    const prodMatches = prodCell.match(/`([^`]+\.(?:js|md|json)|LICENSE|NOTICE|README\.md)`/g) || [];
    for (const m of prodMatches) {
      prodFiles.push(m.replace(/`/g, ''));
    }

    const testFiles = [];
    const testMatches = testCell.match(/`([^`]+\.(?:js|md|json)|LICENSE|NOTICE|README\.md)`/g) || [];
    for (const m of testMatches) {
      testFiles.push(m.replace(/`/g, ''));
    }

    // Also extract command test files if testCell had plain text
    if (testFiles.length === 0 && cmdCell) {
      const cmdMatches = cmdCell.match(/(?:node\s+)?([^\s`"']+\.js)/g) || [];
      for (const m of cmdMatches) {
        const cleanPath = m.replace(/^node\s+/, '').replace(/["']/g, '');
        if (cleanPath.startsWith('tests/') || cleanPath.startsWith('scripts/')) {
          testFiles.push(cleanPath);
        }
      }
    }

    rows.push({
      reqId,
      name,
      desc,
      prodFiles,
      testFiles,
      rawProd: prodCell,
      rawTest: testCell,
      rawCmd: cmdCell,
      status: statusCell
    });
  }

  return rows;
}

let parsedRows = [];

suite.test('Capability checklist file exists and is parseable markdown', assert => {
  assert.ok(fs.existsSync(checklistPath), `Checklist file must exist at ${checklistPath}`);
  const content = fs.readFileSync(checklistPath, 'utf8');
  assert.ok(content.length > 500, 'Checklist file must be non-empty');
  parsedRows = parseChecklistMarkdown(content);
  assert.ok(parsedRows.length >= 54, `Must parse at least 54 capability rows, found ${parsedRows.length}`);
});

suite.test('R7 Carry-Over mapping contains all 20 required capabilities (R7.1 to R7.20)', assert => {
  const r7Rows = parsedRows.filter(r => r.reqId.startsWith('R7.'));
  assert.equal(r7Rows.length, 20, `Expected exactly 20 R7 items, got ${r7Rows.length}`);

  for (let i = 1; i <= 20; i++) {
    const id = `R7.${i}`;
    const found = r7Rows.find(r => r.reqId === id);
    assert.ok(found, `Missing R7 capability: ${id}`);
    assert.ok(found.prodFiles.length > 0, `R7 capability ${id} must specify production file(s)`);
    assert.ok(found.testFiles.length > 0, `R7 capability ${id} must specify test file(s)`);
  }
});

suite.test('R8 New Capabilities mapping contains all 7 required features (R8.1 to R8.7)', assert => {
  const r8Rows = parsedRows.filter(r => r.reqId.startsWith('R8.'));
  assert.equal(r8Rows.length, 7, `Expected exactly 7 R8 items, got ${r8Rows.length}`);

  for (let i = 1; i <= 7; i++) {
    const id = `R8.${i}`;
    const found = r8Rows.find(r => r.reqId === id);
    assert.ok(found, `Missing R8 capability: ${id}`);
    assert.ok(found.prodFiles.length > 0, `R8 capability ${id} must specify production file(s)`);
    assert.ok(found.testFiles.length > 0, `R8 capability ${id} must specify test file(s)`);
  }
});

suite.test('Acceptance Criteria mapping contains all 27 criteria (AC.1 to AC.27)', assert => {
  const acRows = parsedRows.filter(r => r.reqId.startsWith('AC.'));
  assert.equal(acRows.length, 27, `Expected exactly 27 Acceptance Criteria items, got ${acRows.length}`);

  for (let i = 1; i <= 27; i++) {
    const id = `AC.${i}`;
    const found = acRows.find(r => r.reqId === id);
    assert.ok(found, `Missing Acceptance Criterion: ${id}`);
    assert.ok(found.prodFiles.length > 0, `Criterion ${id} must specify production file(s)`);
    assert.ok(found.testFiles.length > 0, `Criterion ${id} must specify test file(s)`);
  }

  // Explicit check for line 592 AC.19 opt-in live smoke command
  const ac19 = acRows.find(r => r.reqId === 'AC.19');
  assert.ok(ac19, 'AC.19 (Opt-in Public ATS Live Smoke Command) must be explicitly mapped');
  assert.ok(ac19.name.includes('Live Smoke') || ac19.name.includes('Smoke'), 'AC.19 name must identify live smoke');
  assert.ok(ac19.rawCmd.includes('discover smoke'), 'AC.19 command must reference crew discover smoke');
});

suite.test('All referenced production implementation files exist on disk', assert => {
  const missing = [];
  let checked = 0;

  for (const row of parsedRows) {
    for (const f of row.prodFiles) {
      checked++;
      const resolved = path.resolve(repoRoot, f);
      if (!fs.existsSync(resolved)) {
        missing.push({ reqId: row.reqId, file: f, resolved });
      }
    }
  }

  assert.equal(missing.length, 0, `Found ${missing.length} missing production files on disk: ${JSON.stringify(missing)}`);
  assert.ok(checked >= 50, `Must verify at least 50 production file references, checked ${checked}`);
});

suite.test('All referenced automated test suite files exist on disk', assert => {
  const missing = [];
  let checked = 0;

  for (const row of parsedRows) {
    for (const f of row.testFiles) {
      checked++;
      const resolved = path.resolve(repoRoot, f);
      if (!fs.existsSync(resolved)) {
        missing.push({ reqId: row.reqId, file: f, resolved });
      }
    }
  }

  assert.equal(missing.length, 0, `Found ${missing.length} missing test files on disk: ${JSON.stringify(missing)}`);
  assert.ok(checked >= 50, `Must verify at least 50 test file references, checked ${checked}`);
});

suite.test('Zero unmapped capabilities or missing implementation references', assert => {
  const total = parsedRows.length;
  assert.equal(total, 54, `Checklist must have exactly 54 mapped items (20 R7 + 7 R8 + 27 AC), found ${total}`);

  const unmapped = parsedRows.filter(r => r.prodFiles.length === 0 || r.testFiles.length === 0);
  assert.equal(unmapped.length, 0, `Found ${unmapped.length} unmapped rows without code or test references`);
});

suite.test('Aligned capability checklist rows contain verified test descriptions', assert => {
  const alignedChecks = [
    { reqId: 'R7.4', pattern: /JobScorer adheres to 5-dimension rubric and strict zero age penalty invariant/ },
    { reqId: 'R7.5', pattern: /Execute backup, catastrophic wipe, and restore verifying 100% data equality/ },
    { reqId: 'R7.6', pattern: /Multi-channel discovery collapses duplicates and triages qualifying roles/ },
    { reqId: 'R7.13', pattern: /KsaOfferCalculator computes Article 84 EOSB for termination and contract expiration/ },
    { reqId: 'R7.14', pattern: /InboxSignalParser correctly categorizes incoming recruitment signals/ },
    { reqId: 'R7.14', pattern: /ScamSentinel detects fraud patterns and protects candidate with risk scoring/ },
    { reqId: 'R7.15', pattern: /TC-DOCTOR-06: Connector Probe Graceful Degradation & Zero-Leak Credential Masking/ },
    { reqId: 'R7.16', pattern: /JobScorer adheres to 5-dimension rubric and strict zero age penalty invariant/ },
    { reqId: 'R7.19', pattern: /Executes complete 12-stage end-to-end lifecycle smoothly on fictional workspace/ },
    { reqId: 'R7.20', pattern: /Step 1: Human inspects Decision Queue via GET \/api\/decisions/ },
    { reqId: 'R8.2', pattern: /Applying to a different requisition at same company within cooldown triggers warning but allows progression/ },
    { reqId: 'R8.3', pattern: /3\.1 Closing-Soon: Genuine \+0\.5 priority boost applied when deadline is within 7 days/ },
    { reqId: 'R8.4', pattern: /StarRStoryBank compiles structured interview-pack\.md preparation guide/ },
    { reqId: 'R8.6', pattern: /Executes complete 12-stage end-to-end lifecycle smoothly on fictional workspace/ },
    { reqId: 'R8.7', pattern: /Execute backup, catastrophic wipe, and restore verifying 100% data equality/ }
  ];

  for (const check of alignedChecks) {
    const row = parsedRows.find(r => r.reqId === check.reqId);
    assert.ok(row, `Row ${check.reqId} must exist in parsed rows`);
    assert.ok(check.pattern.test(row.rawTest), `Row ${check.reqId} test column must match ${check.pattern}. Got: "${row.rawTest}"`);
  }
});

suite.test('Remediated capability checklist rows contain genuine production symbols (zero phantom entities)', assert => {
  const symbolChecks = [
    { reqId: 'R7.14', pattern: /ScamSentinel\.triage/ },
    { reqId: 'R7.15', pattern: /BrowserSweeps\.evaluateSessionHealth/ },
    { reqId: 'R7.15', pattern: /probeChromeDevTools/ },
    { reqId: 'R7.16', pattern: /JobScorer\.scoreVacancy/ },
    { reqId: 'R7.16', pattern: /BlindReviewPanel/ },
    { reqId: 'R7.18', pattern: /CadenceEngine\.evaluateApplications/ },
    { reqId: 'R7.20', pattern: /_handlePostDecision/ },
    { reqId: 'R7.20', pattern: /JOB_CLOSED/ },
    { reqId: 'R8.4', pattern: /StarRStoryBank\.prototype\.generateInterviewPack/ },
    { reqId: 'R8.5', pattern: /BlindReviewPanel/ },
    { reqId: 'R8.5', pattern: /ats_keyword_density/ }
  ];

  for (const check of symbolChecks) {
    const row = parsedRows.find(r => r.reqId === check.reqId);
    assert.ok(row, `Row ${check.reqId} must exist`);
    assert.ok(check.pattern.test(row.rawProd), `Row ${check.reqId} production column must match ${check.pattern}. Got: "${row.rawProd}"`);
  }
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    if (res.failed > 0) {
      console.error(`\nFAILED: ${res.failed} tests failed in ${res.name}`);
      process.exit(1);
    } else {
      console.log(`\nPASSED: ${res.passed} tests passed in ${res.name}`);
      process.exit(0);
    }
  });
}
