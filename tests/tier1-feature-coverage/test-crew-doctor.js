'use strict';

/**
 * Tier 1: Feature Coverage — Operational Diagnostics Subsystem (crew doctor)
 *
 * Verifies the 6-probe diagnostic architecture:
 * 1. Runtime & Workspace Structure + --fix
 * 2. Cryptographic Ledger Monotonicity & Tamper Detection
 * 3. Lockfile Hygiene & Dead-PID Process Liveness
 * 4. Chrome DevTools MCP Endpoint & Graceful Degradation
 * 5. Board Sessions with Strict Credential Masking
 * 6. Scheduled Sidecars & Cron Syntax
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const { runDiagnostics, maskSessionCredentials } = require('../../lib/operational/diagnostics');
const { EventLedger } = require('../../lib/ledger/ledger');

const suite = new TestSuite('M5 Feature 28: Operational Diagnostics Subsystem (crew doctor)');

suite.test('TC-DOCTOR-01: Healthy Workspace Returns Pass', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doctor-pass-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');

    const ledger = new EventLedger({
      ledgerPath: path.join(tmpDir, '.crew', 'ledger.jsonl'),
      lockPath: path.join(tmpDir, '.crew', 'ledger.lock')
    });
    await ledger.appendEvent({ event: 'LEDGER_INITIALIZED', payload: { status: 'ok' }, actor: 'system' });

    fs.writeFileSync(path.join(tmpDir, '.crew', 'snapshot.json'), JSON.stringify({ version: 1, lastEventId: 1, jobs: {} }), 'utf8');

    const diag = await runDiagnostics({ workspace: tmpDir });
    assert.equal(diag.pass, true, 'Healthy workspace must pass all doctor checks');
    assert.equal(diag.hasCriticalFailure, false, 'Healthy workspace must have zero critical failures');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-DOCTOR-02: Missing .crew Directory Detected and Repaired with --fix', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doctor-fix-'));
  try {
    const diagNoFix = await runDiagnostics({ workspace: tmpDir, fix: false });
    assert.equal(diagNoFix.hasCriticalFailure, true, 'Missing .crew must flag critical failure without --fix');

    const diagFix = await runDiagnostics({ workspace: tmpDir, fix: true });
    assert.ok(fs.existsSync(path.join(tmpDir, '.crew')), '.crew directory must be created by --fix');
    assert.ok(fs.existsSync(path.join(tmpDir, '.pii-denylist')), '.pii-denylist must be created by --fix');
    assert.equal(diagFix.hasCriticalFailure, false, 'Critical failures must be resolved after --fix');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-DOCTOR-03: Cryptographic Ledger Corruption Flagged with Critical Failure', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doctor-tamper-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');

    const ledger = new EventLedger({
      ledgerPath: path.join(tmpDir, '.crew', 'ledger.jsonl'),
      lockPath: path.join(tmpDir, '.crew', 'ledger.lock')
    });
    await ledger.appendEvent({ event: 'EVENT_1', payload: { step: 1 }, actor: 'system' });
    await ledger.appendEvent({ event: 'EVENT_2', payload: { step: 2 }, actor: 'system' });

    // Tamper with event 2 payload directly without updating hash
    const ledgerFile = path.join(tmpDir, '.crew', 'ledger.jsonl');
    const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
    const ev2 = JSON.parse(lines[1]);
    ev2.payload.step = 999; // Tampered
    lines[1] = JSON.stringify(ev2);
    fs.writeFileSync(ledgerFile, lines.join('\n') + '\n', 'utf8');

    const diag = await runDiagnostics({ workspace: tmpDir });
    assert.equal(diag.pass, false, 'Tampered ledger must fail doctor checks');
    assert.equal(diag.hasCriticalFailure, true, 'Tampered ledger must trigger critical failure');
    const ledgerProbe = diag.results.find(r => r.probeId === 'LEDGER_HASH_CHAIN');
    assert.ok(ledgerProbe.message.includes('CORRUPTED'), 'Ledger probe message must report CORRUPTED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-DOCTOR-04: Stale Concurrency Lock Detected and Purged with --fix', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doctor-lock-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');
    const lockPath = path.join(tmpDir, '.crew', 'ledger.lock');

    // Create stale lock with dead PID and expired lease
    const staleLock = {
      pid: 99999999, // Unlikely to exist
      hostname: os.hostname(),
      acquiredAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() - 30000).toISOString(),
      time: Date.now() - 60000
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleLock), 'utf8');

    // Probe without fix: flags stale lock
    const diagNoFix = await runDiagnostics({ workspace: tmpDir, fix: false });
    const lockProbeNoFix = diagNoFix.results.find(r => r.probeId === 'CONCURRENCY_LOCK');
    assert.equal(lockProbeNoFix.pass, false, 'Stale lock probe must return pass: false without fix');
    assert.ok(lockProbeNoFix.message.includes('STALE LOCK DETECTED'));

    // Probe with fix: unlinks lockfile
    const diagFix = await runDiagnostics({ workspace: tmpDir, fix: true });
    assert.equal(fs.existsSync(lockPath), false, 'Lockfile must be unlinked after --fix');
    const lockProbeFix = diagFix.results.find(r => r.probeId === 'CONCURRENCY_LOCK');
    assert.ok(lockProbeFix.message.includes('STALE LOCK REMOVED'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-DOCTOR-05: Active Concurrency Lock Protected Against Unlinking', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doctor-active-lock-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');
    const lockPath = path.join(tmpDir, '.crew', 'ledger.lock');

    // Create active lock owned by current process with future expiration
    const activeLock = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      time: Date.now()
    };
    fs.writeFileSync(lockPath, JSON.stringify(activeLock), 'utf8');

    // Probe with --fix should NOT delete active lock
    const diagFix = await runDiagnostics({ workspace: tmpDir, fix: true });
    assert.ok(fs.existsSync(lockPath), 'Active lock must NOT be deleted even with --fix');
    const lockProbe = diagFix.results.find(r => r.probeId === 'CONCURRENCY_LOCK');
    assert.ok(lockProbe.message.includes('ACTIVE LOCK'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-DOCTOR-06: Connector Probe Graceful Degradation & Zero-Leak Credential Masking', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doctor-connector-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');

    // Test credential masking
    const rawStatus = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID, cookie: JSESSIONID=abcdef0123456789abcdef0123456789';
    const masked = maskSessionCredentials(rawStatus);
    assert.ok(!masked.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'JWT token must be redacted');
    assert.ok(!masked.includes('abcdef0123456789abcdef0123456789'), 'Session hash must be redacted');
    assert.ok(masked.includes('[REDACTED]'), 'Redaction placeholder must be present');

    // Test DevTools probe non-blocking fallback
    const start = Date.now();
    const diag = await runDiagnostics({ workspace: tmpDir });
    const duration = Date.now() - start;
    assert.ok(duration < 2000, `Diagnostics probe must finish quickly (took ${duration}ms)`);
    const devToolsProbe = diag.results.find(r => r.probeId === 'CONNECTOR_DEVTOOLS_MCP');
    assert.equal(devToolsProbe.critical, false, 'DevTools probe must be non-critical fallback');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-DOCTOR-07: Scheduled Sidecar Cron Syntax Validation', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-doctor-sidecar-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.crew'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.pii-denylist'), '# Denylist\n', 'utf8');

    // Write invalid sidecar with 3-field cron
    const badSidecar = {
      builtin: 'schedule',
      cron: '0 8 *' // Invalid: only 3 fields
    };
    fs.writeFileSync(path.join(tmpDir, 'sidecar.json'), JSON.stringify(badSidecar), 'utf8');

    const diagBad = await runDiagnostics({ workspace: tmpDir });
    const sidecarProbeBad = diagBad.results.find(r => r.probeId === 'SCHEDULE_SIDECARS');
    assert.equal(sidecarProbeBad.pass, false, 'Invalid cron must fail sidecar probe');
    assert.ok(sidecarProbeBad.message.includes('CRON_SYNTAX_ERROR'));

    // Write valid sidecar
    const goodSidecar = {
      builtin: 'schedule',
      cron: 'CRON_TZ=Asia/Riyadh 0 8 * * *'
    };
    fs.writeFileSync(path.join(tmpDir, 'sidecar.json'), JSON.stringify(goodSidecar), 'utf8');

    const diagGood = await runDiagnostics({ workspace: tmpDir });
    const sidecarProbeGood = diagGood.results.find(r => r.probeId === 'SCHEDULE_SIDECARS');
    assert.equal(sidecarProbeGood.pass, true, 'Valid cron must pass sidecar probe');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
