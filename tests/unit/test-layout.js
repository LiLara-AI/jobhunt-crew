/**
 * JobHunt Crew — Layout & Clean-Room Anti-Pattern Verification Test
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

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

  // 1. Mandatory Root Files
  const requiredFiles = [
    'package.json',
    'LICENSE',
    'NOTICE',
    'README.md',
    '.gitignore',
    '.pii-denylist.example',
    'scripts/verify-clean-room.js',
    'scripts/verify-zero-pii.js',
    'tests/e2e-runner.js'
  ];

  for (const file of requiredFiles) {
    check(`Root file exists: ${file}`, () => {
      const p = path.join(repoRoot, file);
      assert.ok(fs.existsSync(p), `Missing required file: ${file}`);
    });
  }

  // 2. Mandatory Directories
  const requiredDirs = [
    'bin',
    'lib/core',
    'lib/honest-cv',
    'lib/discovery',
    'lib/command-center',
    'lib/companion',
    'agents',
    'skills',
    'templates',
    'scripts',
    'tests/unit',
    'tests/integration'
  ];

  for (const dir of requiredDirs) {
    check(`Core directory exists: ${dir}`, () => {
      const p = path.join(repoRoot, dir);
      assert.ok(fs.existsSync(p) && fs.statSync(p).isDirectory(), `Missing directory: ${dir}`);
    });
  }

  // 3. .gitignore Rules
  check('.gitignore ignores required sensitive and runtime items', () => {
    const gitignorePath = path.join(repoRoot, '.gitignore');
    assert.ok(fs.existsSync(gitignorePath), '.gitignore must exist');
    const content = fs.readFileSync(gitignorePath, 'utf8');

    const expectedPatterns = [
      '.crew',
      'node_modules',
      'coverage',
      '.env',
      '.pii-denylist'
    ];

    for (const pat of expectedPatterns) {
      assert.ok(
        content.includes(pat),
        `.gitignore must explicitly contain pattern: ${pat}`
      );
    }
  });

  // 4. Clean-Room Anti-Pattern Checks (Forbidden Legacy Constructs)
  check('No legacy queue directory structure (Agent-System)', () => {
    const legacyPath = path.join(repoRoot, 'Agent-' + 'System');
    assert.ok(!fs.existsSync(legacyPath), 'Agent-System directory must not exist');
  });

  check('No legacy data queue files in repo root or templates', () => {
    const forbiddenFiles = [
      'data-' + 'shortlist.js',
      'data-' + 'applied.js',
      'data-' + 'runs.js',
      'data-' + 'agents.js',
      'data-' + 'todo.js',
      'dashboard-' + 'pinned.html'
    ];

    for (const file of forbiddenFiles) {
      assert.ok(!fs.existsSync(path.join(repoRoot, file)), `Forbidden legacy file found in root: ${file}`);
      assert.ok(!fs.existsSync(path.join(repoRoot, 'templates', file)), `Forbidden legacy file found in templates: ${file}`);
    }
  });

  check('Zero legacy window globals across repository', () => {
    const forbiddenPrefix = 'window.' + 'Q_';
    function scanDir(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.crew') continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(p);
        } else if (entry.name.endsWith('.js') || entry.name.endsWith('.html') || entry.name.endsWith('.md')) {
          if (entry.name === 'check-forbidden-tokens.js') continue;
          const text = fs.readFileSync(p, 'utf8');
          assert.ok(!text.includes(forbiddenPrefix), `Forbidden window global reference in ${p}`);
        }
      }
    }
    scanDir(repoRoot);
  });

  return { passed, failed };
}

module.exports = { run };
