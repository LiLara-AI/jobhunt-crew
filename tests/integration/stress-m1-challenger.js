/**
 * JobHunt Crew — Integration Stress Test: Forbidden Legacy Tokens & Agent Identities
 *
 * Adversarially tests `scripts/check-forbidden-tokens.js` against all 12 legacy identities
 * and forbidden legacy global/file patterns using temporary isolated directories.
 *
 * NOTE: All test tokens are assembled dynamically at runtime so this test file contains
 * zero static forbidden literals and safely passes static repo scanners.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const checkScript = path.join(repoRoot, 'scripts', 'check-forbidden-tokens.js');

// Dynamically assemble all tokens at runtime - ZERO static literals in this source file
function getDynamicLiterals() {
  return [
    ['Q', 'APPLIED'].join('_'),
    ['window', 'Q_'].join('.'),
    ['Agent', 'System/Queues'].join('-'),
    ['data', 'shortlist.js'].join('-'),
    ['dashboard', 'pinned'].join('-')
  ];
}

function getDynamicIdentities() {
  return [
    ['Ra', 'dar'].join(''),
    ['Sc', 'out'].join(''),
    ['Buil', 'der'].join(''),
    ['Pol', 'ish'].join(''),
    ['Co', 'ach'].join(''),
    ['Sy', 'nc'].join(''),
    ['Bea', 'con'].join(''),
    ['Hun', 'ter'].join(''),
    ['Tai', 'lor'].join(''),
    ['Audi', 'tor'].join(''),
    ['Pi', 'lot'].join(''),
    ['Bri', 'dge'].join('')
  ];
}

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

  // 1. Script existence
  check('scripts/check-forbidden-tokens.js exists and is executable', () => {
    assert.ok(fs.existsSync(checkScript), 'check-forbidden-tokens.js must exist');
  });

  // 2. Export check for all 12 identities
  check('check-forbidden-tokens.js exports all 12 legacy identities', () => {
    const mod = require(checkScript);
    assert.ok(Array.isArray(mod.FORBIDDEN_IDENTITIES), 'Must export FORBIDDEN_IDENTITIES array');
    const expected = getDynamicIdentities();
    assert.strictEqual(mod.FORBIDDEN_IDENTITIES.length, 12, 'Must include all 12 legacy identities');
    for (const id of expected) {
      assert.ok(mod.FORBIDDEN_IDENTITIES.includes(id), `Missing legacy identity: ${id}`);
    }
  });

  // 3. Dynamic test: detection of planted forbidden literals in isolated tmpdir
  check('check-forbidden-tokens.js catches all planted forbidden literals', () => {
    const literals = getDynamicLiterals();
    for (const literal of literals) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-lit-test-'));
      try {
        const testFile = path.join(tmpDir, 'sample.js');
        fs.writeFileSync(testFile, `// Planted test file\nconst val = "${literal}";\n`);

        let detected = false;
        try {
          execFileSync(process.execPath, [checkScript, tmpDir], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
          });
        } catch (err) {
          detected = true;
          const out = (err.stdout || '') + (err.stderr || '');
          assert.ok(out.includes(literal), `Expected output to mention ${literal}, got ${out}`);
        }
        assert.ok(detected, `Checker must fail on planted literal: ${literal}`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  // 4. Dynamic test: detection of symmetric prefix and suffix agent descriptors
  check('check-forbidden-tokens.js catches symmetric agent descriptors for all 12 identities', () => {
    const identities = getDynamicIdentities();
    for (const name of identities) {
      // Test prefix descriptor: [descriptor, identity]
      for (const desc of ['agent', 'crewmember', 'bot']) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-id-pre-'));
        try {
          const testFile = path.join(tmpDir, 'agent.js');
          fs.writeFileSync(testFile, `// Comment\nconst role = "${desc} ${name}";\n`);
          let detected = false;
          try {
            execFileSync(process.execPath, [checkScript, tmpDir], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe']
            });
          } catch (err) {
            detected = true;
          }
          assert.ok(detected, `Checker must detect prefix descriptor "${desc} ${name}"`);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }

      // Test suffix descriptor: [identity, descriptor]
      for (const desc of ['crewmember', 'identity', 'step']) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-id-suf-'));
        try {
          const testFile = path.join(tmpDir, 'agent.js');
          fs.writeFileSync(testFile, `// Comment\nconst role = "${name} ${desc}";\n`);
          let detected = false;
          try {
            execFileSync(process.execPath, [checkScript, tmpDir], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe']
            });
          } catch (err) {
            detected = true;
          }
          assert.ok(detected, `Checker must detect suffix descriptor "${name} ${desc}"`);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    }
  });

  return { passed, failed };
}

if (require.main === module) {
  run().then(({ passed, failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  });
}

module.exports = { run };
