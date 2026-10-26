#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.crew', 'dist', 'coverage']);
const SKIP_FILES = new Set([
  'check-forbidden-tokens.js',
  'test-layout.js',
  'test-clean-room-and-pii.js',
  'stress-m1-challenger.js',
  'test-m6-adversarial-exporter.js'
]);
const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.html', '.css', '.txt', '.yaml', '.yml']);

// Forbidden legacy terms that must not appear in JobHunt Crew
const FORBIDDEN_LITERALS = [
  ['Q', 'APPLIED'].join('_'),
  ['window', 'Q_'].join('.'),
  ['Agent', 'System/Queues'].join('-'),
  ['data', 'shortlist.js'].join('-'),
  ['dashboard', 'pinned'].join('-')
];

// All 12 legacy agent identities across v0.0.1 - v0.0.3 and v0.0.4 - v0.0.5
const FORBIDDEN_IDENTITIES = [
  'Radar',
  'Scout',
  'Builder',
  'Polish',
  'Coach',
  'Sync',
  'Beacon',
  'Hunter',
  'Tailor',
  'Auditor',
  'Pilot',
  'Bridge'
];

const DESCRIPTORS = 'agent|role|identity|crewmember|step|bot';

function findFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(fullPath, fileList);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (TEXT_EXTS.has(ext)) {
        fileList.push(fullPath);
      }
    }
  }
  return fileList;
}

function scan(targetDir) {
  const rootPath = targetDir ? path.resolve(targetDir) : (process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..'));
  const files = findFiles(rootPath);
  const violations = [];

  for (const file of files) {
    const relPath = path.relative(rootPath, file);
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      for (const literal of FORBIDDEN_LITERALS) {
        if (line.includes(literal)) {
          violations.push({ file: relPath, line: i + 1, term: literal, type: 'legacy_literal' });
        }
      }

      for (const name of FORBIDDEN_IDENTITIES) {
        const agentRegex = new RegExp(`\\b(${DESCRIPTORS})\\b.*?\\b${name}\\b|\\b${name}\\b.*?\\b(${DESCRIPTORS})\\b`, 'i');
        if (agentRegex.test(line)) {
          violations.push({ file: relPath, line: i + 1, term: name, type: 'legacy_agent_identity' });
        }
      }
    }
  }

  if (violations.length > 0) {
    console.error(`\n[FORBIDDEN-CHECK] FAIL: Detected ${violations.length} forbidden legacy token(s):`);
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line} [${v.type}] -> "${v.term}"`);
    }
    if (require.main === module) {
      process.exit(1);
    }
    return { pass: false, violations };
  }

  console.log(`[FORBIDDEN-CHECK] PASS: Scanned ${files.length} files. Zero legacy tokens found.`);
  if (require.main === module) {
    process.exit(0);
  }
  return { pass: true, violations: [] };
}

if (require.main === module) {
  scan();
}

module.exports = { scan, FORBIDDEN_LITERALS, FORBIDDEN_IDENTITIES };
