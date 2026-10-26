'use strict';

/**
 * Milestone M8 Empirical Adversarial Stress Test Suite:
 * Reproducible Packaging Stress, Multi-Run Hash Parity & Exclusion Hygiene
 *
 * Authored by: challenger_m8_1 (Empirical Challenger)
 * Roles: critic, specialist
 *
 * Verification Scope & Invariants:
 * 1. Multi-Run Hash Parity Stress: 15 consecutive runs across randomized temporary
 *    directories yield 100% bit-for-bit identical SHA-256 digests.
 * 2. Temporal Invariance: Packaging output is invariant to execution wall-clock time
 *    and delays (DOS date/time fixed to 1980-01-01 00:00:00).
 * 3. PKZIP 2.0 Binary Structure & Specification Conformance: EOCD, CD, and LFH
 *    records conform to PKZIP 2.0 specification with zero extra headers or comment leakage.
 * 4. Decompression & File Parity: Every entry decompresses cleanly and matches
 *    the on-disk source file byte-for-byte with 100% CRC-32 fidelity.
 * 5. Normalized File Attributes & Executable Permissions: 0o100755 for bin/ and
 *    shebang executables, 0o100644 for regular files, zero 0o777 leaks.
 * 6. Exclusion Leakage Probe: Zero leakage of tests, .git, .crew, .clean-room, tmp,
 *    dist, .pii-denylist, lockfiles, logfiles, coverage, or OS metadata.
 * 7. Setup Package Isolation: Contains strictly onboarding/template files, zero bin/ or lib/.
 * 8. Adversarial Bait Injection: Deliberately planted bait files in a mock workspace
 *    are 100% rejected by filtering rules.
 * 9. DeterministicZipArchiver Fuzzing: Path normalization, deduplication, sorting
 *    under scrambled inputs, zero-byte handling, and compression fallback.
 * 10. CLI Interface: --verify, --json, and custom directory switches.
 *
 * Zero external dependencies. Uses Node.js built-ins (fs, path, crypto, zlib, os, child_process).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { TestSuite } = require('../helpers/test-harness');

const repoRoot = path.resolve(__dirname, '..', '..');
const packageDistScript = path.join(repoRoot, 'scripts', 'package-dist.js');
const {
  DeterministicZipArchiver,
  buildDistPackages,
  verifyDistPackages,
  collectWorkspaceFiles,
  ENGINE_TARGETS,
  SETUP_TARGETS,
  GLOBAL_EXCLUSION_PATTERNS,
  DOS_DATE_CONSTANT,
  DOS_TIME_CONSTANT,
  MODE_REGULAR_FILE,
  MODE_EXECUTABLE
} = require(packageDistScript);

const suite = new TestSuite('M8 Adversarial Stress Suite: Reproducible Packaging & Hash Parity');

/**
 * Pure Node.js PKZIP archive parser for independent binary audit and decompression.
 */
function parseZipArchive(zipBuffer) {
  // 1. Locate End of Central Directory Record (EOCD)
  // EOCD signature: 0x06054b50
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 65557); i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('EOCD signature not found in zip archive');
  }

  const diskNumber = zipBuffer.readUInt16LE(eocdOffset + 4);
  const cdStartDisk = zipBuffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = zipBuffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const commentLen = zipBuffer.readUInt16LE(eocdOffset + 20);

  // 2. Parse Central Directory Headers
  const entries = [];
  let currentOffset = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    const sig = zipBuffer.readUInt32LE(currentOffset);
    if (sig !== 0x02014b50) {
      throw new Error(`Invalid Central Directory Header signature at offset ${currentOffset}: 0x${sig.toString(16)}`);
    }

    const versionMadeBy = zipBuffer.readUInt16LE(currentOffset + 4);
    const versionNeeded = zipBuffer.readUInt16LE(currentOffset + 6);
    const flag = zipBuffer.readUInt16LE(currentOffset + 8);
    const method = zipBuffer.readUInt16LE(currentOffset + 10);
    const modTime = zipBuffer.readUInt16LE(currentOffset + 12);
    const modDate = zipBuffer.readUInt16LE(currentOffset + 14);
    const crc32 = zipBuffer.readUInt32LE(currentOffset + 16);
    const compressedSize = zipBuffer.readUInt32LE(currentOffset + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(currentOffset + 24);
    const nameLen = zipBuffer.readUInt16LE(currentOffset + 28);
    const extraLen = zipBuffer.readUInt16LE(currentOffset + 30);
    const commentLength = zipBuffer.readUInt16LE(currentOffset + 32);
    const diskStart = zipBuffer.readUInt16LE(currentOffset + 34);
    const intAttr = zipBuffer.readUInt16LE(currentOffset + 36);
    const extAttr = zipBuffer.readUInt32LE(currentOffset + 38);
    const localHeaderOffset = zipBuffer.readUInt32LE(currentOffset + 42);

    const nameBuf = zipBuffer.slice(currentOffset + 46, currentOffset + 46 + nameLen);
    const entryPath = nameBuf.toString('utf8');

    // 3. Parse Local File Header at localHeaderOffset
    const lfhSig = zipBuffer.readUInt32LE(localHeaderOffset);
    if (lfhSig !== 0x04034b50) {
      throw new Error(`Invalid Local File Header signature at offset ${localHeaderOffset} for entry ${entryPath}`);
    }
    const lfhNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;

    const rawData = zipBuffer.slice(dataOffset, dataOffset + compressedSize);

    // Decompress payload
    let decompressed;
    if (method === 0) {
      decompressed = rawData;
    } else if (method === 8) {
      decompressed = zlib.inflateRawSync(rawData);
    } else {
      throw new Error(`Unsupported compression method ${method} for ${entryPath}`);
    }

    entries.push({
      path: entryPath,
      method,
      modTime,
      modDate,
      crc32,
      compressedSize,
      uncompressedSize,
      extraLen,
      commentLength,
      versionMadeBy,
      versionNeeded,
      flag,
      intAttr,
      extAttr,
      mode: extAttr >>> 16,
      localHeaderOffset,
      decompressed
    });

    currentOffset += 46 + nameLen + extraLen + commentLength;
  }

  return {
    eocd: {
      diskNumber,
      cdStartDisk,
      diskEntries,
      totalEntries,
      cdSize,
      cdOffset,
      commentLen
    },
    entries
  };
}

// ----------------------------------------------------------------------------
// Test 1: 15-Run Hash Parity Stress Across Randomized Temporary Directories
// ----------------------------------------------------------------------------
suite.test('1. Multi-Run Hash Parity Stress: 15 runs across randomized directories yield 100% identical SHA-256 digests', async (assert) => {
  const NUM_RUNS = 15;
  const tempDirs = [];
  const engineDigests = [];
  const setupDigests = [];
  const engineSizes = [];
  const setupSizes = [];

  try {
    for (let r = 0; r < NUM_RUNS; r++) {
      const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), `crew-parity-run-${r}-`));
      tempDirs.push(tmpDist);

      const result = buildDistPackages({
        workspaceDir: repoRoot,
        distDir: tmpDist
      });

      // Verify file presence
      assert.ok(fs.existsSync(result.engine.path), `Engine zip must exist for run ${r}`);
      assert.ok(fs.existsSync(result.setup.path), `Setup zip must exist for run ${r}`);

      // Independent SHA-256 calculation directly from disk
      const diskEngineSha256 = crypto.createHash('sha256').update(fs.readFileSync(result.engine.path)).digest('hex');
      const diskSetupSha256 = crypto.createHash('sha256').update(fs.readFileSync(result.setup.path)).digest('hex');

      assert.equal(diskEngineSha256, result.engine.sha256, `Engine reported hash must match disk hash for run ${r}`);
      assert.equal(diskSetupSha256, result.setup.sha256, `Setup reported hash must match disk hash for run ${r}`);

      engineDigests.push(diskEngineSha256);
      setupDigests.push(diskSetupSha256);
      engineSizes.push(result.engine.sizeBytes);
      setupSizes.push(result.setup.sizeBytes);
    }

    const baselineEngineDigest = engineDigests[0];
    const baselineSetupDigest = setupDigests[0];
    const baselineEngineSize = engineSizes[0];
    const baselineSetupSize = setupSizes[0];

    for (let r = 1; r < NUM_RUNS; r++) {
      assert.equal(
        engineDigests[r],
        baselineEngineDigest,
        `Engine SHA-256 on run ${r + 1} (${engineDigests[r]}) must match run 1 (${baselineEngineDigest})`
      );
      assert.equal(
        setupDigests[r],
        baselineSetupDigest,
        `Setup SHA-256 on run ${r + 1} (${setupDigests[r]}) must match run 1 (${baselineSetupDigest})`
      );
      assert.equal(
        engineSizes[r],
        baselineEngineSize,
        `Engine size on run ${r + 1} must match run 1 size (${baselineEngineSize})`
      );
      assert.equal(
        setupSizes[r],
        baselineSetupSize,
        `Setup size on run ${r + 1} must match run 1 size (${baselineSetupSize})`
      );
    }
  } finally {
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (_) {}
    }
  }
});

// ----------------------------------------------------------------------------
// Test 2: Temporal Invariance & Sleep Interleaving
// ----------------------------------------------------------------------------
suite.test('2. Temporal Invariance: Output hashes remain invariant across time shifts and sleeps', async (assert) => {
  const tmpDist1 = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-time-1-'));
  const tmpDist2 = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-time-2-'));

  try {
    const res1 = buildDistPackages({ workspaceDir: repoRoot, distDir: tmpDist1 });
    // Interleave deliberate delay
    await new Promise((resolve) => setTimeout(resolve, 250));
    const res2 = buildDistPackages({ workspaceDir: repoRoot, distDir: tmpDist2 });

    assert.equal(res1.engine.sha256, res2.engine.sha256, 'Engine SHA-256 must be invariant to wall-clock time');
    assert.equal(res1.setup.sha256, res2.setup.sha256, 'Setup SHA-256 must be invariant to wall-clock time');
    assert.equal(res1.engine.sizeBytes, res2.engine.sizeBytes, 'Engine size must be invariant to wall-clock time');
    assert.equal(res1.setup.sizeBytes, res2.setup.sizeBytes, 'Setup size must be invariant to wall-clock time');
  } finally {
    fs.rmSync(tmpDist1, { recursive: true, force: true });
    fs.rmSync(tmpDist2, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// Test 3: PKZIP 2.0 Binary Header Specification Conformance
// ----------------------------------------------------------------------------
suite.test('3. Binary Specification: EOCD, Central Directory, and LFH strictly conform to PKZIP 2.0 with zero extra headers', async (assert) => {
  const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-specs-'));
  try {
    const result = buildDistPackages({ workspaceDir: repoRoot, distDir: tmpDist });
    const engineBuf = fs.readFileSync(result.engine.path);
    const parsed = parseZipArchive(engineBuf);

    assert.equal(parsed.eocd.diskNumber, 0, 'EOCD disk number must be 0');
    assert.equal(parsed.eocd.cdStartDisk, 0, 'EOCD cdStartDisk must be 0');
    assert.equal(parsed.eocd.commentLen, 0, 'EOCD comment length must be 0');
    assert.equal(parsed.eocd.totalEntries, parsed.entries.length, 'EOCD entries must match parsed entries');
    assert.ok(parsed.entries.length >= 90, `Engine package must have >= 90 files (found ${parsed.entries.length})`);

    for (const entry of parsed.entries) {
      assert.equal(entry.modTime, DOS_TIME_CONSTANT, `Entry ${entry.path} DOS time must be fixed 0x0000`);
      assert.equal(entry.modDate, DOS_DATE_CONSTANT, `Entry ${entry.path} DOS date must be fixed 0x0021`);
      assert.equal(entry.extraLen, 0, `Entry ${entry.path} extra field length must be 0`);
      assert.equal(entry.commentLength, 0, `Entry ${entry.path} comment length must be 0`);
      assert.equal(entry.versionNeeded, 20, `Entry ${entry.path} version needed must be 20 (PKZIP 2.0)`);
      assert.equal(entry.versionMadeBy >> 8, 3, `Entry ${entry.path} version made by must be UNIX (3)`);
      assert.ok((entry.flag & 0x0800) !== 0, `Entry ${entry.path} UTF-8 bit flag (0x0800) must be set`);
    }

    // Verify strict lexicographical sorting of entries in Central Directory
    const paths = parsed.entries.map((e) => e.path);
    const sortedPaths = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(paths, sortedPaths, 'Central Directory entries must be strictly lexicographically sorted');
  } finally {
    fs.rmSync(tmpDist, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// Test 4: Complete Decompression and Byte-for-Byte On-Disk Roundtrip
// ----------------------------------------------------------------------------
suite.test('4. Decompression & File Parity: Every entry decompresses with valid CRC-32 and byte-for-byte on-disk parity', async (assert) => {
  const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-decompress-'));
  try {
    const result = buildDistPackages({ workspaceDir: repoRoot, distDir: tmpDist });

    // 1. Audit Engine Bundle
    const engineBuf = fs.readFileSync(result.engine.path);
    const parsedEngine = parseZipArchive(engineBuf);

    for (const entry of parsedEngine.entries) {
      const diskPath = path.join(repoRoot, entry.path);
      assert.ok(fs.existsSync(diskPath), `On-disk source file must exist for archive entry: ${entry.path}`);

      const diskBytes = fs.readFileSync(diskPath);

      // Verify uncompressed length
      assert.equal(entry.uncompressedSize, diskBytes.length, `Uncompressed size must match disk size for ${entry.path}`);
      assert.equal(entry.decompressed.length, diskBytes.length, `Decompressed length must match disk length for ${entry.path}`);

      // Verify CRC-32
      const computedCrc = DeterministicZipArchiver.crc32(entry.decompressed);
      assert.equal(entry.crc32, computedCrc, `CRC-32 must match computed CRC-32 for ${entry.path}`);

      // Verify 100% byte-for-byte identity
      const comp = Buffer.compare(entry.decompressed, diskBytes);
      assert.equal(comp, 0, `Decompressed bytes for ${entry.path} must match on-disk bytes 100%`);
    }

    // 2. Audit Setup Bundle
    const setupBuf = fs.readFileSync(result.setup.path);
    const parsedSetup = parseZipArchive(setupBuf);

    for (const entry of parsedSetup.entries) {
      const diskPath = path.join(repoRoot, entry.path);
      assert.ok(fs.existsSync(diskPath), `On-disk source file must exist for setup entry: ${entry.path}`);

      const diskBytes = fs.readFileSync(diskPath);
      assert.equal(entry.uncompressedSize, diskBytes.length, `Setup uncompressed size must match disk for ${entry.path}`);
      assert.equal(entry.decompressed.length, diskBytes.length, `Setup decompressed size must match disk for ${entry.path}`);

      const computedCrc = DeterministicZipArchiver.crc32(entry.decompressed);
      assert.equal(entry.crc32, computedCrc, `Setup CRC-32 must match for ${entry.path}`);

      const comp = Buffer.compare(entry.decompressed, diskBytes);
      assert.equal(comp, 0, `Setup decompressed bytes for ${entry.path} must match on-disk bytes 100%`);
    }
  } finally {
    fs.rmSync(tmpDist, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// Test 5: POSIX Permissions and Executable Flags Audit
// ----------------------------------------------------------------------------
suite.test('5. Normalized Permissions: Executables receive 0o100755; regular files receive 0o100644; zero 0o777', async (assert) => {
  const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-perms-'));
  try {
    const result = buildDistPackages({ workspaceDir: repoRoot, distDir: tmpDist });
    const parsed = parseZipArchive(fs.readFileSync(result.engine.path));

    let binCrewFound = false;
    let binCrewMcpFound = false;

    for (const entry of parsed.entries) {
      const mode = entry.mode;
      const perm = mode & 0o777;
      const diskPath = path.join(repoRoot, entry.path);
      const isShebanged = entry.decompressed.slice(0, 2).toString() === '#!';
      const isExpectedExec = entry.path.startsWith('bin/') || entry.path.endsWith('.sh') || (entry.path.endsWith('.js') && isShebanged);

      if (entry.path === 'bin/crew.js') {
        binCrewFound = true;
        assert.equal(mode, MODE_EXECUTABLE, 'bin/crew.js mode must be exactly 0o100755 (-rwxr-xr-x)');
        assert.equal(perm, 0o755, 'bin/crew.js permission bits must be 0o755');
      } else if (entry.path === 'bin/crew-mcp.js') {
        binCrewMcpFound = true;
        assert.equal(mode, MODE_EXECUTABLE, 'bin/crew-mcp.js mode must be exactly 0o100755 (-rwxr-xr-x)');
        assert.equal(perm, 0o755, 'bin/crew-mcp.js permission bits must be 0o755');
      } else if (isExpectedExec) {
        assert.equal(mode, MODE_EXECUTABLE, `Executable script ${entry.path} mode must be 0o100755 (-rwxr-xr-x)`);
        assert.equal(perm, 0o755, `Executable script ${entry.path} permission bits must be 0o755`);
      } else {
        // Regular files
        assert.equal(mode, MODE_REGULAR_FILE, `Regular file ${entry.path} mode must be 0o100644 (-rw-r--r--)`);
        assert.equal(perm, 0o644, `Regular file ${entry.path} permission bits must be 0o644`);
      }

      // Assert no accidental world-writable permissions
      assert.equal(perm & 0o002, 0, `Entry ${entry.path} must not be world-writable`);
    }

    assert.ok(binCrewFound, 'bin/crew.js must be present in engine package');
    assert.ok(binCrewMcpFound, 'bin/crew-mcp.js must be present in engine package');
  } finally {
    fs.rmSync(tmpDist, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// Test 6: Exclusion Hygiene Forensics Audit
// ----------------------------------------------------------------------------
suite.test('6. Exclusion Hygiene: Zero leakage of tests/, .git/, .crew/, .clean-room/, tmp/, dist/, PII, locks or logs', async (assert) => {
  const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-hygiene-'));
  try {
    const result = buildDistPackages({ workspaceDir: repoRoot, distDir: tmpDist });

    const checkExclusions = (archivePath, archiveName) => {
      const parsed = parseZipArchive(fs.readFileSync(archivePath));
      const entryPaths = parsed.entries.map((e) => e.path);

      // 1. Zero duplicate paths
      const uniquePaths = new Set(entryPaths);
      assert.equal(uniquePaths.size, entryPaths.length, `${archiveName} must contain zero duplicate paths`);

      for (const p of entryPaths) {
        // POSIX path normalization
        assert.ok(!p.includes('\\'), `${archiveName} path ${p} must not contain Windows backslashes`);
        assert.ok(!p.startsWith('./'), `${archiveName} path ${p} must not start with ./`);
        assert.ok(!p.startsWith('/'), `${archiveName} path ${p} must not start with /`);
        assert.ok(!p.endsWith('/'), `${archiveName} path ${p} must not have trailing slash (no directory entries)`);

        // Check against forbidden exclusion patterns
        assert.ok(!p.startsWith('tests/'), `${archiveName} must not contain tests: ${p}`);
        assert.ok(!p.startsWith('.git/'), `${archiveName} must not contain .git: ${p}`);
        assert.ok(!p.startsWith('.crew/'), `${archiveName} must not contain .crew: ${p}`);
        assert.ok(!p.startsWith('.clean-room/'), `${archiveName} must not contain .clean-room: ${p}`);
        assert.ok(!p.startsWith('tmp/'), `${archiveName} must not contain tmp: ${p}`);
        assert.ok(!p.startsWith('dist/'), `${archiveName} must not contain dist: ${p}`);
        assert.ok(!p.startsWith('coverage/'), `${archiveName} must not contain coverage: ${p}`);
        assert.ok(!p.startsWith('.agents/'), `${archiveName} must not contain .agents: ${p}`);
        assert.ok(!p.startsWith('node_modules/'), `${archiveName} must not contain node_modules: ${p}`);

        // Sensitive / temporary files
        assert.ok(p !== '.pii-denylist', `${archiveName} must not contain .pii-denylist`);
        assert.ok(!p.endsWith('.lock'), `${archiveName} must not contain .lock file: ${p}`);
        assert.ok(!p.endsWith('.log'), `${archiveName} must not contain .log file: ${p}`);
        assert.ok(!p.endsWith('.tmp'), `${archiveName} must not contain .tmp file: ${p}`);
        assert.ok(!p.endsWith('.DS_Store'), `${archiveName} must not contain .DS_Store: ${p}`);
        assert.ok(!p.endsWith('Thumbs.db'), `${archiveName} must not contain Thumbs.db: ${p}`);
        assert.ok(!p.endsWith('desktop.ini'), `${archiveName} must not contain desktop.ini: ${p}`);
        assert.ok(!p.endsWith('TEST_INFRA.md'), `${archiveName} must not contain TEST_INFRA.md: ${p}`);
        assert.ok(!p.endsWith('TEST_READY.md'), `${archiveName} must not contain TEST_READY.md: ${p}`);
      }
    };

    checkExclusions(result.engine.path, 'Engine Bundle');
    checkExclusions(result.setup.path, 'Setup Bundle');
  } finally {
    fs.rmSync(tmpDist, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// Test 7: Setup Package Isolation Audit
// ----------------------------------------------------------------------------
suite.test('7. Setup Package Isolation: Contains strictly templates, prompts, docs, zero bin/ or lib/', async (assert) => {
  const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-setup-iso-'));
  try {
    const result = buildDistPackages({ workspaceDir: repoRoot, distDir: tmpDist });
    const parsed = parseZipArchive(fs.readFileSync(result.setup.path));
    const paths = parsed.entries.map((e) => e.path);

    for (const p of paths) {
      assert.ok(!p.startsWith('bin/'), `Setup package must NOT contain engine binary: ${p}`);
      assert.ok(!p.startsWith('lib/'), `Setup package must NOT contain engine lib: ${p}`);
      assert.ok(!p.startsWith('scripts/'), `Setup package must NOT contain scripts: ${p}`);
    }

    // Verify presence of expected setup assets
    assert.ok(paths.includes('package.json'), 'Setup package must contain package.json');
    assert.ok(paths.includes('LICENSE'), 'Setup package must contain LICENSE');
    assert.ok(paths.includes('NOTICE'), 'Setup package must contain NOTICE');
    assert.ok(paths.includes('README.md'), 'Setup package must contain README.md');
    assert.ok(paths.includes('.pii-denylist.example'), 'Setup package must contain .pii-denylist.example');
    assert.ok(paths.some((p) => p.startsWith('templates/')), 'Setup package must contain templates/');
    assert.ok(paths.some((p) => p.startsWith('agents/')), 'Setup package must contain agents/');
    assert.ok(paths.some((p) => p.startsWith('skills/')), 'Setup package must contain skills/');
  } finally {
    fs.rmSync(tmpDist, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// Test 8: Adversarial Bait Files Injection Challenge
// ----------------------------------------------------------------------------
suite.test('8. Adversarial Bait Injection: 15 planted malicious/secret bait files are 100% rejected', async (assert) => {
  const mockWs = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-mock-bait-'));
  const mockDist = path.join(mockWs, 'dist');

  try {
    // 1. Create legitimate skeleton
    fs.mkdirSync(path.join(mockWs, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(mockWs, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(mockWs, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(mockWs, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(mockWs, 'skills'), { recursive: true });

    fs.writeFileSync(path.join(mockWs, 'package.json'), JSON.stringify({ name: 'mock-crew', version: '0.1.0' }));
    fs.writeFileSync(path.join(mockWs, 'LICENSE'), 'MIT License');
    fs.writeFileSync(path.join(mockWs, 'NOTICE'), 'Notice file');
    fs.writeFileSync(path.join(mockWs, 'README.md'), '# Mock Crew');
    fs.writeFileSync(path.join(mockWs, '.pii-denylist.example'), 'Alex Rivera');
    fs.writeFileSync(path.join(mockWs, 'bin', 'crew.js'), '#!/usr/bin/env node\nconsole.log("crew");');
    fs.writeFileSync(path.join(mockWs, 'lib', 'core.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(mockWs, 'agents', 'recon.md'), '# Recon');

    // 2. Plant 15 adversarial bait files
    const baitFiles = [
      'tests/unit/test-leak.js',
      '.git/config',
      '.crew/ledger.jsonl',
      '.crew/ledger.lock',
      '.clean-room/violations.json',
      'tmp/dump.dat',
      'dist/stale.zip',
      '.pii-denylist',
      'package.lock',
      'app.log',
      'scratch.tmp',
      '.DS_Store',
      'Thumbs.db',
      '.agents/teamwork/plan.md',
      'coverage/lcov.info'
    ];

    for (const bait of baitFiles) {
      const baitFull = path.join(mockWs, bait);
      fs.mkdirSync(path.dirname(baitFull), { recursive: true });
      fs.writeFileSync(baitFull, `BAIT CONTENT FOR ${bait}`);
    }

    // 3. Build packages
    const res = buildDistPackages({ workspaceDir: mockWs, distDir: mockDist });
    const parsedEngine = parseZipArchive(fs.readFileSync(res.engine.path));
    const parsedSetup = parseZipArchive(fs.readFileSync(res.setup.path));

    const allPaths = new Set([...parsedEngine.entries.map((e) => e.path), ...parsedSetup.entries.map((e) => e.path)]);

    for (const bait of baitFiles) {
      const normalizedBait = bait.replace(/\\/g, '/');
      assert.ok(
        !allPaths.has(normalizedBait),
        `Adversarial bait file ${normalizedBait} MUST be omitted from archives, but was leaked!`
      );
    }

    // Verify legitimate files made it through
    assert.ok(allPaths.has('package.json'), 'package.json must be present');
    assert.ok(allPaths.has('bin/crew.js'), 'bin/crew.js must be present in engine');
    assert.ok(allPaths.has('lib/core.js'), 'lib/core.js must be present in engine');
  } finally {
    fs.rmSync(mockWs, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------------
// Test 9: DeterministicZipArchiver Fuzzing & Internal Stress
// ----------------------------------------------------------------------------
suite.test('9. Archiver Fuzzing: Path normalization, deduplication, reverse order sorting, zero-byte and incompressible data', async (assert) => {
  const archiver = new DeterministicZipArchiver();

  // 1. Path Normalization Fuzzing
  archiver.addFile('\\windows\\style\\path.txt', 'windows');
  archiver.addFile('./dot/slash/path.txt', 'dotslash');
  archiver.addFile('//multiple//slashes///path.txt', 'multislash');

  const paths = archiver.getEntryPaths();
  assert.ok(paths.includes('windows/style/path.txt'), 'Backslashes must be normalized to POSIX forward slashes');
  assert.ok(paths.includes('dot/slash/path.txt'), 'Leading ./ must be purged');
  assert.ok(paths.includes('multiple/slashes/path.txt'), 'Multiple slashes must be collapsed');

  // 2. Overwrite / Deduplication Fuzzing
  archiver.addFile('dup/target.txt', 'Version 1');
  archiver.addFile('dup/target.txt', 'Version 2 (Final)');
  assert.equal(archiver.entries.get('dup/target.txt').buffer.toString('utf8'), 'Version 2 (Final)');

  // 3. Reverse Order Sorting Fuzzing
  const sortArchiver = new DeterministicZipArchiver();
  sortArchiver.addFile('z_last.txt', 'Z');
  sortArchiver.addFile('m_middle.txt', 'M');
  sortArchiver.addFile('a_first.txt', 'A');
  const sortedZipBuf = sortArchiver.build();
  const parsedSorted = parseZipArchive(sortedZipBuf);
  assert.deepEqual(
    parsedSorted.entries.map((e) => e.path),
    ['a_first.txt', 'm_middle.txt', 'z_last.txt'],
    'Archiver must sort entries lexicographically regardless of insertion order'
  );

  // 4. Zero-byte File Handling
  const emptyArchiver = new DeterministicZipArchiver();
  emptyArchiver.addFile('empty.txt', Buffer.alloc(0));
  const emptyZipBuf = emptyArchiver.build();
  const parsedEmpty = parseZipArchive(emptyZipBuf);
  assert.equal(parsedEmpty.entries[0].uncompressedSize, 0, 'Zero-byte file uncompressed size must be 0');
  assert.equal(parsedEmpty.entries[0].crc32, 0, 'Zero-byte file CRC-32 must be 0');
  assert.equal(parsedEmpty.entries[0].decompressed.length, 0, 'Zero-byte file decompressed length must be 0');

  // 5. High-Entropy Incompressible Data (Method 0 STORED Fallback)
  const randomBytes = crypto.randomBytes(4096);
  const randomArchiver = new DeterministicZipArchiver();
  randomArchiver.addFile('random.bin', randomBytes);
  const randomZipBuf = randomArchiver.build();
  const parsedRandom = parseZipArchive(randomZipBuf);
  // High-entropy random data expands under DEFLATE, so archiver should choose STORED (0)
  assert.equal(parsedRandom.entries[0].method, 0, 'Incompressible random bytes must use method 0 (STORED)');
  assert.equal(Buffer.compare(parsedRandom.entries[0].decompressed, randomBytes), 0, 'Random bytes must roundtrip perfectly');
});

// ----------------------------------------------------------------------------
// Test 10: CLI Self-Verification and Command Arguments Matrix
// ----------------------------------------------------------------------------
suite.test('10. CLI Verification: --verify --json flag, --help flag, and custom directory switches exit 0 with valid reports', async (assert) => {
  // 1. CLI --verify --json
  const verifyOutput = execFileSync(process.execPath, [packageDistScript, '--verify', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  const report = JSON.parse(verifyOutput);
  assert.equal(report.pass, true, 'CLI --verify --json report.pass must be true');
  assert.equal(report.engine.match, true, 'CLI --verify --json engine.match must be true');
  assert.equal(report.setup.match, true, 'CLI --verify --json setup.match must be true');
  assert.ok(report.engine.run1Sha256.length === 64, 'Run 1 engine SHA-256 must be 64-char hex string');

  // 2. CLI --help
  const helpOutput = execFileSync(process.execPath, [packageDistScript, '--help'], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.ok(helpOutput.includes('JobHunt Crew — Deterministic Distribution Packager'), 'CLI --help must show usage banner');

  // 3. CLI custom --dist and --json
  const tmpCliDist = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-cli-dist-'));
  try {
    const cliBuildOutput = execFileSync(
      process.execPath,
      [packageDistScript, '--workspace', repoRoot, '--dist', tmpCliDist, '--json'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    const buildReport = JSON.parse(cliBuildOutput);
    assert.equal(buildReport.distDir, tmpCliDist, 'Custom dist directory must be respected');
    assert.ok(fs.existsSync(buildReport.engine.path), 'Custom engine zip must exist');
    assert.ok(fs.existsSync(buildReport.setup.path), 'Custom setup zip must exist');
  } finally {
    fs.rmSync(tmpCliDist, { recursive: true, force: true });
  }

  // 4. Verify Zero External Dependencies in scripts/package-dist.js
  const scriptContent = fs.readFileSync(packageDistScript, 'utf8');
  const requireRegex = /require\(['"]([^'"]+)['"]\)/g;
  let match;
  const importedModules = [];
  while ((match = requireRegex.exec(scriptContent)) !== null) {
    importedModules.push(match[1]);
  }
  const builtIns = new Set(['fs', 'path', 'crypto', 'zlib', 'os', 'child_process']);
  for (const mod of importedModules) {
    assert.ok(builtIns.has(mod), `package-dist.js must only import Node built-ins, but found: ${mod}`);
  }
});

// ----------------------------------------------------------------------------
// Test 11: Concurrent Multi-Process Packaging Stress
// ----------------------------------------------------------------------------
suite.test('11. Concurrency Stress: 6 concurrent child processes building in parallel yield identical SHA-256 digests', async (assert) => {
  const NUM_CONCURRENT = 6;
  const tempDirs = [];
  const { fork } = require('child_process');

  try {
    for (let i = 0; i < NUM_CONCURRENT; i++) {
      tempDirs.push(fs.mkdtempSync(path.join(os.tmpdir(), `crew-conc-run-${i}-`)));
    }

    // Launch all processes simultaneously
    const runProcess = (distDir) => {
      return new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        execFile(
          process.execPath,
          [packageDistScript, '--workspace', repoRoot, '--dist', distDir, '--json'],
          { cwd: repoRoot, encoding: 'utf8' },
          (err, stdout, stderr) => {
            if (err) return reject(new Error(`Process failed: ${err.message}\n${stderr}`));
            try {
              resolve(JSON.parse(stdout));
            } catch (parseErr) {
              reject(new Error(`Failed to parse JSON output: ${parseErr.message}\nRaw: ${stdout}`));
            }
          }
        );
      });
    };

    const results = await Promise.all(tempDirs.map((d) => runProcess(d)));

    assert.equal(results.length, NUM_CONCURRENT, `All ${NUM_CONCURRENT} concurrent processes must complete`);

    const baselineEngineSha = results[0].engine.sha256;
    const baselineSetupSha = results[0].setup.sha256;

    for (let i = 1; i < NUM_CONCURRENT; i++) {
      assert.equal(
        results[i].engine.sha256,
        baselineEngineSha,
        `Concurrent run ${i} engine SHA-256 must match run 0 baseline`
      );
      assert.equal(
        results[i].setup.sha256,
        baselineSetupSha,
        `Concurrent run ${i} setup SHA-256 must match run 0 baseline`
      );
      assert.equal(
        results[i].engine.sizeBytes,
        results[0].engine.sizeBytes,
        `Concurrent run ${i} engine size must match run 0 baseline`
      );
      assert.equal(
        results[i].setup.sizeBytes,
        results[0].setup.sizeBytes,
        `Concurrent run ${i} setup size must match run 0 baseline`
      );
    }
  } finally {
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (_) {}
    }
  }
});

// ----------------------------------------------------------------------------
// Test 12: Disk Extraction Roundtrip & Directory Diff
// ----------------------------------------------------------------------------
suite.test('12. Extraction Roundtrip: Extracting zip to clean disk directory preserves 100% byte fidelity for all files', async (assert) => {
  const tmpDist = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-extract-dist-'));
  const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-extracted-'));

  try {
    const result = buildDistPackages({ workspaceDir: repoRoot, distDir: tmpDist });
    const parsed = parseZipArchive(fs.readFileSync(result.engine.path));

    // Extract all entries to disk
    for (const entry of parsed.entries) {
      const targetFilePath = path.join(tmpExtract, entry.path);
      fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
      fs.writeFileSync(targetFilePath, entry.decompressed, { mode: entry.mode });
    }

    // Compare extracted files with repo files
    for (const entry of parsed.entries) {
      const extractedPath = path.join(tmpExtract, entry.path);
      const sourcePath = path.join(repoRoot, entry.path);

      assert.ok(fs.existsSync(extractedPath), `Extracted file must exist on disk: ${entry.path}`);
      assert.ok(fs.existsSync(sourcePath), `Source repo file must exist: ${entry.path}`);

      const extractedBytes = fs.readFileSync(extractedPath);
      const sourceBytes = fs.readFileSync(sourcePath);

      assert.equal(
        Buffer.compare(extractedBytes, sourceBytes),
        0,
        `Disk extracted file ${entry.path} must be identical to source repo file`
      );
    }
  } finally {
    fs.rmSync(tmpDist, { recursive: true, force: true });
    fs.rmSync(tmpExtract, { recursive: true, force: true });
  }
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true });
}

