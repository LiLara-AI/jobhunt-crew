/**
 * JobHunt Crew — Syntax Compilation Verification Test
 *
 * Verifies that all JavaScript files (.js, .cjs, .mjs) in the repository
 * parse and compile without syntax errors using node:vm.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '../..');

function collectJsFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (['node_modules', '.git', 'dist', 'coverage', '.crew'].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(p, out);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs')) {
      out.push(p);
    }
  }
  return out;
}

async function run() {
  let passed = 0;
  let failed = 0;

  const jsFiles = collectJsFiles(repoRoot);
  assert.ok(jsFiles.length > 0, 'At least one JavaScript file must exist to test');

  for (const file of jsFiles) {
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
    try {
      const code = fs.readFileSync(file, 'utf8');
      // Strip shebang for vm parsing
      const cleaned = code.startsWith('#!') ? code.replace(/^#![^\n]*/, '') : code;
      new vm.Script(cleaned, { filename: rel });
      passed++;
      console.log(`      ✓ Syntax valid: ${rel}`);
    } catch (err) {
      failed++;
      console.error(`      ✖ Syntax error in ${rel}: ${err.message}`);
    }
  }

  return { passed, failed };
}

module.exports = { run };

if (require.main === module) {
  run().then(result => {
    if (result.failed > 0) process.exitCode = 1;
  }).catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
