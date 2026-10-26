/**
 * JobHunt Crew — Verification Scripts Integration Test
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const cleanRoomScript = path.join(repoRoot, 'scripts', 'verify-clean-room.js');
const zeroPiiScript = path.join(repoRoot, 'scripts', 'verify-zero-pii.js');

async function run() {
  let passed = 0;
  let failed = 0;

  function check(name, fn) {
    try {
      fn();
      passed++;
      console.log(`      ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`      ✖ ${name}: ${err.message}`);
    }
  }

  // 1. Clean-Room Selftest
  check('verify-clean-room.js --selftest exits 0 and passes', () => {
    assert.ok(fs.existsSync(cleanRoomScript), 'verify-clean-room.js must exist');
    const out = execFileSync(process.execPath, [cleanRoomScript, '--selftest'], { encoding: 'utf8' });
    assert.ok(out.includes('PASS'), `Expected selftest PASS, got: ${out}`);
  });

  // 2. Clean-Room Repository Scan
  check('verify-clean-room.js scan on repository exits 0 with zero unauthorized shingles', () => {
    const out = execFileSync(process.execPath, [cleanRoomScript, repoRoot, '--json'], { encoding: 'utf8' });
    const result = JSON.parse(out);
    assert.strictEqual(result.pass, true, 'Clean-room check must pass');
    assert.ok(result.sharedShingles <= 10, `Expected shared shingles <= 10, got ${result.sharedShingles}`);
  });

  // 3. Zero-PII Clean Audit
  check('verify-zero-pii.js on repository passes without violations', () => {
    assert.ok(fs.existsSync(zeroPiiScript), 'verify-zero-pii.js must exist');
    const denylistPath = path.join(repoRoot, '.pii-denylist');

    // Create a temporary benign denylist if none exists to test the scanner
    let tempCreated = false;
    if (!fs.existsSync(denylistPath)) {
      fs.writeFileSync(denylistPath, '# Benign test denylist\nNonExistentSecretCandidate999\n');
      tempCreated = true;
    }

    try {
      const out = execFileSync(process.execPath, [zeroPiiScript, '--json'], { encoding: 'utf8' });
      const result = JSON.parse(out);
      assert.strictEqual(result.pass, true, 'Zero-PII scan should pass on clean repo');
      assert.strictEqual(result.violationsCount, 0, 'Expected 0 violations');
    } finally {
      if (tempCreated && fs.existsSync(denylistPath)) {
        fs.unlinkSync(denylistPath);
      }
    }
  });

  // 4. Adversarial PII Detection Test
  check('verify-zero-pii.js detects violations when planted in mock target', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-test-'));
    try {
      const mockFile = path.join(tmpDir, 'resume.md');
      fs.writeFileSync(mockFile, 'Candidate Name: Jane Doe\nEmail: secret.agent@forbidden.org\n');

      const mockDenylist = path.join(tmpDir, '.pii-denylist');
      fs.writeFileSync(mockDenylist, 'Jane Doe\nsecret.agent@forbidden.org\n');

      let detected = false;
      try {
        execFileSync(process.execPath, [
          zeroPiiScript,
          '--target', tmpDir,
          '--denylist', mockDenylist,
          '--json'
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        detected = true;
        const result = JSON.parse(err.stdout || '{}');
        assert.strictEqual(result.pass, false, 'Expected scanner to return pass=false');
        assert.strictEqual(result.violationsCount, 2, 'Expected 2 detected violations');
      }
      assert.ok(detected, 'verify-zero-pii.js must exit non-zero when planted PII is present');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 5. Multi-Token Zero-PII Log Masking
  check('verify-zero-pii.js completely masks multi-token lines with zero plaintext leakage', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pii-mask-test-'));
    try {
      const mockDenylist = path.join(tmpDir, '.pii-denylist');
      fs.writeFileSync(mockDenylist, 'Jane Doe\nsecret.agent@forbidden.org\n');

      const mockFile = path.join(tmpDir, 'leak.md');
      fs.writeFileSync(mockFile, 'Contact Jane Doe at secret.agent@forbidden.org or call Jane Doe again\n');

      let stdout = '';
      try {
        execFileSync(process.execPath, [
          zeroPiiScript,
          '--target', tmpDir,
          '--denylist', mockDenylist
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        stdout = err.stdout || '';
      }

      assert.ok(!stdout.includes('Jane Doe'), 'Jane Doe must not appear anywhere in output');
      assert.ok(!stdout.includes('secret.agent@forbidden.org'), 'secret email must not appear anywhere in output');
      assert.ok(stdout.includes('[REDACTED_PII]'), 'Output must contain [REDACTED_PII]');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  return { passed, failed };
}

module.exports = { run };
