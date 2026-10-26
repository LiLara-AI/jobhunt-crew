/**
 * JobHunt Crew — Package Manifest Verification Test
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

  const pkgPath = path.join(repoRoot, 'package.json');
  let pkg;

  check('package.json exists and parses as valid JSON', () => {
    assert.ok(fs.existsSync(pkgPath), 'package.json must exist');
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  });

  check('Package name is valid', () => {
    assert.ok(
      pkg.name === 'jobhunt-crew' || pkg.name === '@jobhunt-crew/core',
      `Expected package name to be jobhunt-crew or @jobhunt-crew/core, got: ${pkg.name}`
    );
  });

  check('Package version follows semantic versioning format', () => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  check('License is MIT', () => {
    assert.strictEqual(pkg.license, 'MIT');
  });

  check('Binary entry crew points to ./bin/crew.js', () => {
    assert.ok(pkg.bin && (pkg.bin.crew === './bin/crew.js' || pkg.bin.crew === 'bin/crew.js'));
  });

  check('Required scripts are defined in package.json', () => {
    assert.ok(pkg.scripts, 'scripts object must exist in package.json');
    assert.ok(pkg.scripts.test, 'test script must be defined');
    assert.ok(pkg.scripts['clean-room'], 'clean-room script must be defined');
    assert.ok(pkg.scripts['zero-pii'] || pkg.scripts['test:pii'], 'zero-pii script must be defined');
  });

  check('Zero non-permissive or unauthorized dependencies', () => {
    const deps = Object.keys(pkg.dependencies || {});
    assert.ok(deps.length === 0, `Expected 0 external runtime dependencies in M1, found: ${deps.join(', ')}`);
  });

  return { passed, failed };
}

module.exports = { run };
