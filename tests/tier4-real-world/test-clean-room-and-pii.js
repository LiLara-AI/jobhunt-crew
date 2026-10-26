'use strict';
/**
 * Tier 4: Real-World Scenarios - Clean-Room Provenance & Zero-PII Audit
 * Verifies clean-room originality (node clean-room-check.js scan),
 * ensures zero prohibited third-party legacy tokens exist,
 * and audits all committed files against the local gitignored .pii-denylist.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { TestSuite } = require('../helpers/test-harness');

const suite = new TestSuite('Tier 4: Clean-Room & Zero-PII Audit');

const workspaceRoot = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(workspaceRoot, '..');
const checkerPath = path.resolve(repoRoot, '.clean-room', 'clean-room-check.js');

suite.test('Clean-room scanner executes and passes with 0 shingle violations (exit code 0)', assert => {
  if (!fs.existsSync(checkerPath)) {
    throw new Error(`Clean-room checker script not found at ${checkerPath}`);
  }

  try {
    const cmd = `node "${checkerPath}" scan "${workspaceRoot}" --json`;
    const stdout = execSync(cmd, { encoding: 'utf8', cwd: repoRoot });
    const result = JSON.parse(stdout);

    assert.equal(result.pass, true, `Clean-room check failed! Matches: ${JSON.stringify(result.matches)}`);
    assert.lessThanOrEqual(result.sharedShingles, result.limits.maxTotal, `Total shingles (${result.sharedShingles}) exceeded limit (${result.limits.maxTotal})`);

    for (const match of result.matches) {
      assert.lessThanOrEqual(match.sharedShingles, result.limits.maxPerFile, `File ${match.file} exceeded per-file shingle limit`);
    }
  } catch (err) {
    if (err.stdout) {
      console.error('Clean-room check output:', err.stdout);
    }
    throw new Error(`Clean-room scan failed: ${err.message}`);
  }
});

suite.test('Repository contains zero prohibited legacy third-party tokens', assert => {
  // Construct prohibited terms dynamically so this test file itself does not trigger literal matchers
  const prohibited = [
    ['Q', 'APPLIED'].join('_'),
    ['window.', 'Q', '_'].join(''),
    ['Agent', 'System', 'Queues'].join('/'),
    ['data', 'shortlist.js'].join('-'),
    ['dashboard', 'pinned'].join('-')
  ];

  const agentProhibited = [
    'Radar', 'Builder', 'Polish', 'Beacon', 'Hunter', 'Bridge'
  ];

  function scanDir(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', '.git', 'dist', 'coverage'].includes(e.name)) {
          scanDir(full, out);
        }
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (['.js', '.json', '.md', '.html', '.txt'].includes(ext)) {
          // Exclude this test file itself
          if (path.resolve(full) !== path.resolve(__filename)) {
            out.push(full);
          }
        }
      }
    }
    return out;
  }

  const files = scanDir(workspaceRoot);
  const violations = [];

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const term of prohibited) {
      if (text.includes(term)) {
        violations.push({ file: path.relative(workspaceRoot, f), term });
      }
    }

    // Check for legacy agent names used as agent identities
    for (const name of agentProhibited) {
      const idRegex = new RegExp(`(name|agent|identity):\\s*["']?${name}["']?`, 'i');
      if (idRegex.test(text)) {
        violations.push({ file: path.relative(workspaceRoot, f), term: `agent identity: ${name}` });
      }
    }
  }

  assert.equal(violations.length, 0, `Found prohibited legacy tokens: ${JSON.stringify(violations)}`);
});

suite.test('Zero-PII audit scans all workspace files against local gitignored .pii-denylist', assert => {
  const piiDenylistPath = path.resolve(workspaceRoot, '.pii-denylist');
  let denylist = [];

  if (fs.existsSync(piiDenylistPath)) {
    denylist = fs.readFileSync(piiDenylistPath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } else {
    throw new Error('Missing required .pii-denylist file in workspace root');
  }

  function scanDir(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', '.git', 'dist', 'coverage', '.agents'].includes(e.name)) {
          scanDir(full, out);
        }
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (['.js', '.json', '.md', '.html', '.txt', '.yaml', '.yml'].includes(ext)) {
          // Do not scan .pii-denylist itself
          if (path.resolve(full) !== path.resolve(piiDenylistPath)) {
            out.push(full);
          }
        }
      }
    }
    return out;
  }

  const files = scanDir(workspaceRoot);
  const piiHits = [];

  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8').toLowerCase();
    for (const pii of denylist) {
      if (content.includes(pii.toLowerCase())) {
        piiHits.push({ file: path.relative(workspaceRoot, f), term: pii });
      }
    }
  }

  assert.equal(piiHits.length, 0, `Found personal PII violations in committed files: ${JSON.stringify(piiHits)}`);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
