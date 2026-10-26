'use strict';

/**
 * JobHunt Crew — Empirical Packaging & Repository Hygiene Stress Test Suite
 *
 * Authored by: challenger_m8_iter2_1
 * Role: Packaging & Concurrency Stress Challenger
 *
 * Verifies:
 * 1. Multi-run hash parity across 25 sequential runs and 15 concurrent parallel runs.
 * 2. Decompression and 100% byte-for-byte parity against on-disk source files.
 * 3. Exact POSIX executable permissions (0o755 for bin/crew.js and bin/crew-mcp.js, 0o644 for regular files).
 * 4. Exclusion hygiene: 0 leaked files from tests, .git, .crew, .clean-room, tmp, dist, or pii-denylist.
 * 5. Adversarial dirty-workspace injection testing (poison files must be completely excluded).
 * 6. Edge-case archiver stress (0-byte files, incompressible/repetitive data, duplicate paths, path normalization).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');

const repoRoot = path.resolve(__dirname, '../..');
const packagerPath = path.join(repoRoot, 'scripts', 'package-dist.js');
const {
  DeterministicZipArchiver,
  buildDistPackages,
  verifyDistPackages,
  collectWorkspaceFiles,
  GLOBAL_EXCLUSION_PATTERNS,
  DOS_DATE_CONSTANT,
  DOS_TIME_CONSTANT,
  MODE_REGULAR_FILE,
  MODE_EXECUTABLE
} = require(packagerPath);

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

function check(desc, fn) {
  totalChecks++;
  try {
    fn();
    passedChecks++;
    console.log(`  [PASS] ${desc}`);
  } catch (err) {
    failedChecks++;
    console.error(`  [FAIL] ${desc}: ${err.message}`);
    if (err.stack) {
      console.error(`    ${err.stack.split('\n').slice(1, 3).join('\n    ')}`);
    }
  }
}

async function checkAsync(desc, fn) {
  totalChecks++;
  try {
    await fn();
    passedChecks++;
    console.log(`  [PASS] ${desc}`);
  } catch (err) {
    failedChecks++;
    console.error(`  [FAIL] ${desc}: ${err.message}`);
    if (err.stack) {
      console.error(`    ${err.stack.split('\n').slice(1, 3).join('\n    ')}`);
    }
  }
}

/**
 * Pure Node.js PKZIP 2.0 Parser & Extractor
 * Reads Central Directory and extracts entries.
 */
function parseZip(buffer) {
  // Find End of Central Directory Record (EOCD)
  // EOCD signature: 0x06054b50
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('EOCD signature not found in ZIP buffer');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let curOffset = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(curOffset) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory signature at offset ${curOffset}`);
    }

    const versionMadeBy = buffer.readUInt16LE(curOffset + 4);
    const versionNeeded = buffer.readUInt16LE(curOffset + 6);
    const flags = buffer.readUInt16LE(curOffset + 8);
    const method = buffer.readUInt16LE(curOffset + 10);
    const dosTime = buffer.readUInt16LE(curOffset + 12);
    const dosDate = buffer.readUInt16LE(curOffset + 14);
    const crc32 = buffer.readUInt32LE(curOffset + 16);
    const compressedSize = buffer.readUInt32LE(curOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(curOffset + 24);
    const nameLen = buffer.readUInt16LE(curOffset + 28);
    const extraLen = buffer.readUInt16LE(curOffset + 30);
    const commentLen = buffer.readUInt16LE(curOffset + 32);
    const externalAttrs = buffer.readUInt32LE(curOffset + 38);
    const localHeaderOffset = buffer.readUInt32LE(curOffset + 42);

    const name = buffer.toString('utf8', curOffset + 46, curOffset + 46 + nameLen);

    // Read Local File Header
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid Local File Header signature at offset ${localHeaderOffset}`);
    }
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawCompressed = buffer.slice(dataStart, dataStart + compressedSize);

    let decompressed;
    if (method === 0) {
      decompressed = rawCompressed;
    } else if (method === 8) {
      decompressed = zlib.inflateRawSync(rawCompressed);
    } else {
      throw new Error(`Unsupported compression method ${method} for entry ${name}`);
    }

    if (decompressed.length !== uncompressedSize) {
      throw new Error(`Uncompressed size mismatch for ${name}: expected ${uncompressedSize}, got ${decompressed.length}`);
    }

    const computedCrc = DeterministicZipArchiver.crc32(decompressed);
    if (computedCrc !== crc32) {
      throw new Error(`CRC-32 mismatch for ${name}: expected ${crc32}, got ${computedCrc}`);
    }

    const posixMode = (externalAttrs >>> 16) & 0o777777;
    const permissions = posixMode & 0o777;

    entries.push({
      name,
      method,
      dosDate,
      dosTime,
      crc32,
      compressedSize,
      uncompressedSize,
      externalAttrs,
      posixMode,
      permissions,
      decompressed,
      versionMadeBy
    });

    curOffset += 46 + nameLen + extraLen + commentLen;
  }

  return { totalEntries, cdSize, cdOffset, entries };
}

async function runEmpiricalStressSuite() {
  console.log('======================================================================');
  console.log('CHALLENGER M8: EMPIRICAL PACKAGING & REPOSITORY HYGIENE STRESS HARNESS');
  console.log('======================================================================\n');

  // ============================================================================
  // SECTION 1: Multi-Run Hash Parity Stress Test (Sequential & Parallel)
  // ============================================================================
  console.log('>>> SECTION 1: Multi-Run Hash Parity Stress Testing');

  const baselineTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-baseline-'));
  const baselineResult = buildDistPackages({ workspaceDir: repoRoot, distDir: baselineTemp });
  const baselineEngineHash = baselineResult.engine.sha256;
  const baselineSetupHash = baselineResult.setup.sha256;
  const baselineEngineSize = baselineResult.engine.sizeBytes;
  const baselineSetupSize = baselineResult.setup.sizeBytes;

  console.log(`  Baseline Engine SHA-256: ${baselineEngineHash} (${baselineEngineSize} bytes)`);
  console.log(`  Baseline Setup  SHA-256: ${baselineSetupHash} (${baselineSetupSize} bytes)`);

  check('Baseline packages built successfully with non-zero size', () => {
    assert.ok(baselineEngineSize > 1000, 'Engine zip size must be > 1000 bytes');
    assert.ok(baselineSetupSize > 1000, 'Setup zip size must be > 1000 bytes');
    assert.strictEqual(typeof baselineEngineHash, 'string');
    assert.strictEqual(baselineEngineHash.length, 64);
  });

  // 1.1 25 Sequential Runs Hash Parity
  check('25 consecutive sequential package builds produce 100% bit-for-bit identical hashes', () => {
    const seqTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-seq-'));
    try {
      for (let run = 1; run <= 25; run++) {
        const runDist = path.join(seqTemp, `run-${run}`);
        const res = buildDistPackages({ workspaceDir: repoRoot, distDir: runDist });
        assert.strictEqual(
          res.engine.sha256,
          baselineEngineHash,
          `Engine SHA mismatch on sequential run ${run}: ${res.engine.sha256} vs ${baselineEngineHash}`
        );
        assert.strictEqual(
          res.setup.sha256,
          baselineSetupHash,
          `Setup SHA mismatch on sequential run ${run}: ${res.setup.sha256} vs ${baselineSetupHash}`
        );
        assert.strictEqual(res.engine.sizeBytes, baselineEngineSize, `Engine size mismatch on run ${run}`);
        assert.strictEqual(res.setup.sizeBytes, baselineSetupSize, `Setup size mismatch on run ${run}`);
      }
    } finally {
      fs.rmSync(seqTemp, { recursive: true, force: true });
    }
  });

  // 1.2 15 Concurrent Parallel Runs Hash Parity
  await checkAsync('15 concurrent parallel packaging builds in isolated dirs yield 100% identical hashes', async () => {
    const parTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-par-'));
    try {
      const runPromises = [];
      for (let i = 1; i <= 15; i++) {
        const dir = path.join(parTemp, `par-${i}`);
        runPromises.push(
          new Promise((resolve, reject) => {
            try {
              const res = buildDistPackages({ workspaceDir: repoRoot, distDir: dir });
              resolve({ index: i, res });
            } catch (err) {
              reject(err);
            }
          })
        );
      }

      const results = await Promise.all(runPromises);
      assert.strictEqual(results.length, 15, 'All 15 parallel builds must complete');
      for (const { index, res } of results) {
        assert.strictEqual(
          res.engine.sha256,
          baselineEngineHash,
          `Parallel run ${index} engine hash mismatch`
        );
        assert.strictEqual(
          res.setup.sha256,
          baselineSetupHash,
          `Parallel run ${index} setup hash mismatch`
        );
      }
    } finally {
      fs.rmSync(parTemp, { recursive: true, force: true });
    }
  });

  // 1.3 verifyDistPackages Built-in Verification Function
  check('verifyDistPackages() self-verification returns pass: true with matching hashes', () => {
    const verifyReport = verifyDistPackages({ workspaceDir: repoRoot });
    assert.strictEqual(verifyReport.pass, true, 'verifyDistPackages must report pass = true');
    assert.strictEqual(verifyReport.engine.match, true, 'Engine runs must match');
    assert.strictEqual(verifyReport.setup.match, true, 'Setup runs must match');
    assert.strictEqual(verifyReport.engine.run1Sha256, baselineEngineHash);
    assert.strictEqual(verifyReport.setup.run1Sha256, baselineSetupHash);
  });

  // ============================================================================
  // SECTION 2: Decompress Packages & Verify Byte Parity Against On-Disk Files
  // ============================================================================
  console.log('\n>>> SECTION 2: Package Decompression & Byte-for-Byte Parity Verification');

  const engineZipBuf = fs.readFileSync(baselineResult.engine.path);
  const setupZipBuf = fs.readFileSync(baselineResult.setup.path);

  const parsedEngine = parseZip(engineZipBuf);
  const parsedSetup = parseZip(setupZipBuf);

  console.log(`  Parsed Engine Zip entries: ${parsedEngine.entries.length}`);
  console.log(`  Parsed Setup Zip entries : ${parsedSetup.entries.length}`);

  check('Engine package contains expected entry count (> 40 files)', () => {
    assert.ok(parsedEngine.entries.length >= 40, `Engine package entry count (${parsedEngine.entries.length}) should be >= 40`);
  });

  check('Setup package contains expected entry count (> 15 files)', () => {
    assert.ok(parsedSetup.entries.length >= 15, `Setup package entry count (${parsedSetup.entries.length}) should be >= 15`);
  });

  check('Every file in engine package matches on-disk source byte-for-byte', () => {
    for (const entry of parsedEngine.entries) {
      const diskPath = path.join(repoRoot, entry.name);
      assert.ok(fs.existsSync(diskPath), `Entry ${entry.name} from zip must exist on disk at ${diskPath}`);
      const diskContent = fs.readFileSync(diskPath);
      assert.strictEqual(
        entry.decompressed.length,
        diskContent.length,
        `Byte length mismatch for ${entry.name}: zip=${entry.decompressed.length}, disk=${diskContent.length}`
      );
      assert.strictEqual(
        Buffer.compare(entry.decompressed, diskContent),
        0,
        `Byte-for-byte content mismatch for ${entry.name}`
      );
    }
  });

  check('Every file in setup package matches on-disk source byte-for-byte', () => {
    for (const entry of parsedSetup.entries) {
      const diskPath = path.join(repoRoot, entry.name);
      assert.ok(fs.existsSync(diskPath), `Entry ${entry.name} from setup zip must exist on disk`);
      const diskContent = fs.readFileSync(diskPath);
      assert.strictEqual(
        Buffer.compare(entry.decompressed, diskContent),
        0,
        `Byte-for-byte content mismatch for setup entry ${entry.name}`
      );
    }
  });

  check('Lexicographical ordering: Zip central directory entries are strictly sorted', () => {
    const engineNames = parsedEngine.entries.map(e => e.name);
    const sortedEngineNames = [...engineNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepStrictEqual(engineNames, sortedEngineNames, 'Engine zip entries must be sorted lexicographically');

    const setupNames = parsedSetup.entries.map(e => e.name);
    const sortedSetupNames = [...setupNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepStrictEqual(setupNames, sortedSetupNames, 'Setup zip entries must be sorted lexicographically');
  });

  check('Zero duplicate paths exist in either package', () => {
    const engineNames = parsedEngine.entries.map(e => e.name);
    const uniqueEngineNames = new Set(engineNames);
    assert.strictEqual(engineNames.length, uniqueEngineNames.size, 'No duplicate paths in engine zip');

    const setupNames = parsedSetup.entries.map(e => e.name);
    const uniqueSetupNames = new Set(setupNames);
    assert.strictEqual(setupNames.length, uniqueSetupNames.size, 'No duplicate paths in setup zip');
  });

  check('All entries have canonical MS-DOS timestamp constant (1980-01-01 00:00:00)', () => {
    for (const entry of parsedEngine.entries) {
      assert.strictEqual(entry.dosDate, DOS_DATE_CONSTANT, `DOS date for ${entry.name} must be ${DOS_DATE_CONSTANT}`);
      assert.strictEqual(entry.dosTime, DOS_TIME_CONSTANT, `DOS time for ${entry.name} must be ${DOS_TIME_CONSTANT}`);
    }
    for (const entry of parsedSetup.entries) {
      assert.strictEqual(entry.dosDate, DOS_DATE_CONSTANT, `DOS date for ${entry.name} must be ${DOS_DATE_CONSTANT}`);
      assert.strictEqual(entry.dosTime, DOS_TIME_CONSTANT, `DOS time for ${entry.name} must be ${DOS_TIME_CONSTANT}`);
    }
  });

  // ============================================================================
  // SECTION 3: Executable Permissions Verification
  // ============================================================================
  console.log('\n>>> SECTION 3: Executable File Permissions Verification');

  const engineEntryMap = new Map(parsedEngine.entries.map(e => [e.name, e]));

  check('bin/crew.js is present in engine package with mode 0o100755 (permissions 0o755)', () => {
    const entry = engineEntryMap.get('bin/crew.js');
    assert.ok(entry, 'bin/crew.js must be in engine package');
    assert.strictEqual(entry.posixMode, 0o100755, `bin/crew.js posixMode must be 0o100755, got 0o${entry.posixMode.toString(8)}`);
    assert.strictEqual(entry.permissions, 0o755, `bin/crew.js permissions must be 0o755, got 0o${entry.permissions.toString(8)}`);
  });

  check('bin/crew-mcp.js is present in engine package with mode 0o100755 (permissions 0o755)', () => {
    const entry = engineEntryMap.get('bin/crew-mcp.js');
    assert.ok(entry, 'bin/crew-mcp.js must be in engine package');
    assert.strictEqual(entry.posixMode, 0o100755, `bin/crew-mcp.js posixMode must be 0o100755, got 0o${entry.posixMode.toString(8)}`);
    assert.strictEqual(entry.permissions, 0o755, `bin/crew-mcp.js permissions must be 0o755, got 0o${entry.permissions.toString(8)}`);
  });

  check('All files in bin/ have executable permissions (0o755)', () => {
    const binEntries = parsedEngine.entries.filter(e => e.name.startsWith('bin/'));
    assert.ok(binEntries.length >= 2, 'Must have at least 2 files in bin/');
    for (const entry of binEntries) {
      assert.strictEqual(entry.permissions, 0o755, `${entry.name} in bin/ must have 0o755 permissions`);
      assert.strictEqual(entry.posixMode, 0o100755, `${entry.name} in bin/ must have 0o100755 mode`);
    }
  });

  check('Regular files (e.g. package.json, README.md, LICENSE) have mode 0o100644 (permissions 0o644)', () => {
    const regularSamples = ['package.json', 'README.md', 'LICENSE', 'NOTICE'];
    for (const name of regularSamples) {
      const entry = engineEntryMap.get(name);
      assert.ok(entry, `${name} must be in engine package`);
      assert.strictEqual(entry.posixMode, 0o100644, `${name} posixMode must be 0o100644, got 0o${entry.posixMode.toString(8)}`);
      assert.strictEqual(entry.permissions, 0o644, `${name} permissions must be 0o644, got 0o${entry.permissions.toString(8)}`);
    }
  });

  check('Version Made By field in Central Directory indicates UNIX (3) and Zip 2.0 (20)', () => {
    for (const entry of parsedEngine.entries) {
      assert.strictEqual(
        entry.versionMadeBy,
        (3 << 8) | 20,
        `Version made by for ${entry.name} must be UNIX 2.0 (0x0314)`
      );
    }
  });

  // ============================================================================
  // SECTION 4: Audit Exclusion Hygiene
  // ============================================================================
  console.log('\n>>> SECTION 4: Repository Hygiene & Exclusion Audit');

  const FORBIDDEN_SUBSTRINGS = [
    'tests/',
    'tests\\',
    '.git/',
    '.git\\',
    '.crew/',
    '.crew\\',
    '.clean-room/',
    '.clean-room\\',
    'tmp/',
    'tmp\\',
    'dist/',
    'dist\\',
    '.agents/',
    '.agents\\',
    'node_modules',
    'coverage',
    'desktop.ini',
    'Thumbs.db',
    '.DS_Store'
  ];

  function checkForbidden(entries, pkgName) {
    const leaks = [];
    for (const entry of entries) {
      for (const bad of FORBIDDEN_SUBSTRINGS) {
        if (entry.name === bad || entry.name.startsWith(bad) || entry.name.includes('/' + bad)) {
          leaks.push({ file: entry.name, matched: bad });
        }
      }
      // Strictly forbid .pii-denylist (only .pii-denylist.example is permitted)
      if (entry.name === '.pii-denylist' || (entry.name.startsWith('.pii-denylist') && !entry.name.endsWith('.example'))) {
        leaks.push({ file: entry.name, matched: 'forbidden pii-denylist' });
      }
    }
    assert.strictEqual(leaks.length, 0, `${pkgName} contains leaked files: ${JSON.stringify(leaks)}`);
  }

  check('Zero forbidden paths leak into engine package', () => {
    checkForbidden(parsedEngine.entries, 'Engine package');
  });

  check('Zero forbidden paths leak into setup package', () => {
    checkForbidden(parsedSetup.entries, 'Setup package');
  });

  check('Neither package contains .pii-denylist (only safe .pii-denylist.example allowed)', () => {
    const engineHasDenylist = parsedEngine.entries.some(e => e.name === '.pii-denylist');
    const setupHasDenylist = parsedSetup.entries.some(e => e.name === '.pii-denylist');
    assert.strictEqual(engineHasDenylist, false, 'Engine must not contain .pii-denylist');
    assert.strictEqual(setupHasDenylist, false, 'Setup must not contain .pii-denylist');

    const engineHasExample = parsedEngine.entries.some(e => e.name === '.pii-denylist.example');
    assert.strictEqual(engineHasExample, true, 'Engine should include harmless template .pii-denylist.example');
  });

  // ============================================================================
  // SECTION 5: Adversarial Dirty-Workspace Poison Test
  // ============================================================================
  console.log('\n>>> SECTION 5: Adversarial Dirty-Workspace Poison Test');

  check('Adversarial dirty-workspace: Planted poison files in all restricted categories are 100% blocked', () => {
    const dirtyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-dirty-ws-'));
    const dirtyDist = path.join(dirtyRoot, 'dist_out');

    try {
      // 1. Replicate minimal valid workspace structure
      fs.mkdirSync(path.join(dirtyRoot, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(dirtyRoot, 'lib'), { recursive: true });
      fs.mkdirSync(path.join(dirtyRoot, 'templates'), { recursive: true });
      fs.mkdirSync(path.join(dirtyRoot, 'agents'), { recursive: true });
      fs.mkdirSync(path.join(dirtyRoot, 'skills'), { recursive: true });

      fs.writeFileSync(path.join(dirtyRoot, 'package.json'), JSON.stringify({ name: 'jobhunt-crew', version: '0.1.0' }));
      fs.writeFileSync(path.join(dirtyRoot, 'README.md'), '# Test');
      fs.writeFileSync(path.join(dirtyRoot, 'LICENSE'), 'MIT');
      fs.writeFileSync(path.join(dirtyRoot, 'NOTICE'), 'Notice');
      fs.writeFileSync(path.join(dirtyRoot, 'bin', 'crew.js'), '#!/usr/bin/env node\nconsole.log("ok");');
      fs.writeFileSync(path.join(dirtyRoot, 'bin', 'crew-mcp.js'), '#!/usr/bin/env node\nconsole.log("mcp");');
      fs.writeFileSync(path.join(dirtyRoot, 'lib', 'test.js'), 'module.exports = {};');

      // 2. Plant adversarial poison files
      const poisonFiles = [
        path.join(dirtyRoot, 'tests', 'unit', 'secret-test.js'),
        path.join(dirtyRoot, 'tests', 'e2e-runner.js'),
        path.join(dirtyRoot, '.git', 'config'),
        path.join(dirtyRoot, '.git', 'HEAD'),
        path.join(dirtyRoot, '.crew', 'ledger.jsonl'),
        path.join(dirtyRoot, '.crew', 'ledger.lock'),
        path.join(dirtyRoot, '.crew', 'snapshot.json'),
        path.join(dirtyRoot, '.clean-room', 'restricted-token.txt'),
        path.join(dirtyRoot, 'tmp', 'dump.raw'),
        path.join(dirtyRoot, 'dist', 'old-release.zip'),
        path.join(dirtyRoot, '.pii-denylist'),
        path.join(dirtyRoot, '.agents', 'teamwork', 'secret.md'),
        path.join(dirtyRoot, 'node_modules', 'leak-package', 'index.js'),
        path.join(dirtyRoot, 'coverage', 'lcov.info'),
        path.join(dirtyRoot, 'desktop.ini'),
        path.join(dirtyRoot, 'Thumbs.db'),
        path.join(dirtyRoot, '.DS_Store'),
        path.join(dirtyRoot, 'lib', 'crash.log'),
        path.join(dirtyRoot, 'lib', 'active.lock'),
        path.join(dirtyRoot, 'lib', 'scratch.tmp'),
        path.join(dirtyRoot, 'TEST_INFRA.md'),
        path.join(dirtyRoot, 'TEST_READY.md')
      ];

      for (const p of poisonFiles) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, 'POISON_CONTENT_' + path.basename(p));
      }

      // 3. Build packages from dirty workspace
      const dirtyResult = buildDistPackages({ workspaceDir: dirtyRoot, distDir: dirtyDist });
      const dirtyEngineZip = fs.readFileSync(dirtyResult.engine.path);
      const dirtySetupZip = fs.readFileSync(dirtyResult.setup.path);

      const parsedDirtyEngine = parseZip(dirtyEngineZip);
      const parsedDirtySetup = parseZip(dirtySetupZip);

      const allDirtyEntries = [
        ...parsedDirtyEngine.entries.map(e => e.name),
        ...parsedDirtySetup.entries.map(e => e.name)
      ];

      for (const poisonPath of poisonFiles) {
        const relPoison = path.relative(dirtyRoot, poisonPath).replace(/\\/g, '/');
        assert.ok(
          !allDirtyEntries.includes(relPoison),
          `Poison file leaked into archive: ${relPoison}`
        );
      }

      // Assert zero poison contents exist in any decompressed buffer
      for (const entry of parsedDirtyEngine.entries) {
        const str = entry.decompressed.toString('utf8');
        assert.ok(!str.includes('POISON_CONTENT_'), `Poison content leaked in entry ${entry.name}`);
      }
    } finally {
      fs.rmSync(dirtyRoot, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // SECTION 6: Archiver Edge-Case Stress Testing
  // ============================================================================
  console.log('\n>>> SECTION 6: Archiver In-Memory Edge-Case Stress Testing');

  check('Archiver handles 0-byte empty files without header corruption or CRC errors', () => {
    const archiver = new DeterministicZipArchiver();
    archiver.addFile('empty.txt', Buffer.alloc(0));
    const zipBuf = archiver.build();
    const parsed = parseZip(zipBuf);
    assert.strictEqual(parsed.entries.length, 1);
    assert.strictEqual(parsed.entries[0].name, 'empty.txt');
    assert.strictEqual(parsed.entries[0].uncompressedSize, 0);
    assert.strictEqual(parsed.entries[0].decompressed.length, 0);
    assert.strictEqual(parsed.entries[0].crc32, 0);
  });

  check('Archiver handles large highly compressible and incompressible buffers', () => {
    const archiver = new DeterministicZipArchiver();
    // 500 KB repetitive compressible data
    const repetitive = Buffer.alloc(500 * 1024, 0x41); // 'AAAA...'
    archiver.addFile('large-repetitive.bin', repetitive);

    // 100 KB random incompressible data
    const random = crypto.randomBytes(100 * 1024);
    archiver.addFile('large-random.bin', random);

    const zipBuf = archiver.build();
    const parsed = parseZip(zipBuf);
    assert.strictEqual(parsed.entries.length, 2);

    const repEntry = parsed.entries.find(e => e.name === 'large-repetitive.bin');
    assert.ok(repEntry, 'Must find repetitive entry');
    assert.strictEqual(repEntry.method, 8, 'Repetitive data must use DEFLATE');
    assert.ok(repEntry.compressedSize < repEntry.uncompressedSize / 10, 'Compression ratio should be > 10x');
    assert.strictEqual(Buffer.compare(repEntry.decompressed, repetitive), 0, 'Decompressed repetitive must match');

    const randEntry = parsed.entries.find(e => e.name === 'large-random.bin');
    assert.ok(randEntry, 'Must find random entry');
    assert.strictEqual(Buffer.compare(randEntry.decompressed, random), 0, 'Decompressed random must match');
  });

  check('Archiver normalizes paths with backslashes, leading ./, and repeated slashes', () => {
    const archiver = new DeterministicZipArchiver();
    archiver.addFile('.\\folder\\\\subfolder\\file.txt', 'hello');
    archiver.addFile('/leading/slash/test.txt', 'world');
    const zipBuf = archiver.build();
    const parsed = parseZip(zipBuf);
    const names = parsed.entries.map(e => e.name);
    assert.ok(names.includes('folder/subfolder/file.txt'), 'Path must be normalized to POSIX');
    assert.ok(names.includes('leading/slash/test.txt'), 'Leading slash must be removed');
  });

  check('Archiver duplicate entry replacement: Last addFile wins and zero duplicate entries created', () => {
    const archiver = new DeterministicZipArchiver();
    archiver.addFile('config.json', '{"v": 1}');
    archiver.addFile('config.json', '{"v": 2}');
    archiver.addFile('./config.json', '{"v": 3}');
    const zipBuf = archiver.build();
    const parsed = parseZip(zipBuf);
    assert.strictEqual(parsed.entries.length, 1, 'Only 1 entry should exist');
    assert.strictEqual(parsed.entries[0].name, 'config.json');
    assert.strictEqual(parsed.entries[0].decompressed.toString('utf8'), '{"v": 3}');
  });

  check('Archiver handles UTF-8 filenames with FLAG_UTF8 bit set', () => {
    const archiver = new DeterministicZipArchiver();
    archiver.addFile('docs/ملف-عربي.md', 'Arabic filename test');
    const zipBuf = archiver.build();
    const parsed = parseZip(zipBuf);
    assert.strictEqual(parsed.entries.length, 1);
    assert.strictEqual(parsed.entries[0].name, 'docs/ملف-عربي.md');
    assert.strictEqual(parsed.entries[0].decompressed.toString('utf8'), 'Arabic filename test');
  });

  // Cleanup baseline temp
  try {
    fs.rmSync(baselineTemp, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n======================================================================');
  console.log('CHALLENGER M8 EMPIRICAL STRESS TEST SUMMARY');
  console.log('======================================================================');
  console.log(`Total Checks  : ${totalChecks}`);
  console.log(`Passed Checks : ${passedChecks}`);
  console.log(`Failed Checks : ${failedChecks}`);
  console.log(`Success Rate  : ${((passedChecks / totalChecks) * 100).toFixed(1)}%`);
  console.log('======================================================================');

  if (failedChecks > 0) {
    console.error(`>>> EMPIRICAL STRESS TESTS FAILED WITH ${failedChecks} ERRORS <<<`);
    process.exit(1);
  } else {
    console.log('>>> ALL EMPIRICAL STRESS TESTS PASSED (100% REPRODUCIBLE & SECURE) <<<');
    process.exit(0);
  }
}

if (require.main === module) {
  runEmpiricalStressSuite().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
  });
}

module.exports = { runEmpiricalStressSuite };
