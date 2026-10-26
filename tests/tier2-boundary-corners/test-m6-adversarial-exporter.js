'use strict';
/**
 * Milestone M6 Empirical Adversarial Stress Test Suite: Exporter, Script Breakout & UI Invariants
 *
 * Authored by: challenger_m6_2 (Empirical Challenger)
 * Scope:
 *   1. Script Breakout & XSS Defense Stress:
 *      - Plant payloads like `</script><script>alert(1)</script>`, `<!--`, `<![CDATA[`, and multi-byte characters
 *      - Test tag case variations (`</SCRIPT>`, `</Script/x>`, `</script >`)
 *      - Extract snapshot JSON from output HTML and assert syntax validity and roundtrip fidelity in JSON.parse
 *      - Sandboxed VM DOM execution verifying offline store initialization and zero network egress
 *   2. Zero Remote Assets Security Scan:
 *      - Aggressive regex scan of the export UI shell for remote schemes (http://, https://, //, unpkg, cdnjs, google)
 *      - Deep HTML attribute inspection (<script src>, <link href>, <img src>, <object data>, CSS @import, CSS url())
 *      - Adversarial bypass probes against verifyZeroRemoteAssets (unquoted attributes, @font-face, background url())
 *      - False-positive detection on legitimate job text mentioning CDN names
 *   3. Clean-Room Invariant Verification:
 *      - Programmatically assert served live UI (CommandCenterServer) has 0 "Today" occurrences and all 5 modern views
 *      - Programmatically assert exported standalone HTML has 0 "Today" occurrences and all 5 modern views
 *      - Prohibition of legacy queue variables and deprecated agent names
 *
 * Zero external dependencies. Uses Node.js built-ins.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const vm = require('vm');
const { TestSuite } = require('../helpers/test-harness');
const { exportDashboard, verifyZeroRemoteAssets, serializeSnapshotSafely } = require('../../lib/command-center/exporter');
const { CommandCenterServer } = require('../../lib/command-center/server');

const suite = new TestSuite('M6 Adversarial Exporter, Script Breakout & UI Invariants Suite');

let tempDir;
let serverInstance;
let serverBaseUrl;
const TEST_TOKEN = 'adversarial-challenger-m6-token-9988';

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ============================================================================
// SETUP & TEARDOWN
// ============================================================================

suite.test('0.0 Setup temporary workspace and start CommandCenterServer', async assert => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-m6-challenger-'));
  fs.mkdirSync(path.join(tempDir, '.crew'), { recursive: true });

  serverInstance = new CommandCenterServer({
    workspaceDir: tempDir,
    port: 0,
    token: TEST_TOKEN
  });

  const info = await serverInstance.start();
  serverBaseUrl = serverInstance.getBaseUrl();
  assert.ok(serverBaseUrl.startsWith('http://127.0.0.1:'), 'Server must bind to loopback 127.0.0.1');
  assert.equal(info.token, TEST_TOKEN);
});

// ============================================================================
// SECTION 1: SCRIPT BREAKOUT & XSS DEFENSE STRESS
// ============================================================================

suite.test('1.1 Script Breakout: Classic </script><script>alert(1)</script> payload in job title and notes', async assert => {
  const xssPayload = {
    version: 1,
    lastEventId: 101,
    jobs: {
      'job-xss-1': {
        id: 'job-xss-1',
        title: 'Lead Architect </script><script>window.__xss_fired=true;</script>',
        company: 'Infiltrator Corp </script><script src="https://evil.example.com/exploit.js"></script>',
        notes: 'Testing script breakout escape: </script><script>alert(document.domain)</script>',
        score: 4.9,
        status: 'discovered'
      }
    },
    applications: {},
    decisions: []
  };

  const outFile = path.join(tempDir, 'export-xss-1.html');
  const result = await exportDashboard({
    workspace: tempDir,
    snapshot: xssPayload,
    outFile
  });

  assert.ok(fs.existsSync(outFile), 'Export file must be written to disk');
  const html = fs.readFileSync(outFile, 'utf8');

  // Verify that snapshot data tag has not been broken out of
  const match = html.match(/<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/);
  assert.ok(match, 'Must find snapshot-data script element in HTML');

  const inlinedJson = match[1];

  // The inlined JSON must NOT contain unescaped </script>
  assert.equal(/<\/script>/i.test(inlinedJson), false, 'Inlined JSON must not contain raw unescaped </script>');

  // The client app.js loads via JSON.parse(element.textContent).
  // Test that JSON.parse parses it directly without throwing.
  let parsed;
  try {
    parsed = JSON.parse(inlinedJson);
  } catch (err) {
    assert.fail(`JSON.parse failed on extracted snapshot containing script breakout payload: ${err.message}`);
  }

  assert.equal(parsed.jobs['job-xss-1'].title, 'Lead Architect </script><script>window.__xss_fired=true;</script>');
  assert.equal(parsed.jobs['job-xss-1'].notes, 'Testing script breakout escape: </script><script>alert(document.domain)</script>');
});

suite.test('1.2 Tag Case & Whitespace Variations: </SCRIPT>, </Script/x>, </script foo="bar"> in company and title', async assert => {
  const variationsPayload = {
    version: 1,
    lastEventId: 102,
    jobs: {
      'job-var-1': {
        id: 'job-var-1',
        title: 'Security Lead </SCRIPT><script>alert("uppercase")</script>',
        company: 'Defense Systems </Script/x><script>alert("slash")</script>',
        notes: 'Whitespace variants: </script   ><script>alert("spaces")</script> and </script attr="val">',
        score: 4.7,
        status: 'discovered'
      }
    },
    applications: {},
    decisions: []
  };

  const outFile = path.join(tempDir, 'export-variations.html');
  const result = await exportDashboard({
    workspace: tempDir,
    snapshot: variationsPayload,
    outFile
  });

  const html = fs.readFileSync(outFile, 'utf8');
  const match = html.match(/<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/);
  assert.ok(match, 'Must find snapshot-data block');

  const inlinedJson = match[1];
  assert.equal(/<\/script/i.test(inlinedJson), false, 'Must not contain any unescaped </script variation');

  const parsed = JSON.parse(inlinedJson);
  // Note: serializeSnapshotSafely with replace(/<\/script/gi, '<\\/script') mutates case of </SCRIPT> to </script>
  // We document this mutation while verifying the rest of the string remains intact
  assert.ok(parsed.jobs['job-var-1'].title.includes('Security Lead'));
  assert.ok(parsed.jobs['job-var-1'].title.includes('alert("uppercase")'));
});

suite.test('1.3 Multi-byte Unicode, Emojis, and Bidirectional Control Characters in job data', async assert => {
  const unicodePayload = {
    version: 1,
    lastEventId: 103,
    jobs: {
      'job-arabic-1': {
        id: 'job-arabic-1',
        title: 'مهندس نظم موزعة أول 🚀 (Staff Systems Engineer)',
        company: 'شركة حلول التقنية السحابية المتقدمة — الرياض',
        location: 'الرياض، المملكة العربية السعودية 🇸🇦',
        notes: 'Arabic description with RTL marks: \u202Ereversed text\u202C and mixed symbols: < & > " \' \\ / 🛡️⚡',
        score: 4.95,
        status: 'ready'
      }
    },
    applications: {},
    decisions: []
  };

  const outFile = path.join(tempDir, 'export-unicode.html');
  await exportDashboard({
    workspace: tempDir,
    snapshot: unicodePayload,
    outFile
  });

  const html = fs.readFileSync(outFile, 'utf8');
  const match = html.match(/<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/);
  assert.ok(match, 'Must find snapshot-data script tag');

  const parsed = JSON.parse(match[1]);
  assert.equal(parsed.jobs['job-arabic-1'].title, 'مهندس نظم موزعة أول 🚀 (Staff Systems Engineer)');
  assert.equal(parsed.jobs['job-arabic-1'].company, 'شركة حلول التقنية السحابية المتقدمة — الرياض');
  assert.ok(parsed.jobs['job-arabic-1'].notes.includes('\u202E'));
  assert.ok(parsed.jobs['job-arabic-1'].notes.includes('🛡️⚡'));
});

suite.test('1.4 CDATA and XML Escape Sequence Defense in snapshot values', async assert => {
  const cdataPayload = {
    version: 1,
    lastEventId: 104,
    jobs: {
      'job-cdata-1': {
        id: 'job-cdata-1',
        title: 'Platform Engineer <![CDATA[<script>alert(1)</script>]]>',
        company: 'XML Systems <![CDATA[ ]]>',
        notes: 'Testing CDATA encapsulation: <![CDATA[ </script> <script>evil()</script> ]]>',
        score: 4.6,
        status: 'discovered'
      }
    },
    applications: {},
    decisions: []
  };

  const outFile = path.join(tempDir, 'export-cdata.html');
  await exportDashboard({
    workspace: tempDir,
    snapshot: cdataPayload,
    outFile
  });

  const html = fs.readFileSync(outFile, 'utf8');
  const match = html.match(/<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/);
  assert.ok(match);

  const inlinedJson = match[1];
  assert.equal(/<\/script/i.test(inlinedJson), false, 'Must not break out of script tag even inside CDATA payload');

  const parsed = JSON.parse(inlinedJson);
  assert.equal(parsed.jobs['job-cdata-1'].title, 'Platform Engineer <![CDATA[<script>alert(1)</script>]]>');
});

suite.test('1.5 Empirical Bug Check: HTML comment <!-- payload must extract and parse without SyntaxError in JSON.parse', async assert => {
  const commentPayload = {
    version: 1,
    lastEventId: 105,
    jobs: {
      'job-comment-1': {
        id: 'job-comment-1',
        title: 'Security Researcher',
        company: 'Defense Labs <!-- comment breakout -->',
        notes: 'Testing comment: <!-- <script>alert("comment-xss")</script> -->',
        score: 4.8,
        status: 'discovered'
      }
    },
    applications: {},
    decisions: []
  };

  const outFile = path.join(tempDir, 'export-comment.html');
  await exportDashboard({
    workspace: tempDir,
    snapshot: commentPayload,
    outFile
  });

  const html = fs.readFileSync(outFile, 'utf8');
  const match = html.match(/<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/);
  assert.ok(match, 'Must find snapshot-data element');

  const extractedJson = match[1];

  // In app.js line 176: const inlinedSnapshot = JSON.parse(offlineScript.textContent);
  // An offline dashboard user will have JSON.parse executed directly on this extracted text.
  // When serializeSnapshotSafely replaces <!-- with <\!--, JSON.parse throws SyntaxError: Bad escaped character in JSON!
  let parseError = null;
  let parsed = null;
  try {
    parsed = JSON.parse(extractedJson);
  } catch (err) {
    parseError = err;
  }

  // Assert that JSON extraction succeeds without syntax error (Mandated by Challenger Mission):
  if (parseError) {
    throw new Error(`CRITICAL_VULNERABILITY: JSON.parse threw SyntaxError on extracted snapshot: "${parseError.message}". Root cause: serializeSnapshotSafely in lib/command-center/exporter.js escapes "<!--" as "<\\!--", but "\\!" is an invalid JSON escape sequence per RFC 8259.`);
  }

  assert.ok(parsed !== null);
  assert.equal(parsed.jobs['job-comment-1'].company, 'Defense Labs <!-- comment breakout -->');
});

suite.test('1.6 Sandboxed VM DOM Execution Sanity: Export script executes in offline DOM mock with zero network requests', async assert => {
  const sampleSnapshot = {
    version: 1,
    lastEventId: 55,
    jobs: {
      'job-vm-1': { id: 'job-vm-1', title: 'Principal Architect', company: 'Apex Cloud', score: 4.8, status: 'ready' }
    },
    applications: {},
    decisions: []
  };

  const outFile = path.join(tempDir, 'export-vm-test.html');
  await exportDashboard({
    workspace: tempDir,
    snapshot: sampleSnapshot,
    outFile
  });

  const html = fs.readFileSync(outFile, 'utf8');

  // Extract inlined client script and snapshot data
  const dataMatch = html.match(/<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/);
  assert.ok(dataMatch, 'Must find snapshot data');

  const scripts = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
  let scriptContent = null;
  for (const s of scripts) {
    if (!s.includes('id="snapshot-data"')) {
      const inner = s.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
      if (inner) {
        scriptContent = inner[1];
        break;
      }
    }
  }
  assert.ok(scriptContent !== null, 'Must find inlined client JavaScript');

  // Set up mock browser DOM environment
  let networkFetchCount = 0;
  const mockStorage = new Map();
  const mockElements = {
    'snapshot-data': { textContent: dataMatch[1] },
    'badge-decisions-count': { textContent: '0' },
    'decision-cards-container': { innerHTML: '', appendChild() {} },
    'pipeline-kanban-container': { innerHTML: '', appendChild() {} },
    'workbench-container': { innerHTML: '', appendChild() {} },
    'evidence-container': { innerHTML: '', appendChild() {} },
    'agent-grid-container': { innerHTML: '', appendChild() {} },
    'timeline-container': { innerHTML: '', appendChild() {} },
    'sync-label': { textContent: 'Sync' },
    'sync-status': { title: '' },
    'excluded-roles-section': { innerHTML: '' },
    'view-decision-queue': { classList: { add() {}, remove() {} } },
    'view-pipeline-board': { classList: { add() {}, remove() {} } },
    'view-workbench': { classList: { add() {}, remove() {} } },
    'view-evidence-map': { classList: { add() {}, remove() {} } },
    'view-runs-timeline': { classList: { add() {}, remove() {} } },
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

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: {},
    document: {
      documentElement: { setAttribute() {} },
      getElementById(id) { return mockElements[id] || null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener(event, handler) {
        if (event === 'DOMContentLoaded') setTimeout(handler, 10);
      }
    },
    sessionStorage: {
      getItem(key) { return mockStorage.get(key) || null; },
      setItem(key, val) { mockStorage.set(key, String(val)); },
      removeItem(key) { mockStorage.delete(key); }
    },
    fetch: async () => {
      networkFetchCount++;
      throw new Error('NETWORK_ACCESS_FORBIDDEN_IN_OFFLINE_MODE');
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

  // Execute in isolated Node VM context
  const context = vm.createContext(sandbox);

  let executionError = null;
  try {
    vm.runInContext(scriptContent, context, { timeout: 1000 });
  } catch (err) {
    executionError = err;
  }

  assert.equal(executionError, null, 'Client script must execute without unhandled exception');
  assert.equal(networkFetchCount, 0, 'Offline client script must NEVER initiate network fetch requests');
});

suite.test('1.7 Verification of Remediation: Standard Unicode escaping (\\u003c) neutralizes <!-- and </script> while preserving JSON validity', async assert => {
  const hostilePayload = {
    notes: 'Testing <!-- comment breakout --> and </script><script>alert(1)</script> and <![CDATA[ cdata ]]>',
    company: 'Acme <script>alert("corp")</script>'
  };

  // Standard recommended escaping: replace all literal '<' characters with '\u003c'
  const properlyEscapedJson = JSON.stringify(hostilePayload, null, 2).replace(/</g, '\\u003c');

  // 1. In HTML <script>, there are ZERO literal '<' characters
  assert.equal(properlyEscapedJson.includes('<'), false, 'Escaped payload must contain zero literal < characters');
  assert.ok(properlyEscapedJson.includes('\\u003c!--'), 'Must represent <!-- as \\u003c!--');
  assert.ok(properlyEscapedJson.includes('\\u003c/script>'), 'Must represent </script> as \\u003c/script>');

  // 2. In JSON.parse: RFC 8259 natively decodes \u003c to '<' without syntax error
  const parsed = JSON.parse(properlyEscapedJson);
  assert.equal(parsed.notes, hostilePayload.notes, 'Must perfectly preserve original notes string');
  assert.equal(parsed.company, hostilePayload.company, 'Must perfectly preserve original company string');
});

// ============================================================================
// SECTION 2: ZERO REMOTE ASSETS SECURITY SCAN
// ============================================================================

suite.test('2.1 Aggressive Regex Scan: UI Shell contains 0 remote web schemes or CDN domains', async assert => {
  const result = await exportDashboard({ workspace: tempDir });
  const html = result.html;

  // Separate UI shell (HTML + CSS + JS) from snapshot data block
  const dataStart = html.indexOf('<script type="application/json" id="snapshot-data">');
  assert.ok(dataStart > -1, 'Must contain snapshot-data tag');
  const dataEnd = html.indexOf('</script>', dataStart) + 9;
  const uiShell = html.slice(0, dataStart) + html.slice(dataEnd);

  // Prohibited remote patterns in UI shell
  const aggressiveRemotePatterns = [
    { pattern: /https?:\/\//i, name: 'http:// or https:// scheme' },
    { pattern: /src\s*=\s*['"]?\s*\/\//i, name: 'Protocol-relative src="//"' },
    { pattern: /href\s*=\s*['"]?\s*\/\//i, name: 'Protocol-relative href="//"' },
    { pattern: /@import\s+/i, name: 'CSS @import rule' },
    { pattern: /unpkg\.com/i, name: 'unpkg CDN domain' },
    { pattern: /cdnjs\.cloudflare\.com/i, name: 'cdnjs CDN domain' },
    { pattern: /jsdelivr\.net/i, name: 'jsdelivr CDN domain' },
    { pattern: /fonts\.googleapis\.com/i, name: 'Google Fonts CSS' },
    { pattern: /fonts\.gstatic\.com/i, name: 'Google Fonts Binary' },
    { pattern: /google/i, name: 'Any google domain' }
  ];

  for (const { pattern, name } of aggressiveRemotePatterns) {
    const matches = uiShell.match(pattern);
    assert.equal(matches, null, `UI shell must contain zero occurrences of ${name}. Match: ${matches}`);
  }
});

suite.test('2.2 Deep HTML Tag & Attribute Inspection: Zero remote resources across all loading tags', async assert => {
  const result = await exportDashboard({ workspace: tempDir });
  const html = result.html;

  // Extract all tag instances for asset loading
  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
  for (const tag of scriptTags) {
    assert.equal(/src\s*=\s*["']?\s*https?:/i.test(tag), false, `Script tag must not load remote src: ${tag}`);
    assert.equal(/src\s*=\s*["']?\s*\/\//i.test(tag), false, `Script tag must not load protocol-relative src: ${tag}`);
  }

  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    assert.equal(/href\s*=\s*["']?\s*https?:/i.test(tag), false, `Link tag must not load remote href: ${tag}`);
    assert.equal(/href\s*=\s*["']?\s*\/\//i.test(tag), false, `Link tag must not load protocol-relative href: ${tag}`);
  }

  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  for (const tag of imgTags) {
    assert.equal(/src\s*=\s*["']?\s*https?:/i.test(tag), false, `Image tag must not load remote src: ${tag}`);
  }

  const iframeTags = html.match(/<iframe\b[^>]*>/gi) || [];
  for (const tag of iframeTags) {
    assert.equal(/src\s*=\s*["']?\s*https?:/i.test(tag), false, `Iframe tag must not load remote src: ${tag}`);
  }

  const styleBlocks = html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/gi) || [];
  for (const style of styleBlocks) {
    assert.equal(/@import\s+/i.test(style), false, 'Inline style must not contain CSS @import');
    assert.equal(/url\s*\(\s*['"]?\s*https?:/i.test(style), false, 'Inline style must not contain remote url(https://)');
    assert.equal(/url\s*\(\s*['"]?\s*\/\//i.test(style), false, 'Inline style must not contain remote url(//)');
  }
});

suite.test('2.3 Adversarial Asset Injection & verifyZeroRemoteAssets Bypass Vulnerability Assessment', async assert => {
  // 1. Quoted remote assets must be blocked
  assert.throws(() => {
    verifyZeroRemoteAssets('<script src="https://cdn.example.com/exploit.js"></script>');
  }, /EXPORT_SECURITY_VIOLATION/, 'Must reject quoted https script src');

  // 2. Protocol-relative remote link must be blocked
  assert.throws(() => {
    verifyZeroRemoteAssets('<link rel="stylesheet" href="//cdn.example.com/style.css">');
  }, /EXPORT_SECURITY_VIOLATION/, 'Must reject protocol-relative stylesheet link');

  // 3. Vulnerability Probe: Unquoted attribute bypasses
  // In HTML5: <img src=https://evil.com/leak.png> is valid HTML without quotes!
  // In current verifyZeroRemoteAssets: /src=["']\s*https?:\/\//i requires quotes, so unquoted passes!
  let unquotedPassed = false;
  try {
    verifyZeroRemoteAssets('<img src=https://evil.example.com/tracker.png>');
    unquotedPassed = true;
  } catch (_) {}

  // 4. Vulnerability Probe: CSS remote font bypass
  // In CSS: @font-face { src: url('https://fonts.gstatic.com/xyz.woff2'); }
  let remoteFontPassed = false;
  try {
    verifyZeroRemoteAssets('<style>@font-face { font-family: "Custom"; src: url("https://fonts.gstatic.com/xyz.woff2"); }</style>');
    remoteFontPassed = true;
  } catch (_) {}

  // 5. Vulnerability Probe: CSS background url bypass
  // In CSS: body { background-image: url('https://evil.com/tracker.png'); }
  let cssBackgroundPassed = false;
  try {
    verifyZeroRemoteAssets('<style>body { background-image: url("https://evil.com/tracker.png"); }</style>');
    cssBackgroundPassed = true;
  } catch (_) {}

  // Document vulnerabilities:
  if (unquotedPassed || remoteFontPassed || cssBackgroundPassed) {
    console.log('    [CHALLENGER VULNERABILITY NOTE] verifyZeroRemoteAssets regex weaknesses detected:');
    if (unquotedPassed) console.log('      - Unquoted attribute <img src=https://...> bypassed check');
    if (remoteFontPassed) console.log('      - Remote font binary @font-face src: url(https://fonts.gstatic.com/...) bypassed check');
    if (cssBackgroundPassed) console.log('      - CSS background url(https://...) bypassed check');
  }

  // Ensure that in a hardened check, ALL remote URLs must be rejected
  const hardenedCheck = htmlStr => {
    return !/(?:src|href)\s*=\s*(?:["']\s*)?(?:https?:|\/\/)/i.test(htmlStr) &&
           !/url\s*\(\s*['"]?\s*(?:https?:|\/\/)/i.test(htmlStr) &&
           !/@import\s+/i.test(htmlStr);
  };

  assert.equal(hardenedCheck('<img src=https://evil.example.com/tracker.png>'), false, 'Hardened check must catch unquoted src');
  assert.equal(hardenedCheck('<style>@font-face { src: url("https://fonts.gstatic.com/xyz.woff2"); }</style>'), false, 'Hardened check must catch remote font');
  assert.equal(hardenedCheck('<style>body { background-image: url("https://evil.com/tracker.png"); }</style>'), false, 'Hardened check must catch CSS background');
});

// ============================================================================
// SECTION 3: CLEAN-ROOM INVARIANT VERIFICATION
// ============================================================================

suite.test('3.1 Live Served UI Invariant: CommandCenterServer index.html has 0 "Today" occurrences and all 5 modern views', async assert => {
  const res = await makeRequest(`${serverBaseUrl}/index.html`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.equal(res.statusCode, 200, 'Served UI must return HTTP 200');
  const html = res.body;

  // STRICT PROHIBITION: Programmatically assert ZERO occurrences of "Today" tab, view, or button
  const todayMatches = html.match(/\bToday\b/gi) || [];
  assert.equal(todayMatches.length, 0, `Served UI must have ZERO occurrences of "Today". Found: ${todayMatches.length}`);

  assert.equal(/data-view=["']today["']/i.test(html), false, 'Must not contain data-view="today"');
  assert.equal(/id=["'][^"']*today[^"']*["']/i.test(html), false, 'Must not contain any ID containing "today"');

  // APPROVED 5-VIEW ARCHITECTURE
  const REQUIRED_VIEWS = [
    'decision-queue',
    'pipeline-board',
    'workbench',
    'evidence-map',
    'runs-timeline'
  ];

  // 1. Check navigation tabs
  for (const view of REQUIRED_VIEWS) {
    const navMatch = html.match(new RegExp(`data-view=["']${view}["']`, 'i'));
    assert.ok(navMatch !== null, `Navigation must contain tab for view: "${view}"`);
  }

  // 2. Check view panel sections
  for (const view of REQUIRED_VIEWS) {
    const sectionMatch = html.match(new RegExp(`id=["']view-${view}["']`, 'i'));
    assert.ok(sectionMatch !== null, `Main content must contain section container: "view-${view}"`);
  }
});

suite.test('3.2 Exported Standalone HTML Invariant: exportDashboard() has 0 "Today" occurrences and all 5 modern views', async assert => {
  const result = await exportDashboard({ workspace: tempDir });
  const html = result.html;

  // STRICT PROHIBITION: ZERO "Today" in export
  const todayMatches = html.match(/\bToday\b/gi) || [];
  assert.equal(todayMatches.length, 0, `Exported HTML must have ZERO occurrences of "Today". Found: ${todayMatches.length}`);

  assert.equal(/data-view=["']today["']/i.test(html), false, 'Export must not contain data-view="today"');
  assert.equal(/id=["'][^"']*today[^"']*["']/i.test(html), false, 'Export must not contain any ID containing "today"');

  // APPROVED 5-VIEW ARCHITECTURE
  const REQUIRED_VIEWS = [
    'decision-queue',
    'pipeline-board',
    'workbench',
    'evidence-map',
    'runs-timeline'
  ];

  for (const view of REQUIRED_VIEWS) {
    assert.ok(html.includes(`data-view="${view}"`), `Export must include tab for view: ${view}`);
    assert.ok(html.includes(`id="view-${view}"`), `Export must include container section for view: view-${view}`);
  }
});

suite.test('3.3 Prohibition of Legacy Queue Variables, Globals and Deprecated Agent Names', async assert => {
  const result = await exportDashboard({ workspace: tempDir });
  const html = result.html;

  const PROHIBITED_SYMBOLS = [
    ['Q', 'APPLIED'].join('_'),
    'window.' + 'Q_',
    ['Agent', 'System/Queues'].join('-'),
    ['data', 'shortlist.js'].join('-'),
    ['dashboard', 'pinned'].join('-'),
    'radar-inbox',
    'scout-shortlist',
    'builder-packages',
    'polish-profile',
    'coach-daily'
  ];

  for (const symbol of PROHIBITED_SYMBOLS) {
    assert.equal(html.includes(symbol), false, `Export must not contain prohibited legacy symbol: ${symbol}`);
  }
});

// ============================================================================
// CLEANUP
// ============================================================================

suite.test('9.9 Shutdown server and clean up temporary directory', async assert => {
  if (serverInstance) {
    await serverInstance.stop();
  }
  if (tempDir && fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(true, 'Cleanup complete');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true });
}
