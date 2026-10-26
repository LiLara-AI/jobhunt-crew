'use strict';

/**
 * Milestone M6 Empirical Challenger Stress Test Suite
 * Exhaustive adversarial stress test on serializeSnapshotSafely, JSON.parse roundtrip,
 * and dist/command-center-export.html structural and execution validation.
 *
 * Authored by: challenger_m6_iter2_2
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { TestSuite } = require('../helpers/test-harness');
const {
  exportDashboard,
  verifyZeroRemoteAssets,
  serializeSnapshotSafely
} = require('../../lib/command-center/exporter');

const suite = new TestSuite('M6 Iter2 Exporter Script Breakout & JSON Parsing Stress Suite');

// ============================================================================
// 1. ADVERSARIAL PAYLOAD STRESS ON serializeSnapshotSafely & JSON.parse
// ============================================================================

suite.test('1.1 Exhaustive HTML Breakout and Script Injection Vectors', async assert => {
  const breakoutVectors = [
    '</script>',
    '</SCRIPT>',
    '</Script/x>',
    '</script >',
    '</script\t\r\n\f>',
    '</script attr="val">',
    '<!--',
    '-->',
    '<!--<script>',
    '<!-- --!>',
    '<!-->--!>',
    '<![CDATA[',
    ']]>',
    '<![CDATA[</script>]]>',
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<script src="https://attacker.example.com/malware.js"></script>',
    '<style>body { display: none !important; }</style>',
    '<svg onload=alert("svg")><script>alert("nested")</script></svg>',
    '<img src="x" onerror="alert(1)">',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<<SCRIPT>alert("nested-tag")</SCRIPT>',
    '<script\x00>alert(1)</script>',
    '</script\x00>',
    '</\x00script>',
    '<meta http-equiv="refresh" content="0;url=http://evil.com">'
  ];

  for (let i = 0; i < breakoutVectors.length; i++) {
    const vector = breakoutVectors[i];
    const payload = {
      id: `test-breakout-${i}`,
      title: `Senior Engineer ${vector}`,
      company: `Defense Corp ${vector}`,
      notes: `Notes containing ${vector} inside text`,
      tags: [vector, `prefix-${vector}-suffix`],
      nested: { deeply: { inner: vector } }
    };

    const serialized = serializeSnapshotSafely(payload);

    // Invariant 1: Must contain ZERO literal '<' characters
    assert.equal(
      serialized.includes('<'),
      false,
      `Vector #${i} (${vector}) produced literal '<' in serialized output`
    );

    // Invariant 2: Must be natively parseable via JSON.parse without SyntaxError
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch (err) {
      assert.fail(`Vector #${i} (${vector}) threw JSON.parse SyntaxError: ${err.message}`);
    }

    // Invariant 3: Deep equality with original payload
    assert.equal(parsed.title, payload.title, `Vector #${i} title mismatch`);
    assert.equal(parsed.company, payload.company, `Vector #${i} company mismatch`);
    assert.equal(parsed.notes, payload.notes, `Vector #${i} notes mismatch`);
    assert.equal(parsed.tags[0], vector, `Vector #${i} tags[0] mismatch`);
    assert.equal(parsed.nested.deeply.inner, vector, `Vector #${i} nested mismatch`);
  }
});

suite.test('1.2 International Unicode, Control Characters, and Bidi Stress', async assert => {
  const unicodeCases = [
    { name: 'Arabic with RTL marks', text: 'مهندس نظم موزعة أول 🚀 \u202Ereversed text\u202C' },
    { name: 'CJK complex characters', text: '高级软件工程师 · 分布式系统架构师' },
    { name: 'Hebrew with RTL marks', text: 'מהנדס תוכנה בכיר \u200E(Staff Engineer)\u200F' },
    { name: 'Cyrillic with quotes', text: 'Ведущий инженер-разработчик распределённых систем' },
    { name: 'ZWJ Emoji Sequence', text: '👨‍💻 👩‍💼 ⚡ 🛡️ 🚀 🤖 💎 🌟' },
    { name: 'Surrogate Pairs', text: '\uD83D\uDE80\uD83D\uDEE1\uFE0F' },
    { name: 'JSON/JS Line Separators', text: 'Line 1\u2028Line 2\u2029Line 3' },
    { name: 'Zero-width characters', text: 'Z\u200BW\u200CS\u200DP\uFEFF' },
    { name: 'Quotes and Backslashes', text: 'Single \' Double " Backtick ` Escaped \\ and \\\\u003c' },
    { name: 'Mixed HTML + Unicode', text: 'شركة <!-- test --> <script>alert("مرحبا")</script>' }
  ];

  for (const uc of unicodeCases) {
    const payload = { test: uc.name, data: uc.text };
    const serialized = serializeSnapshotSafely(payload);

    assert.equal(serialized.includes('<'), false, `${uc.name} contained literal '<'`);

    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch (err) {
      assert.fail(`${uc.name} failed JSON.parse: ${err.message}`);
    }

    assert.equal(parsed.data, uc.text, `${uc.name} roundtrip data mismatch`);
  }
});

suite.test('1.3 High-Volume and Deeply-Nested Structural Stress', async assert => {
  // Deep nesting (50 levels)
  let deepObj = { level: 0, text: '<script>alert("deep")</script>' };
  let current = deepObj;
  for (let d = 1; d <= 50; d++) {
    current.child = { level: d, text: `Level ${d}: <!-- comment --> <${d}>` };
    current = current.child;
  }

  const serializedDeep = serializeSnapshotSafely(deepObj);
  assert.equal(serializedDeep.includes('<'), false, 'Deep object contained literal <');
  const parsedDeep = JSON.parse(serializedDeep);

  let check = parsedDeep;
  for (let d = 0; d <= 50; d++) {
    assert.ok(check !== undefined, `Level ${d} must exist`);
    if (d === 0) {
      assert.equal(check.text, '<script>alert("deep")</script>');
    } else {
      assert.equal(check.text, `Level ${d}: <!-- comment --> <${d}>`);
    }
    check = check.child;
  }

  // Large payload (5,000 array elements with adversarial strings)
  const largeArray = [];
  for (let i = 0; i < 5000; i++) {
    largeArray.push({
      idx: i,
      snippet: `Item #${i}: <!-- tag --> </script><script>alert(${i})</script> <![CDATA[ cdata ${i} ]]>`
    });
  }

  const serializedLarge = serializeSnapshotSafely({ items: largeArray });
  assert.equal(serializedLarge.includes('<'), false, 'Large array contained literal <');
  const parsedLarge = JSON.parse(serializedLarge);
  assert.equal(parsedLarge.items.length, 5000, 'Large array length mismatch');
  assert.equal(
    parsedLarge.items[4999].snippet,
    'Item #4999: <!-- tag --> </script><script>alert(4999)</script> <![CDATA[ cdata 4999 ]]>'
  );
});

suite.test('1.4 Simulated HTML Document Inlining and Script Text Extraction', async assert => {
  const testSnapshot = {
    version: 1,
    lastEventId: 99,
    jobs: {
      'job-hostile': {
        title: '</script><script>window.__hostile_code_executed=true;</script>',
        company: 'Exploit Inc <!-- HTML comment -->',
        notes: '<![CDATA[ <script>eval("evil")</script> ]]> \u003c already escaped',
        description: 'Check <img src=x onerror=alert(1)> and </SCRIPT>'
      }
    }
  };

  const serialized = serializeSnapshotSafely(testSnapshot);

  // Inlined inside simulated full HTML page
  const htmlPage = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <script type="application/json" id="snapshot-data">
${serialized}
  </script>
  <script>
    const el = document.getElementById('snapshot-data');
    window.__recovered_snapshot = JSON.parse(el.textContent);
  </script>
</body>
</html>`;

  // Verify that an HTML parser searching for script boundary only finds the real </script>
  const scriptRegex = /<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/i;
  const match = htmlPage.match(scriptRegex);
  assert.ok(match, 'HTML must contain exactly matching snapshot-data script tag');

  const extractedText = match[1].trim();
  const recovered = JSON.parse(extractedText);

  assert.equal(
    recovered.jobs['job-hostile'].title,
    '</script><script>window.__hostile_code_executed=true;</script>'
  );
  assert.equal(
    recovered.jobs['job-hostile'].company,
    'Exploit Inc <!-- HTML comment -->'
  );
  assert.equal(
    recovered.jobs['job-hostile'].notes,
    '<![CDATA[ <script>eval("evil")</script> ]]> \u003c already escaped'
  );
  assert.equal(
    recovered.jobs['job-hostile'].description,
    'Check <img src=x onerror=alert(1)> and </SCRIPT>'
  );
});

// ============================================================================
// 2. VERIFICATION OF dist/command-center-export.html ARTIFACT
// ============================================================================

suite.test('2.1 Export Artifact File Validation: dist/command-center-export.html', async assert => {
  const exportPath = path.resolve(__dirname, '../../dist/command-center-export.html');
  assert.ok(fs.existsSync(exportPath), 'dist/command-center-export.html must exist');

  const stat = fs.statSync(exportPath);
  assert.ok(stat.size > 20000, `Export file size (${stat.size} bytes) must be substantial (>20KB)`);

  const html = fs.readFileSync(exportPath, 'utf8');

  // Verify DOC TYPE and HTML structure
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'Must start with <!DOCTYPE html>');
  assert.ok(html.includes('</html>'), 'Must contain closing </html>');
  assert.ok(html.includes('<style>'), 'Must contain inlined <style>');
  assert.ok(html.includes('</style>'), 'Must contain closing </style>');

  // Verify Zero Remote Assets
  verifyZeroRemoteAssets(html);

  // Deep scan for remote protocols
  const remoteMatches = html.match(/(?:src|href)\s*=\s*["']?\s*(?:https?:|\/\/)/gi);
  assert.equal(remoteMatches, null, 'No remote src or href in entire document');

  // Verify snapshot element and parseability
  const snapshotMatch = html.match(/<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/i);
  assert.ok(snapshotMatch, 'Must contain snapshot-data script tag');

  const snapshotJson = snapshotMatch[1].trim();
  let parsedSnapshot;
  try {
    parsedSnapshot = JSON.parse(snapshotJson);
  } catch (err) {
    assert.fail(`Failed to parse dist/command-center-export.html snapshot JSON: ${err.message}`);
  }

  assert.ok(parsedSnapshot !== null, 'Snapshot must be non-null');
  assert.equal(parsedSnapshot.mode, 'offline-snapshot', 'Mode must be offline-snapshot');
  assert.ok(typeof parsedSnapshot.version === 'number', 'Version must be a number');
  assert.ok(typeof parsedSnapshot.lastEventId === 'number', 'lastEventId must be a number');
  assert.ok(typeof parsedSnapshot.exportedAt === 'string', 'exportedAt must be a string');
  assert.ok(parsedSnapshot.jobs && typeof parsedSnapshot.jobs === 'object', 'jobs must be an object');
  assert.ok(parsedSnapshot.applications && typeof parsedSnapshot.applications === 'object', 'applications must be an object');
  assert.ok(Array.isArray(parsedSnapshot.decisions), 'decisions must be an array');

  // Verify UI views
  const REQUIRED_VIEWS = [
    'decision-queue',
    'pipeline-board',
    'workbench',
    'evidence-map',
    'runs-timeline'
  ];

  for (const view of REQUIRED_VIEWS) {
    assert.ok(html.includes(`data-view="${view}"`), `Must contain nav button for ${view}`);
    assert.ok(html.includes(`id="view-${view}"`), `Must contain panel section view-${view}`);
  }

  // Strict check: ZERO Today occurrences
  const todayMatches = html.match(/\bToday\b/gi) || [];
  assert.equal(todayMatches.length, 0, `Export must contain ZERO "Today" occurrences, found ${todayMatches.length}`);
});

suite.test('2.2 Sandboxed Execution of dist/command-center-export.html in VM', async assert => {
  const exportPath = path.resolve(__dirname, '../../dist/command-center-export.html');
  const html = fs.readFileSync(exportPath, 'utf8');

  // Extract inlined client script
  const scriptRegex = /<script(?![^>]*id=["']snapshot-data["'])[^>]*>([\s\S]*?)<\/script>/gi;
  let clientScript = null;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    if (match[1].includes('document.addEventListener') || match[1].includes('AppStore') || match[1].includes('CommandCenterApp')) {
      clientScript = match[1];
      break;
    }
  }

  assert.ok(clientScript !== null, 'Must extract client JS from export HTML');

  // Verify clientScript compiles with zero syntax errors via vm.Script
  let compiledScript;
  try {
    compiledScript = new vm.Script(clientScript, { filename: 'command-center-export.js' });
  } catch (err) {
    assert.fail(`Client JS failed compilation in V8 vm.Script: ${err.message}`);
  }
  assert.ok(compiledScript !== undefined, 'Client script compiled successfully');

  // Extract snapshot JSON
  const dataMatch = html.match(/<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/i);
  assert.ok(dataMatch, 'Must find snapshot-data');
  const snapshotRawText = dataMatch[1];

  // Set up headless browser DOM sandbox
  const renderedViews = new Set();
  const mockElements = {
    'snapshot-data': { textContent: snapshotRawText },
    'crew-snapshot-payload': { textContent: snapshotRawText },
    'badge-decisions-count': { textContent: '' },
    'decision-cards-container': { innerHTML: '', appendChild() {} },
    'pipeline-kanban-container': { innerHTML: '', appendChild() {} },
    'workbench-container': { innerHTML: '', appendChild() {} },
    'evidence-container': { innerHTML: '', appendChild() {} },
    'agent-grid-container': { innerHTML: '', appendChild() {} },
    'timeline-container': { innerHTML: '', appendChild() {} },
    'sync-label': { textContent: '' },
    'sync-status': { title: '' },
    'excluded-roles-section': { innerHTML: '' },
    'view-decision-queue': { classList: { add(c) { renderedViews.add(c); }, remove() {} } },
    'view-pipeline-board': { classList: { add(c) { renderedViews.add(c); }, remove() {} } },
    'view-workbench': { classList: { add(c) { renderedViews.add(c); }, remove() {} } },
    'view-evidence-map': { classList: { add(c) { renderedViews.add(c); }, remove() {} } },
    'view-runs-timeline': { classList: { add(c) { renderedViews.add(c); }, remove() {} } },
    'tab-decision-queue': { classList: { add() {}, remove() {} } },
    'tab-pipeline-board': { classList: { add() {}, remove() {} } },
    'tab-workbench': { classList: { add() {}, remove() {} } },
    'tab-evidence-map': { classList: { add() {}, remove() {} } },
    'tab-runs-timeline': { classList: { add() {}, remove() {} } },
    'filter-search': { value: '', addEventListener() {} },
    'filter-channel': { value: 'all', addEventListener() {} },
    'filter-min-score': { value: '0', addEventListener() {} },
    'btn-theme-toggle': { addEventListener() {} },
    'btn-export-html': { setAttribute() {} },
    'btn-close-drawer': { addEventListener() {} },
    'btn-modal-cancel': { addEventListener() {} },
    'btn-modal-confirm-submit': { addEventListener() {} },
    'job-drawer': { classList: { add() {}, remove() {} } },
    'submit-modal': { classList: { add() {}, remove() {} } },
    'modal-submit-token': { value: '' }
  };

  let domContentLoadedHandler = null;
  const storage = new Map();

  const sandbox = {
    console: {
      log: () => {},
      warn: (msg, err) => {
        if (String(msg).includes('Failed to parse offline snapshot')) {
          assert.fail(`Store warned of snapshot parse failure: ${err}`);
        }
      },
      error: (msg, err) => {
        assert.fail(`Console error during execution: ${msg} ${err || ''}`);
      }
    },
    window: {},
    document: {
      documentElement: { setAttribute() {} },
      getElementById(id) { return mockElements[id] || null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener(event, handler) {
        if (event === 'DOMContentLoaded') {
          domContentLoadedHandler = handler;
        }
      }
    },
    sessionStorage: {
      getItem(k) { return storage.get(k) || null; },
      setItem(k, v) { storage.set(k, String(v)); },
      removeItem(k) { storage.delete(k); }
    },
    fetch: async () => {
      assert.fail('fetch() must NEVER be called in offline export mode!');
    },
    URLSearchParams: class {
      constructor() {}
      get() { return null; }
      toString() { return ''; }
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  sandbox.window = sandbox;

  const ctx = vm.createContext(sandbox);
  compiledScript.runInContext(ctx);

  if (domContentLoadedHandler) {
    domContentLoadedHandler();
  }

  assert.ok(true, 'Export client script initialized offline mode successfully without errors or network egress');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true });
}
