#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKIP_DIRS = new Set(['node_modules', '.git', '.crew', 'dist', 'coverage']);

function findJsFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findJsFiles(fullPath, fileList);
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs'))) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function lint() {
  const rootPath = path.resolve(__dirname, '..');
  const jsFiles = findJsFiles(rootPath);
  let errors = 0;

  console.log(`[LINT] Checking syntax across ${jsFiles.length} JavaScript file(s)...`);

  for (const file of jsFiles) {
    const relPath = path.relative(rootPath, file);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      console.error(`[LINT-ERROR] Syntax error in ${relPath}: ${err.message}`);
      errors++;
    }
  }

  if (errors > 0) {
    console.error(`\n[LINT] FAIL: ${errors} syntax error(s) found.`);
    process.exit(1);
  }

  console.log(`[LINT] PASS: All ${jsFiles.length} JavaScript files have valid syntax.`);
  process.exit(0);
}

if (require.main === module) {
  lint();
}

module.exports = { lint, findJsFiles };
