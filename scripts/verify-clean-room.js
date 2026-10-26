#!/usr/bin/env node
/**
 * JobHunt Crew — Clean-Room Provenance Verification Script
 *
 * Wraps the independent clean-room checker (.clean-room/clean-room-check.js)
 * to assert that the JobHunt Crew codebase contains zero unauthorized shingles
 * from restricted reference repositories.
 *
 * Limits enforced:
 *   - Total shared shingles: <= 10
 *   - Per-file shared shingles: <= 3
 *
 * Exit code:
 *   0 = PASS (clean-room compliance verified)
 *   1 = FAIL (provenance violation detected)
 *   2 = Configuration or usage error
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function printUsage() {
  console.log(`
Usage:
  node scripts/verify-clean-room.js [target_dir] [options]

Options:
  --checker <path>     Explicit path to clean-room-check.js
  --selftest           Run detector self-test to verify planted-copy detection
  --json               Output raw JSON report
  --max-total <n>      Override total shared shingle limit (default: 10)
  --max-per-file <n>   Override per-file shingle limit (default: 3)
  --verbose            Show extended file details
  -h, --help           Show this help message
`);
}

function resolveCheckerPath(explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) {
    return path.resolve(explicitPath);
  }
  if (process.env.CLEAN_ROOM_CHECKER && fs.existsSync(process.env.CLEAN_ROOM_CHECKER)) {
    return path.resolve(process.env.CLEAN_ROOM_CHECKER);
  }

  const candidateDirs = [
    path.resolve(__dirname, '../../.clean-room'),
    path.resolve(__dirname, '../.clean-room'),
    path.resolve(process.cwd(), '../.clean-room'),
    path.resolve(process.cwd(), '.clean-room'),
    path.resolve(__dirname, '../../../.clean-room')
  ];

  for (const dir of candidateDirs) {
    const candidate = path.join(dir, 'clean-room-check.js');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  let explicitChecker = null;
  const checkerIdx = args.indexOf('--checker');
  if (checkerIdx !== -1 && args[checkerIdx + 1]) {
    explicitChecker = args[checkerIdx + 1];
  }

  const checkerPath = resolveCheckerPath(explicitChecker);
  if (!checkerPath) {
    console.error('ERROR: clean-room-check.js could not be located.');
    console.error('Searched standard locations relative to repo and current directory.');
    console.error('Specify path using --checker <path> or set CLEAN_ROOM_CHECKER environment variable.');
    process.exit(2);
  }

  const isSelftest = args.includes('--selftest');
  if (isSelftest) {
    try {
      const output = execFileSync(process.execPath, [checkerPath, 'selftest'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      console.log(output.trim());
      process.exit(0);
    } catch (err) {
      console.error('Clean-room checker self-test failed:');
      console.error(err.stderr || err.message);
      process.exit(1);
    }
  }

  const isJson = args.includes('--json');
  const isVerbose = args.includes('--verbose');

  let targetDir = path.resolve(__dirname, '..');
  const positional = args.filter(a => !a.startsWith('-'));
  if (positional.length > 0) {
    targetDir = path.resolve(positional[0]);
  }

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    console.error(`ERROR: Target directory does not exist: ${targetDir}`);
    process.exit(2);
  }

  const maxTotalIdx = args.indexOf('--max-total');
  const maxTotal = maxTotalIdx !== -1 && args[maxTotalIdx + 1] ? args[maxTotalIdx + 1] : '10';

  const maxPerFileIdx = args.indexOf('--max-per-file');
  const maxPerFile = maxPerFileIdx !== -1 && args[maxPerFileIdx + 1] ? args[maxPerFileIdx + 1] : '3';

  const scanArgs = [
    checkerPath,
    'scan',
    targetDir,
    '--json',
    '--max-total',
    maxTotal,
    '--max-per-file',
    maxPerFile
  ];

  let scanOutput = '';
  let exitCode = 0;

  try {
    scanOutput = execFileSync(process.execPath, scanArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    scanOutput = err.stdout || '';
    exitCode = err.status || 1;
  }

  let result;
  try {
    result = JSON.parse(scanOutput);
  } catch (e) {
    console.error('ERROR: Failed to parse clean-room checker JSON output:');
    console.error(scanOutput);
    process.exit(exitCode !== 0 ? exitCode : 2);
  }

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.pass ? 0 : 1);
  }

  console.log('======================================================================');
  console.log('JOBHUNT CREW — CLEAN-ROOM PROVENANCE VERIFICATION');
  console.log('======================================================================');
  console.log(`Target Workspace : ${result.dir}`);
  console.log(`Checker Utility  : ${checkerPath}`);
  console.log(`Files Scanned    : ${result.filesScanned}`);
  console.log(`Shared Shingles  : ${result.sharedShingles} (Threshold: <= ${result.limits.maxTotal} total, <= ${result.limits.maxPerFile} per file)`);
  console.log(`Files with Hits  : ${result.filesWithMatches}`);

  if (result.matches && result.matches.length > 0) {
    console.log('----------------------------------------------------------------------');
    console.log('Detailed Match Breakdown:');
    for (const match of result.matches) {
      const overLimit = match.sharedShingles > result.limits.maxPerFile ? ' [VIOLATION]' : ' [TOLERANCE]';
      console.log(`  - ${match.file}: ${match.sharedShingles} shingle(s)${overLimit}`);
      if (isVerbose || match.sharedShingles > result.limits.maxPerFile) {
        console.log(`    Sample token match: "${match.firstMatchTokens}"`);
      }
    }
  }

  console.log('----------------------------------------------------------------------');
  if (result.pass) {
    console.log('VERDICT: CLEAN-ROOM CHECK PASSED (0 unauthorized provenance violations)');
    console.log('======================================================================');
    process.exit(0);
  } else {
    console.log('VERDICT: CLEAN-ROOM CHECK FAILED (Provenance thresholds exceeded)');
    console.log('Action: Re-conceive and rewrite the flagged files in original prose.');
    console.log('======================================================================');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { resolveCheckerPath };
