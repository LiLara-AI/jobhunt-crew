#!/usr/bin/env node
/**
 * JobHunt Crew — Zero-PII Verification Scanner
 *
 * Scans all committed and tracked repository files against a local,
 * gitignored `.pii-denylist` to verify that zero personal identifiers
 * (names, emails, phone numbers, addresses, personal credentials)
 * exist in source code, documentation, fixtures, or tests.
 *
 * Exit code:
 *   0 = PASS (0 violations detected)
 *   1 = FAIL (PII violations detected or denylist missing)
 *   2 = Configuration error
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.nyc_output',
  '.crew',
  '.venv',
  '__pycache__',
  '.idea',
  '.vscode'
]);

const SKIP_FILES = new Set([
  '.pii-denylist',
  '.pii-denylist.local',
  '.env',
  '.env.local',
  '.env.production',
  '.DS_Store',
  'Thumbs.db'
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.pdf', '.docx', '.xlsx', '.pptx',
  '.zip', '.tar', '.gz', '.tgz', '.7z',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi',
  '.exe', '.bin', '.dll', '.so', '.dylib'
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

function printUsage() {
  console.log(`
Usage:
  node scripts/verify-zero-pii.js [options]

Options:
  --denylist <path>    Path to .pii-denylist file (default: ./.pii-denylist)
  --target <path>      Directory to scan (default: repository root)
  --allow-missing      Warn instead of fail if .pii-denylist does not exist
  --init               Create .pii-denylist from .pii-denylist.example if missing
  --json               Output report as JSON
  -h, --help           Show this help message
`);
}

function parseDenylist(denylistPath) {
  if (!fs.existsSync(denylistPath)) {
    return null;
  }

  const raw = fs.readFileSync(denylistPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const rules = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Strip inline comment if preceded by space
    const commentIdx = line.indexOf(' #');
    if (commentIdx !== -1) {
      line = line.slice(0, commentIdx).trim();
    }
    if (!line) continue;

    // Check if regex literal /pattern/flags
    const regexMatch = line.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
      const pattern = regexMatch[1];
      let flags = regexMatch[2];
      if (!flags.includes('i')) flags += 'i';
      if (!flags.includes('g')) flags += 'g';
      try {
        rules.push({
          id: `Line ${i + 1}`,
          pattern: new RegExp(pattern, flags),
          raw: line
        });
      } catch (err) {
        console.warn(`WARNING: Invalid regex at line ${i + 1}: ${line}`);
      }
      continue;
    }

    // Plain string: escape and bind
    const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let reg;
    if (/^[\w.-]+$/.test(line)) {
      reg = new RegExp(`\\b${escaped}\\b`, 'gi');
    } else {
      reg = new RegExp(escaped.replace(/\\s+/g, '\\s+'), 'gi');
    }

    rules.push({
      id: `Line ${i + 1}`,
      pattern: reg,
      raw: line
    });
  }

  return rules;
}

function isBinary(buffer) {
  const checkLen = Math.min(buffer.length, 1024);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function collectFiles(dir, repoRoot, fileList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(repoRoot, fullPath);

    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        collectFiles(fullPath, repoRoot, fileList);
      }
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;
        fileList.push({ fullPath, relPath, size: stat.size });
      } catch (e) {
        // Skip inaccessible files
      }
    }
  }

  return fileList;
}

function redactMatch(lineText, rules) {
  if (!lineText) return '';
  const ruleList = Array.isArray(rules) ? rules : [rules];
  let redacted = lineText;

  for (const rule of ruleList) {
    if (!rule || !rule.pattern) continue;
    const pattern = rule.pattern;
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    const globalRegex = new RegExp(pattern.source, flags);
    redacted = redacted.replace(globalRegex, '[REDACTED_PII]');
  }
  return redacted;
}

function scanFiles(files, rules) {
  const violations = [];
  let scannedCount = 0;

  for (const file of files) {
    let buffer;
    try {
      buffer = fs.readFileSync(file.fullPath);
    } catch (e) {
      continue;
    }

    if (isBinary(buffer)) continue;

    const content = buffer.toString('utf8');
    scannedCount++;
    const lines = content.split(/\r?\n/);

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const lineText = lines[lineNum];
      for (const rule of rules) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(lineText)) {
          violations.push({
            file: file.relPath.replace(/\\/g, '/'),
            line: lineNum + 1,
            ruleId: rule.id,
            redactedLine: redactMatch(lineText.trim(), rules)
          });
        }
      }
    }
  }

  return { scannedCount, violations };
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  const repoRoot = path.resolve(__dirname, '..');
  let targetDir = repoRoot;
  const targetIdx = args.indexOf('--target');
  if (targetIdx !== -1 && args[targetIdx + 1]) {
    targetDir = path.resolve(args[targetIdx + 1]);
  }

  let denylistPath = path.join(repoRoot, '.pii-denylist');
  const denylistIdx = args.indexOf('--denylist');
  if (denylistIdx !== -1 && args[denylistIdx + 1]) {
    denylistPath = path.resolve(args[denylistIdx + 1]);
  }

  const isInit = args.includes('--init');
  if (isInit) {
    const examplePath = path.join(repoRoot, '.pii-denylist.example');
    if (fs.existsSync(denylistPath)) {
      console.log(`.pii-denylist already exists at ${denylistPath}`);
      process.exit(0);
    }
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, denylistPath);
      console.log(`Created .pii-denylist from template: ${denylistPath}`);
      process.exit(0);
    } else {
      console.error(`ERROR: Template .pii-denylist.example not found at ${examplePath}`);
      process.exit(2);
    }
  }

  const allowMissing = args.includes('--allow-missing');
  const isJson = args.includes('--json');

  const rules = parseDenylist(denylistPath);
  if (!rules) {
    if (allowMissing) {
      console.warn(`WARNING: .pii-denylist not found at ${denylistPath}. Skipping zero-PII check (--allow-missing).`);
      if (isJson) {
        console.log(JSON.stringify({ pass: true, skipped: true, reason: 'missing_denylist' }));
      }
      process.exit(0);
    } else {
      console.error('======================================================================');
      console.error('ERROR: Local .pii-denylist file not found!');
      console.error(`Expected location: ${denylistPath}`);
      console.error('To run the zero-PII audit, copy .pii-denylist.example to .pii-denylist');
      console.error('and add personal names, emails, and identifiers to protect.');
      console.error('Use --allow-missing to bypass in clean public CI environments.');
      console.error('======================================================================');
      if (isJson) {
        console.log(JSON.stringify({ pass: false, error: 'missing_denylist' }));
      }
      process.exit(1);
    }
  }

  const files = collectFiles(targetDir, targetDir);
  const { scannedCount, violations } = scanFiles(files, rules);
  const pass = violations.length === 0;

  if (isJson) {
    console.log(JSON.stringify({
      pass,
      filesScanned: scannedCount,
      rulesCount: rules.length,
      violationsCount: violations.length,
      violations
    }, null, 2));
    process.exit(pass ? 0 : 1);
  }

  console.log('======================================================================');
  console.log('JOBHUNT CREW — ZERO-PII AUDIT');
  console.log('======================================================================');
  console.log(`Target Workspace : ${targetDir}`);
  console.log(`Denylist File    : ${denylistPath}`);
  console.log(`Active Rules     : ${rules.length} rule(s) loaded`);
  console.log(`Files Scanned    : ${scannedCount} file(s) checked`);
  console.log(`Violations Found : ${violations.length}`);

  if (!pass) {
    console.log('----------------------------------------------------------------------');
    console.log('VIOLATIONS DETECTED (Redacted Snippets):');
    for (const v of violations) {
      console.log(`  - ${v.file}:${v.line} (${v.ruleId})`);
      console.log(`    Content: "${v.redactedLine}"`);
    }
    console.log('----------------------------------------------------------------------');
    console.log('VERDICT: ZERO-PII AUDIT FAILED');
    console.log('Action: Remove all identified personal details from committed files.');
    console.log('======================================================================');
    process.exit(1);
  } else {
    console.log('----------------------------------------------------------------------');
    console.log('VERDICT: ZERO-PII AUDIT PASSED (0 personal identifiers found)');
    console.log('======================================================================');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseDenylist, scanFiles, collectFiles, redactMatch };
