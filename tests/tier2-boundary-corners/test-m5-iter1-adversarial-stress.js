'use strict';
/**
 * Milestone M5 Iteration 1 Empirical Adversarial Stress Test Suite
 *
 * Authored by: challenger_m5_1 (Empirical Challenger)
 * Scope: Milestone M5 Subsystems:
 *   1. Sidecar Generator & URI Handling Stress (`lib/setup-antigravity-tasks.js`):
 *      - Windows paths with spaces, UNC network paths, URI-sensitive symbols, trailing slashes.
 *      - Invalid/boundary hours (<0, >23, NaN, float, string) and midnight wrapping (0, 22, 23).
 *      - Timezones and non-existent workspace directory recursive creation.
 *      - Strict Antigravity Scheduled Tasks sidecar schema conformance across all 7 agents.
 *   2. Claude Plugin Compiler & Zip Builder Adversarial Stress (`lib/compiler/claude-plugin.js`):
 *      - Skill descriptions with nested/unclosed XML tags, angle brackets, math operators.
 *      - Guaranteed zero `<` or `>` characters in YAML frontmatter.
 *      - Zip builder boundaries: empty directory (22-byte EOCD), large files (1MB+), special character filenames.
 *   3. Operational Diagnostics & Doctor Stress (`lib/operational/diagnostics.js` & `bin/crew.js`):
 *      - Synthetic corruptions via real CLI subprocess execution (`crew doctor` and `crew doctor --fix`).
 *      - Tampered ledger hash chain critical failure and refusal of --fix to silently overwrite.
 *      - Dead PID lockfile detection and cleanup.
 *      - Active foreign lockfile protection against premature deletion.
 *      - Missing `.pii-denylist` critical failure and repair.
 *      - Malformed sidecar JSON and cron syntax error detection.
 *
 * Zero external dependencies. Uses pure Node.js built-ins.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { TestSuite, assert } = require('../helpers/test-harness');

const {
  toWorkspaceUri,
  generateSidecarConfigs,
  installSidecars
} = require('../../lib/setup-antigravity-tasks');

const { ClaudePluginCompiler } = require('../../lib/compiler/claude-plugin');
const { MiniZipBuilder } = require('../../lib/honest-cv/doc-generator');
const { runDiagnostics } = require('../../lib/operational/diagnostics');
const { EventLedger } = require('../../lib/ledger/ledger');

const CREW_BIN = path.resolve(__dirname, '../../bin/crew.js');

const suite = new TestSuite('M5 Iteration 1 Adversarial Stress & Operational Doctor Suite');

// Helper to run CLI crew command safely
function runCrewCli(args, cwd) {
  try {
    const stdout = execSync(`node "${CREW_BIN}" ${args}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status || 1,
      stdout: err.stdout ? err.stdout.toString('utf8') : '',
      stderr: err.stderr ? err.stderr.toString('utf8') : ''
    };
  }
}

// ============================================================================
// SECTION 1: Sidecar Generator & URI Handling Stress
// ============================================================================

suite.test('1.1 toWorkspaceUri: handles Windows drive paths with spaces and nested spaces', () => {
  const uri = toWorkspaceUri('C:\\Users\\fictional user\\Desktop\\Job Search 2026\\project');
  assert.ok(uri.startsWith('file:///C:/Users/fictional%20user/Desktop/Job%20Search%202026/project'),
    `Expected URI to contain properly encoded spaces, got: ${uri}`);
  assert.ok(!uri.includes(' '), 'URI must not contain raw unencoded space characters');
});

suite.test('1.2 toWorkspaceUri: handles UNC network paths cleanly', () => {
  const uri = toWorkspaceUri('\\\\network-host\\shares\\job search\\workspace');
  assert.ok(uri.startsWith('file://'), `UNC path URI must start with file://, got: ${uri}`);
  assert.ok(uri.includes('network-host'), 'Must include host');
  assert.ok(uri.includes('shares'), 'Must include share name');
  assert.ok(uri.includes('job%20search'), 'Must percent-encode spaces in UNC paths');
  assert.ok(!uri.includes(' '), 'UNC URI must not contain raw spaces');
});

suite.test('1.3 toWorkspaceUri: percent-encodes URI-sensitive symbols', () => {
  const uri = toWorkspaceUri('C:\\workspace\\test#hash?query[brackets]&amp+plus%perc');
  assert.ok(uri.includes('%23'), 'Hash # must be percent-encoded');
  assert.ok(uri.includes('%3F'), 'Question mark ? must be percent-encoded');
  assert.ok(uri.includes('%5B'), 'Left bracket [ must be percent-encoded');
  assert.ok(uri.includes('%5D'), 'Right bracket ] must be percent-encoded');
  assert.ok(uri.includes('%26'), 'Ampersand & must be percent-encoded');
  assert.ok(uri.includes('%2B'), 'Plus + must be percent-encoded');
  assert.ok(uri.includes('%25'), 'Percent % must be percent-encoded');
});

suite.test('1.4 toWorkspaceUri: handles mixed forward/backslashes and redundant trailing slashes', () => {
  const uri1 = toWorkspaceUri('C:/mixed\\slashes/dir///');
  const uri2 = toWorkspaceUri('C:\\mixed/slashes\\dir');
  assert.ok(!uri1.endsWith('/'), 'URI must not end with trailing slash');
  assert.equal(uri1, uri2, 'Mixed slash variants must produce identical normalized URI');
});

suite.test('1.5 generateSidecarConfigs: invalid hours (<0, >23, NaN, float, string) fallback to default 8', () => {
  const invalidHours = [-5, -1, 24, 25, 100, NaN, 8.5, '9', null, undefined, {}];
  for (const h of invalidHours) {
    const cfgs = generateSidecarConfigs({ hour: h });
    const dispatcherCron = cfgs['jobhunt-crew-dispatcher'].cron;
    assert.ok(dispatcherCron.includes('0 8 * * *'), `Hour ${h} should fallback to default 8:00 AM, got: ${dispatcherCron}`);
  }
});

suite.test('1.6 generateSidecarConfigs: boundary hours (0, 22, 23) wrap cleanly past midnight', () => {
  // Midnight start (Hour 0)
  const cfg0 = generateSidecarConfigs({ hour: 0 });
  assert.ok(cfg0['jobhunt-crew-dispatcher'].cron.includes('0 0 * * *'));
  assert.ok(cfg0['jobhunt-crew-scribe'].cron.includes('15 1 * * *'));
  assert.ok(cfg0['jobhunt-crew-critic'].cron.includes('0 2 * * *'));

  // Hour 22: Scribe runs at 23:15, Critic runs at 00:00 (next day)
  const cfg22 = generateSidecarConfigs({ hour: 22 });
  assert.ok(cfg22['jobhunt-crew-dispatcher'].cron.includes('0 22 * * *'));
  assert.ok(cfg22['jobhunt-crew-scribe'].cron.includes('15 23 * * *'));
  assert.ok(cfg22['jobhunt-crew-critic'].cron.includes('0 0 * * *'));
  assert.ok(cfg22['jobhunt-crew-liaison'].cron.includes('15 0 * * *'));

  // Hour 23: Recon runs at 23:30, Scribe runs at 00:15, Critic runs at 01:00
  const cfg23 = generateSidecarConfigs({ hour: 23 });
  assert.ok(cfg23['jobhunt-crew-dispatcher'].cron.includes('0 23 * * *'));
  assert.ok(cfg23['jobhunt-crew-recon'].cron.includes('30 23 * * *'));
  assert.ok(cfg23['jobhunt-crew-scribe'].cron.includes('15 0 * * *'));
  assert.ok(cfg23['jobhunt-crew-inquisitor'].cron.includes('45 0 * * *'));
  assert.ok(cfg23['jobhunt-crew-critic'].cron.includes('0 1 * * *'));
});

suite.test('1.7 generateSidecarConfigs: timezone handling and empty string fallback', () => {
  const cfgRiyadh = generateSidecarConfigs({ timezone: 'Asia/Riyadh' });
  assert.ok(cfgRiyadh['jobhunt-crew-dispatcher'].cron.startsWith('CRON_TZ=Asia/Riyadh'));

  const cfgUtc = generateSidecarConfigs({ timezone: 'UTC' });
  assert.ok(cfgUtc['jobhunt-crew-dispatcher'].cron.startsWith('CRON_TZ=UTC'));

  const cfgEmpty = generateSidecarConfigs({ timezone: '' });
  assert.ok(cfgEmpty['jobhunt-crew-dispatcher'].cron.startsWith('CRON_TZ=Asia/Riyadh'), 'Empty timezone should default to Asia/Riyadh');
});

suite.test('1.8 generateSidecarConfigs & installSidecars: non-existent workspace directory creates sidecars strictly conforming to schema', () => {
  const tmpDir = path.join(os.tmpdir(), `crew-sidecar-adversarial-${Date.now()}`);
  assert.ok(!fs.existsSync(tmpDir), 'Workspace directory must not exist prior to test');

  try {
    const cfgs = generateSidecarConfigs({ workspace: tmpDir, hour: 9, timezone: 'Asia/Riyadh' });
    const agentIds = Object.keys(cfgs);
    assert.equal(agentIds.length, 7, 'Must generate sidecars for all 7 crew agents');

    const expectedAgents = [
      'jobhunt-crew-dispatcher',
      'jobhunt-crew-recon',
      'jobhunt-crew-scribe',
      'jobhunt-crew-inquisitor',
      'jobhunt-crew-critic',
      'jobhunt-crew-liaison',
      'jobhunt-crew-navigator'
    ];

    for (const expected of expectedAgents) {
      assert.ok(agentIds.includes(expected), `Missing agent sidecar: ${expected}`);
      const cfg = cfgs[expected];
      assert.equal(cfg.builtin, 'schedule', `${expected}: builtin must be "schedule"`);
      assert.ok(cfg.cron.startsWith('CRON_TZ=Asia/Riyadh'), `${expected}: cron must specify CRON_TZ`);
      const cronParts = cfg.cron.replace(/^CRON_TZ=\S+\s+/, '').split(/\s+/);
      assert.equal(cronParts.length, 5, `${expected}: cron must have exactly 5 fields`);
      assert.equal(cfg.restart_policy, 'always', `${expected}: restart_policy must be "always"`);
      assert.ok(Array.isArray(cfg.command) && cfg.command[0] === 'agentapi', `${expected}: command must invoke agentapi`);
      assert.equal(cfg.command[1], 'new-conversation');
      assert.equal(cfg.command[2], '--');
      assert.ok(typeof cfg.command[3] === 'string' && cfg.command[3].length > 20, `${expected}: command prompt must be non-empty`);
      assert.ok(cfg.display_name.startsWith('JobHunt Crew - '), `${expected}: display_name must follow convention`);
      assert.ok(Array.isArray(cfg.agent_permissions.workspace_uris), `${expected}: workspace_uris must be array`);
      assert.ok(cfg.agent_permissions.workspace_uris[0].startsWith('file:///'), `${expected}: URI must start with file:///`);
    }

    // Now install into non-existent directory
    const installed = installSidecars(cfgs, { workspace: tmpDir });
    assert.equal(installed.length, 7, 'Must install 7 sidecar files');
    for (const p of installed) {
      assert.ok(fs.existsSync(p), `Sidecar file must exist on disk: ${p}`);
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.equal(data.builtin, 'schedule');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// SECTION 2: Claude Plugin Compiler & Zip Builder Adversarial Stress
// ============================================================================

suite.test('2.1 sanitizeDescription: purges nested, unclosed, and malformed XML/HTML tags', () => {
  const inputs = [
    '<div class="test">Hello <b>World</b></div>',
    '<<<nested>>><tag attr="val">text</tag><empty/>',
    '<unclosed tag with text',
    '<a href=">">weird quote tag</a>',
    'Mixed <p>Paragraph 1</p> and <br/> Paragraph 2',
    'Empty: <> and empty close </>'
  ];

  for (const input of inputs) {
    const sanitized = ClaudePluginCompiler.sanitizeDescription(input);
    assert.ok(!sanitized.includes('<'), `Sanitized output must contain 0 "<" characters: "${sanitized}"`);
    assert.ok(!sanitized.includes('>'), `Sanitized output must contain 0 ">" characters: "${sanitized}"`);
  }

  // Exact content checks
  assert.equal(ClaudePluginCompiler.sanitizeDescription('<div class="test">Hello <b>World</b></div>'), 'Hello World');
  assert.equal(ClaudePluginCompiler.sanitizeDescription('<unclosed tag with text'), 'unclosed tag with text');
});

suite.test('2.2 sanitizeDescription: sanitizes mathematical inequality operators and angle brackets', () => {
  const inputs = [
    'x < 5 && y > 10',
    'a < b and c > d and e <= f and g >= h',
    'Thresholds: min < 0, max > 100'
  ];

  for (const input of inputs) {
    const sanitized = ClaudePluginCompiler.sanitizeDescription(input);
    assert.ok(!sanitized.includes('<'), `Mathematical angle bracket "<" must be stripped: "${sanitized}"`);
    assert.ok(!sanitized.includes('>'), `Mathematical angle bracket ">" must be stripped: "${sanitized}"`);
  }
});

suite.test('2.3 sanitizeDescription: handles pathological non-string inputs and multiline normalization', () => {
  assert.equal(ClaudePluginCompiler.sanitizeDescription(null), '');
  assert.equal(ClaudePluginCompiler.sanitizeDescription(undefined), '');
  assert.equal(ClaudePluginCompiler.sanitizeDescription(12345), '');
  assert.equal(ClaudePluginCompiler.sanitizeDescription({}), '');
  assert.equal(ClaudePluginCompiler.sanitizeDescription([]), '');

  const multiline = 'Line 1\n  Line 2\r\n\tLine 3  ';
  const clean = ClaudePluginCompiler.sanitizeDescription(multiline);
  assert.equal(clean, 'Line 1 Line 2 Line 3', 'Whitespace and newlines must be normalized to single spaces');
});

suite.test('2.4 formatFrontmatter: guarantees valid YAML frontmatter with zero XML characters', () => {
  const frontmatter = ClaudePluginCompiler.formatFrontmatter({
    name: 'test-skill',
    description: '<div class="banner">Advanced skill for x < 10 & y > 20</div>'
  });

  assert.ok(frontmatter.startsWith('---\n'), 'Must start with YAML fence ---');
  assert.ok(frontmatter.includes('name: test-skill\n'));
  assert.ok(frontmatter.includes('description: "'), 'Description must be quoted string');
  assert.ok(frontmatter.endsWith('---\n\n'), 'Must end with closing fence and double newline');
  assert.ok(!frontmatter.includes('<'), 'Frontmatter must never contain "<"');
  assert.ok(!frontmatter.includes('>'), 'Frontmatter must never contain ">"');

  const quoted = ClaudePluginCompiler.formatFrontmatter({
    name: 'quote-skill',
    description: 'Say "hello" and path\\to\\file'
  });
  const quotedLine = quoted.split('\n').find((line) => line.startsWith('description:'));
  assert.equal(
    quotedLine,
    'description: "Say \\"hello\\" and path\\\\to\\\\file"',
    'Quotes and backslashes must be escaped inside the YAML double-quoted description'
  );
});

suite.test('2.5 ClaudePluginCompiler.build: compiles complete plugin bundle with valid manifest, AGENTS.md, and skills', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-compiler-adversarial-'));
  try {
    const compiler = new ClaudePluginCompiler({
      workspaceDir: path.resolve(__dirname, '../..'),
      outDir: path.join(tmpDir, 'bundle'),
      zip: true,
      zipPath: path.join(tmpDir, 'bundle.zip')
    });

    const result = await compiler.build();
    assert.equal(result.skillsCount, 5, 'Must compile exactly 5 clean-room skills');
    assert.ok(fs.existsSync(result.manifestPath), 'plugin.json must exist');
    assert.ok(fs.existsSync(result.rulesPath), 'rules/AGENTS.md must exist');
    assert.ok(fs.existsSync(result.zipPath), 'bundle.zip must exist');

    // Verify manifest
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.equal(manifest.name, 'jobhunt-crew');
    assert.equal(manifest.license, 'MIT');

    // Verify AGENTS.md has NO frontmatter (strict Claude Cowork invariant)
    const rules = fs.readFileSync(result.rulesPath, 'utf8');
    assert.ok(!rules.startsWith('---'), 'rules/AGENTS.md must not contain frontmatter');
    assert.ok(rules.includes('# JobHunt Crew'), 'rules/AGENTS.md must have markdown header');

    // Verify all 5 skills have valid frontmatter without XML tags
    const skillsDir = path.join(tmpDir, 'bundle', 'skills');
    const skillDirs = fs.readdirSync(skillsDir);
    assert.equal(skillDirs.length, 5);

    for (const sDir of skillDirs) {
      const skillMd = fs.readFileSync(path.join(skillsDir, sDir, 'SKILL.md'), 'utf8');
      assert.ok(skillMd.startsWith('---\n'), `${sDir}: SKILL.md must start with frontmatter`);
      const frontmatterPart = skillMd.split('---')[1];
      assert.ok(!frontmatterPart.includes('<'), `${sDir}: frontmatter must not contain "<"`);
      assert.ok(!frontmatterPart.includes('>'), `${sDir}: frontmatter must not contain ">"`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('2.6 MiniZipBuilder: empty directory produces valid 22-byte PKZIP EOCD structure', () => {
  const zip = new MiniZipBuilder();
  const buffer = zip.build();
  assert.equal(buffer.length, 22, 'Empty archive must be exactly 22 bytes EOCD');
  assert.equal(buffer.readUInt32LE(0), 0x06054b50, 'EOCD signature must match 0x06054b50');
  assert.equal(buffer.readUInt16LE(8), 0, 'Total entries on disk must be 0');
  assert.equal(buffer.readUInt16LE(10), 0, 'Total entries must be 0');
  assert.equal(buffer.readUInt32LE(12), 0, 'Central directory size must be 0');
  assert.equal(buffer.readUInt32LE(16), 0, 'Central directory offset must be 0');
});

suite.test('2.7 MiniZipBuilder: large uncompressible data (1MB) and special character filenames compile cleanly', () => {
  const zip = new MiniZipBuilder();
  const randomPayload = crypto.randomBytes(1024 * 1024); // 1MB random uncompressible data
  const specialFilename = 'nested dir/special & symbols [2026] (v1.0)+test.bin';

  zip.addFile(specialFilename, randomPayload);
  const buffer = zip.build();

  assert.ok(buffer.length >= 1024 * 1024, `Zip size must be >= 1MB (got ${buffer.length})`);
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, 'Local file header signature must match 0x04034b50');
  assert.equal(zip.entries.length, 1);
  assert.equal(zip.entries[0].uncompressedSize, 1024 * 1024);
  assert.equal(zip.entries[0].method, 0, 'Uncompressible random data should use method 0 (STORED)');
});

// ============================================================================
// SECTION 3: Operational Diagnostics & Doctor Stress
// ============================================================================

suite.test('3.1 Synthetic corruption: CLI crew doctor detects tampered ledger hash chain and exits 1', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doc-tamper-cli-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');

    const ledger = new EventLedger({
      ledgerPath: path.join(tmpDir, '.crew', 'ledger.jsonl'),
      lockPath: path.join(tmpDir, '.crew', 'ledger.lock')
    });
    await ledger.appendEvent({ event: 'EVENT_A', payload: { step: 1 }, actor: 'system' });
    await ledger.appendEvent({ event: 'EVENT_B', payload: { step: 2 }, actor: 'system' });

    // Tamper with event B payload directly
    const ledgerFile = path.join(tmpDir, '.crew', 'ledger.jsonl');
    const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
    const evB = JSON.parse(lines[1]);
    evB.payload.step = 999; // Tampered!
    lines[1] = JSON.stringify(evB);
    fs.writeFileSync(ledgerFile, lines.join('\n') + '\n', 'utf8');

    // Run CLI doctor
    const res = runCrewCli(`doctor --workspace "${tmpDir}"`, tmpDir);
    assert.equal(res.code, 1, 'Doctor must exit code 1 when cryptographic ledger is corrupted');
    const combinedOutput = res.stdout + res.stderr;
    assert.ok(combinedOutput.includes('Ledger integrity: CORRUPTED') || combinedOutput.includes('Critical requirements missing'),
      `Output must report corrupted ledger, got: ${combinedOutput}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('3.2 Cryptographic ledger corruption cannot be silently muted or bypassed by crew doctor --fix', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doc-tamper-fix-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');

    const ledger = new EventLedger({
      ledgerPath: path.join(tmpDir, '.crew', 'ledger.jsonl'),
      lockPath: path.join(tmpDir, '.crew', 'ledger.lock')
    });
    await ledger.appendEvent({ event: 'EVENT_1', payload: { test: true }, actor: 'system' });
    await ledger.appendEvent({ event: 'EVENT_2', payload: { test: true }, actor: 'system' });

    // Corrupt prevHash of event 2
    const ledgerFile = path.join(tmpDir, '.crew', 'ledger.jsonl');
    const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
    const ev2 = JSON.parse(lines[1]);
    ev2.prevHash = 'deadbeef00000000000000000000000000000000000000000000000000000000';
    lines[1] = JSON.stringify(ev2);
    fs.writeFileSync(ledgerFile, lines.join('\n') + '\n', 'utf8');

    // Run CLI doctor with --fix
    const res = runCrewCli(`doctor --fix --workspace "${tmpDir}"`, tmpDir);
    assert.equal(res.code, 1, 'Doctor --fix must STILL exit code 1 on cryptographic ledger corruption');
    const combinedOutput = res.stdout + res.stderr;
    assert.ok(combinedOutput.includes('CORRUPTED') || combinedOutput.includes('Critical requirements missing'),
      'Must refuse to silently repair cryptographic hash chain corruption');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('3.3 Synthetic corruption: Dead PID lockfile detected as stale by CLI crew doctor', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doc-deadpid-cli-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');

    const lockPath = path.join(tmpDir, '.crew', 'ledger.lock');
    const staleLock = {
      pid: 99999999, // Dead PID
      hostname: os.hostname(),
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() - 30000).toISOString(),
      time: Date.now() - 60000
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLock), 'utf8');

    // Run programmatic diagnostics
    const diag = await runDiagnostics({ workspace: tmpDir, fix: false });
    const lockProbe = diag.results.find(r => r.probeId === 'CONCURRENCY_LOCK');
    assert.equal(lockProbe.pass, false, 'Lock probe must flag pass: false for stale lock');
    assert.ok(lockProbe.message.includes('STALE LOCK DETECTED'), 'Probe message must indicate stale lock');

    // Run CLI doctor
    const res = runCrewCli(`doctor --workspace "${tmpDir}"`, tmpDir);
    const combinedOutput = res.stdout + res.stderr;
    assert.ok(combinedOutput.includes('STALE LOCK DETECTED (run crew doctor --fix)'),
      `CLI output must explicitly instruct user to run --fix, got: ${combinedOutput}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('3.4 Dead PID lockfile safely remediated and unlinked by CLI crew doctor --fix (exit 0)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doc-deadpid-fix-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');

    // Create a healthy initialized ledger and snapshot so that after lock is removed, doctor passes
    const ledger = new EventLedger({
      ledgerPath: path.join(tmpDir, '.crew', 'ledger.jsonl'),
      lockPath: path.join(tmpDir, '.crew', 'ledger.lock')
    });
    await ledger.appendEvent({ event: 'INIT', payload: {}, actor: 'system' });
    fs.writeFileSync(path.join(tmpDir, '.crew', 'snapshot.json'), JSON.stringify({ version: 1, lastEventId: 1 }), 'utf8');

    // Write dead PID lockfile
    const lockPath = path.join(tmpDir, '.crew', 'ledger.lock');
    const staleLock = {
      pid: 99999999,
      hostname: os.hostname(),
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() - 30000).toISOString(),
      time: Date.now() - 60000
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLock), 'utf8');

    // Run crew doctor --fix
    const res = runCrewCli(`doctor --fix --workspace "${tmpDir}"`, tmpDir);
    assert.equal(res.code, 0, `Doctor --fix must exit 0 after removing stale lock: ${res.stderr}`);
    assert.ok(!fs.existsSync(lockPath), 'Lockfile must be unlinked from disk by --fix');
    assert.ok(res.stdout.includes('STALE LOCK REMOVED (fixed)'), 'Output must indicate stale lock removal');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('3.5 Active foreign lockfile with future lease protected against unlinking even with crew doctor --fix', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doc-foreign-lock-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');

    const lockPath = path.join(tmpDir, '.crew', 'ledger.lock');
    const foreignActiveLock = {
      pid: 4321,
      hostname: 'remote-foreign-node-01',
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120000).toISOString(), // 2 minutes in future
      time: Date.now()
    };
    fs.writeFileSync(lockPath, JSON.stringify(foreignActiveLock), 'utf8');

    // Run crew doctor --fix
    const res = runCrewCli(`doctor --fix --workspace "${tmpDir}"`, tmpDir);
    assert.ok(fs.existsSync(lockPath), 'Active foreign lock must NOT be unlinked by doctor --fix');
    assert.ok(res.stdout.includes('ACTIVE LOCK (in progress)'), 'Probe must report active lock');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('3.6 Synthetic corruption: Missing .pii-denylist detected as critical failure and restored by --fix', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doc-denylist-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    // Note: .pii-denylist deliberately NOT created

    // Check without fix: critical failure
    const resNoFix = runCrewCli(`doctor --workspace "${tmpDir}"`, tmpDir);
    assert.equal(resNoFix.code, 1, 'Doctor must fail when .pii-denylist is missing');
    assert.ok(resNoFix.stdout.includes('PII Protection (.pii-denylist): UNCONFIGURED'));

    // Check with fix: creates .pii-denylist
    const resFix = runCrewCli(`doctor --fix --workspace "${tmpDir}"`, tmpDir);
    const denylistPath = path.join(tmpDir, '.pii-denylist');
    assert.ok(fs.existsSync(denylistPath), '.pii-denylist must be restored by doctor --fix');
    assert.ok(resFix.stdout.includes('PII Protection (.pii-denylist): CONFIGURED'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('3.7 Synthetic corruption: Malformed sidecar JSON and invalid cron reported with exact diagnostic reasons', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doc-sidecar-diag-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');

    // 1. Broken JSON syntax in sidecar.json
    fs.writeFileSync(path.join(tmpDir, 'sidecar.json'), '{ "broken": json syntax here! ', 'utf8');
    const diagBrokenJson = await runDiagnostics({ workspace: tmpDir });
    const sidecarProbe1 = diagBrokenJson.results.find(r => r.probeId === 'SCHEDULE_SIDECARS');
    assert.equal(sidecarProbe1.pass, false);
    assert.ok(sidecarProbe1.message.includes('JSON_ERROR'));

    // 2. Invalid cron syntax (only 2 fields)
    const badCronSidecar = { builtin: 'schedule', cron: '0 8' };
    fs.writeFileSync(path.join(tmpDir, 'sidecar.json'), JSON.stringify(badCronSidecar), 'utf8');
    const diagBadCron = await runDiagnostics({ workspace: tmpDir });
    const sidecarProbe2 = diagBadCron.results.find(r => r.probeId === 'SCHEDULE_SIDECARS');
    assert.equal(sidecarProbe2.pass, false);
    assert.ok(sidecarProbe2.message.includes('CRON_SYNTAX_ERROR'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
