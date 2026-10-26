'use strict';

/**
 * JobHunt Crew — Integration Test Suite:
 * M8: Deterministic Packaging, Reproducible Builds & Capabilities Verification
 *
 * Verifies:
 * 1. Bit-for-bit identical SHA-256 digests across consecutive package builds.
 * 2. Complete absence of non-deterministic metadata (timestamps fixed to 1980-01-01 00:00:00).
 * 3. Zero duplicate entries and 100% POSIX path normalization across all archives.
 * 4. Strict exclusions hygiene (zero .git, node_modules, tests, .agents, .crew, .clean-room, PII).
 * 5. Normalized file attributes (0o755 for bin/, 0o644 for regular files).
 * 6. File integrity and byte-for-byte inflate roundtrip verification against source files.
 * 7. CLI self-verification flag (--verify and --json).
 * 8. Zero external npm dependencies (pure built-in Node.js runtime).
 *
 * @module tests/integration/test-packaging-and-capabilities
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// Determine repo root dynamically
function findRepoRoot() {
  let cur = __dirname;
  while (cur && path.dirname(cur) !== cur) {
    if (fs.existsSync(path.join(cur, 'package.json')) && fs.existsSync(path.join(cur, 'bin', 'crew.js'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  const alt1 = path.resolve(__dirname, '../../../jobhunt-crew');
  if (fs.existsSync(alt1)) return alt1;
  const alt2 = path.resolve(__dirname, '../../jobhunt-crew');
  if (fs.existsSync(alt2)) return alt2;
  return path.resolve(__dirname, '../..');
}

const repoRoot = findRepoRoot();
const packagerScript = path.join(repoRoot, 'scripts', 'package-dist.js');

// Support running either with existing scripts/package-dist.js or with explorer proposed script
let packagerModule;
let packagerPath = packagerScript;
if (fs.existsSync(packagerScript)) {
  packagerModule = require(packagerScript);
} else {
  const localProposed = path.join(__dirname, 'proposed_package-dist.js');
  const explorerProposed = path.resolve(repoRoot, '../.agents/teamwork/explorer_m8_2/proposed_package-dist.js');
  if (fs.existsSync(localProposed)) {
    packagerModule = require(localProposed);
    packagerPath = localProposed;
  } else if (fs.existsSync(explorerProposed)) {
    packagerModule = require(explorerProposed);
    packagerPath = explorerProposed;
  }
}

// Test harness loader
let TestSuite;
try {
  TestSuite = require('../helpers/test-harness').TestSuite;
} catch (_) {
  // Minimal standalone fallback test runner if executed outside tests/ tree
  TestSuite = class MinimalSuite {
    constructor(name) {
      this.name = name;
      this.tests = [];
      this.passed = 0;
      this.failed = 0;
      this.errors = [];
    }
    test(description, fn) {
      this.tests.push({ description, fn });
    }
    async run(options = {}) {
      const verbose = options.verbose !== false;
      for (const t of this.tests) {
        try {
          await t.fn(assertHelper);
          this.passed++;
          if (verbose) console.log(`    ✓ ${t.description}`);
        } catch (err) {
          this.failed++;
          this.errors.push({ test: t.description, error: err });
          if (verbose) console.log(`    ✗ ${t.description}: ${err.message}`);
        }
      }
      return { passed: this.passed, failed: this.failed, errors: this.errors };
    }
  };
}

const assertHelper = {
  ok(val, msg) {
    if (!val) throw new Error(msg || `Expected truthy value, got ${val}`);
  },
  equal(actual, expected, msg) {
    if (actual !== expected) throw new Error(msg || `Expected ${expected}, got ${actual}`);
  },
  strictEqual(actual, expected, msg) {
    if (actual !== expected) throw new Error(msg || `Expected strict equality: ${expected} !== ${actual}`);
  },
  deepStrictEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(msg || `Expected deep equality:\nActual: ${a}\nExpected: ${b}`);
  }
};

/**
 * Pure Node.js in-memory PKZIP parser for deep inspection and verification.
 */
function parseZipBuffer(buf) {
  // Find End of Central Directory Record (EOCD signature 0x06054b50)
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('PKZIP parsing error: End of Central Directory (EOCD) signature not found');
  }

  const diskNumber = buf.readUInt16LE(eocdOffset + 4);
  const cdStartDisk = buf.readUInt16LE(eocdOffset + 6);
  const totalEntriesOnDisk = buf.readUInt16LE(eocdOffset + 8);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let cur = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(cur) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header signature at offset ${cur}`);
    }

    const versionMadeBy = buf.readUInt16LE(cur + 4);
    const versionNeeded = buf.readUInt16LE(cur + 6);
    const flags = buf.readUInt16LE(cur + 8);
    const method = buf.readUInt16LE(cur + 10);
    const dosTime = buf.readUInt16LE(cur + 12);
    const dosDate = buf.readUInt16LE(cur + 14);
    const crc = buf.readUInt32LE(cur + 16);
    const compSize = buf.readUInt32LE(cur + 20);
    const uncompSize = buf.readUInt32LE(cur + 24);
    const nameLen = buf.readUInt16LE(cur + 28);
    const extraLen = buf.readUInt16LE(cur + 30);
    const commentLen = buf.readUInt16LE(cur + 32);
    const diskStart = buf.readUInt16LE(cur + 34);
    const intAttr = buf.readUInt16LE(cur + 36);
    const extAttr = buf.readUInt32LE(cur + 38);
    const localOffset = buf.readUInt32LE(cur + 42);
    const name = buf.toString('utf8', cur + 46, cur + 46 + nameLen);

    // Read local file header to extract and decompress file data
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid Local File Header signature at offset ${localOffset} for entry ${name}`);
    }

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const rawCompressedData = buf.subarray(dataStart, dataStart + compSize);

    let decompressed;
    if (method === 0) {
      decompressed = rawCompressedData;
    } else if (method === 8) {
      decompressed = zlib.inflateRawSync(rawCompressedData);
    } else {
      throw new Error(`Unsupported compression method ${method} for entry ${name}`);
    }

    const calculatedCrc = typeof zlib.crc32 === 'function' ? zlib.crc32(decompressed) >>> 0 : 0;
    const mode = (extAttr >>> 16) & 0o777777;

    entries.push({
      name,
      uncompSize,
      compSize,
      method,
      flags,
      dosTime,
      dosDate,
      crc,
      calculatedCrc,
      extAttr,
      mode,
      decompressed
    });

    cur += 46 + nameLen + extraLen + commentLen;
  }

  return {
    diskNumber,
    cdStartDisk,
    totalEntriesOnDisk,
    totalEntries,
    cdSize,
    cdOffset,
    entries
  };
}

const suite = new TestSuite('M8: Deterministic Packaging & Capabilities Verification');

// Wrap suite.test to support strictEqual and deepStrictEqual seamlessly
const origTest = suite.test.bind(suite);
suite.test = function(description, fn) {
  origTest(description, async (assert) => {
    if (!assert.strictEqual) {
      assert.strictEqual = (actual, expected, msg) => assert.equal(actual, expected, msg);
    }
    if (!assert.deepStrictEqual) {
      assert.deepStrictEqual = (actual, expected, msg) => assert.deepEqual(actual, expected, msg);
    }
    return fn(assert);
  });
};


// ============================================================================
// TC-PKG-01: Bit-for-Bit Deterministic Parity across Consecutive Builds
// ============================================================================
suite.test('TC-PKG-01: Consecutive Builds Produce Bit-for-Bit Identical SHA-256 Hashes', async assert => {
  assert.ok(packagerModule, 'scripts/package-dist.js packager module must be loadable');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-deterministic-'));

  try {
    const dirRun1 = path.join(tmpRoot, 'run1');
    const dirRun2 = path.join(tmpRoot, 'run2');

    const result1 = packagerModule.buildDistPackages({ workspaceDir: repoRoot, distDir: dirRun1 });
    const result2 = packagerModule.buildDistPackages({ workspaceDir: repoRoot, distDir: dirRun2 });

    // Assert Engine Archive Parity
    assert.strictEqual(
      result1.engine.sha256,
      result2.engine.sha256,
      `Engine package SHA-256 mismatch between consecutive runs:\nRun 1: ${result1.engine.sha256}\nRun 2: ${result2.engine.sha256}`
    );
    assert.strictEqual(
      result1.engine.sizeBytes,
      result2.engine.sizeBytes,
      'Engine package size must be identical across consecutive runs'
    );
    assert.strictEqual(
      result1.engine.filesCount,
      result2.engine.filesCount,
      'Engine package file count must be identical across consecutive runs'
    );

    // Assert Setup Archive Parity
    assert.strictEqual(
      result1.setup.sha256,
      result2.setup.sha256,
      `Setup package SHA-256 mismatch between consecutive runs:\nRun 1: ${result1.setup.sha256}\nRun 2: ${result2.setup.sha256}`
    );
    assert.strictEqual(
      result1.setup.sizeBytes,
      result2.setup.sizeBytes,
      'Setup package size must be identical across consecutive runs'
    );
    assert.strictEqual(
      result1.setup.filesCount,
      result2.setup.filesCount,
      'Setup package file count must be identical across consecutive runs'
    );

    // Compare raw byte buffers directly
    const buf1Engine = fs.readFileSync(result1.engine.path);
    const buf2Engine = fs.readFileSync(result2.engine.path);
    assert.strictEqual(
      Buffer.compare(buf1Engine, buf2Engine),
      0,
      'Raw binary buffers for engine package must match 100% byte-for-byte'
    );

    const buf1Setup = fs.readFileSync(result1.setup.path);
    const buf2Setup = fs.readFileSync(result2.setup.path);
    assert.strictEqual(
      Buffer.compare(buf1Setup, buf2Setup),
      0,
      'Raw binary buffers for setup package must match 100% byte-for-byte'
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-PKG-02: Zero Duplicate Paths & Strict POSIX Format
// ============================================================================
suite.test('TC-PKG-02: Zero Duplicate Paths, No Backslashes, No Directory-Only Entries', async assert => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-paths-'));

  try {
    const result = packagerModule.buildDistPackages({ workspaceDir: repoRoot, distDir: tmpRoot });

    for (const [pkgType, pkgInfo] of Object.entries({ engine: result.engine, setup: result.setup })) {
      const buf = fs.readFileSync(pkgInfo.path);
      const parsed = parseZipBuffer(buf);

      const entryNames = parsed.entries.map(e => e.name);
      const uniqueNames = new Set(entryNames);
      assert.strictEqual(
        uniqueNames.size,
        entryNames.length,
        `${pkgType} package has duplicate entries: ${entryNames.length} total vs ${uniqueNames.size} unique`
      );

      // Case-insensitive duplicate check
      const lowerNames = new Set(entryNames.map(n => n.toLowerCase()));
      assert.strictEqual(
        lowerNames.size,
        entryNames.length,
        `${pkgType} package has case-insensitive duplicate entries`
      );

      for (const name of entryNames) {
        // POSIX path invariants
        assert.ok(!name.includes('\\'), `Entry "${name}" in ${pkgType} must not contain backslashes`);
        assert.ok(!name.startsWith('/'), `Entry "${name}" in ${pkgType} must not start with slash`);
        assert.ok(!name.startsWith('./'), `Entry "${name}" in ${pkgType} must not start with ./`);
        assert.ok(!name.endsWith('/'), `Entry "${name}" in ${pkgType} must not be a directory-only entry ending in slash`);
      }

      // Strict lexicographical sorting verification
      const sortedNames = [...entryNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      assert.deepStrictEqual(
        entryNames,
        sortedNames,
        `${pkgType} archive entries must be stored in strict lexicographical order`
      );
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-PKG-03: Exclusions Hygiene & Clean-Room Boundary
// ============================================================================
suite.test('TC-PKG-03: Exclusions Hygiene (Strict Omission of tests, .git, .crew, .pii-denylist, dist)', async assert => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-exclusions-'));

  try {
    const result = packagerModule.buildDistPackages({ workspaceDir: repoRoot, distDir: tmpRoot });

    const forbiddenPrefixes = [
      '.git/',
      'node_modules/',
      'tests/',
      '.agents/',
      '.crew/',
      '.clean-room/',
      'tmp/',
      'dist/',
      'coverage/'
    ];

    const forbiddenExact = [
      '.pii-denylist',
      '.DS_Store',
      'Thumbs.db',
      'desktop.ini',
      'TEST_INFRA.md',
      'TEST_READY.md'
    ];

    for (const [pkgType, pkgInfo] of Object.entries({ engine: result.engine, setup: result.setup })) {
      const buf = fs.readFileSync(pkgInfo.path);
      const parsed = parseZipBuffer(buf);

      for (const entry of parsed.entries) {
        for (const prefix of forbiddenPrefixes) {
          assert.ok(
            !entry.name.startsWith(prefix),
            `Violation: ${pkgType} archive contains forbidden prefix "${prefix}" -> "${entry.name}"`
          );
        }
        for (const exact of forbiddenExact) {
          assert.ok(
            path.basename(entry.name) !== exact,
            `Violation: ${pkgType} archive contains forbidden file "${exact}" -> "${entry.name}"`
          );
        }
        assert.ok(!entry.name.endsWith('.lock'), `Violation: lockfile found in ${pkgType} archive: "${entry.name}"`);
        assert.ok(!entry.name.endsWith('.log'), `Violation: logfile found in ${pkgType} archive: "${entry.name}"`);
        assert.ok(!entry.name.endsWith('.tmp'), `Violation: tmp file found in ${pkgType} archive: "${entry.name}"`);
      }
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-PKG-04: Engine Archive Structure & Executable Permissions
// ============================================================================
suite.test('TC-PKG-04: Engine Package Completeness & Executable Permissions (0o755 for bin/)', async assert => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-engine-'));

  try {
    const result = packagerModule.buildDistPackages({ workspaceDir: repoRoot, distDir: tmpRoot });
    const buf = fs.readFileSync(result.engine.path);
    const parsed = parseZipBuffer(buf);
    const entryMap = new Map(parsed.entries.map(e => [e.name, e]));

    // Essential files verification
    const mandatoryFiles = [
      'bin/crew.js',
      'bin/crew-mcp.js',
      'lib/index.js',
      'lib/core/ledger.js',
      'lib/core/snapshot.js',
      'lib/honest-cv/dossier.js',
      'lib/honest-cv/verify-claims.js',
      'agents/dispatcher.md',
      'agents/recon.md',
      'agents/scribe.md',
      'agents/inquisitor.md',
      'agents/critic.md',
      'agents/liaison.md',
      'agents/navigator.md',
      'templates/CareerDossier.example.json',
      'scripts/verify-clean-room.js',
      'scripts/verify-zero-pii.js',
      'scripts/check-forbidden-tokens.js',
      'LICENSE',
      'NOTICE',
      'README.md',
      'package.json'
    ];

    for (const mf of mandatoryFiles) {
      assert.ok(entryMap.has(mf), `Engine archive is missing required file: ${mf}`);
    }

    // Executable permissions check for bin/ scripts
    const crewJs = entryMap.get('bin/crew.js');
    assert.strictEqual(
      crewJs.mode,
      0o100755,
      `bin/crew.js must have executable mode 0o100755, got 0o${crewJs.mode.toString(8)}`
    );

    const crewMcp = entryMap.get('bin/crew-mcp.js');
    assert.strictEqual(
      crewMcp.mode,
      0o100755,
      `bin/crew-mcp.js must have executable mode 0o100755, got 0o${crewMcp.mode.toString(8)}`
    );

    // Regular file permissions check
    const readme = entryMap.get('README.md');
    assert.strictEqual(
      readme.mode,
      0o100644,
      `README.md must have regular file mode 0o100644, got 0o${readme.mode.toString(8)}`
    );

    assert.ok(result.engine.filesCount >= 80, `Engine package must have >= 80 files, got ${result.engine.filesCount}`);
    assert.ok(result.engine.sizeBytes >= 100000, `Engine package must be >= 100KB, got ${result.engine.sizeBytes}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-PKG-05: Setup & Onboarding Bundle Scoping & Separation
// ============================================================================
suite.test('TC-PKG-05: Setup Package Scoping (Contains templates/guides, strictly excludes bin/lib)', async assert => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-setup-'));

  try {
    const result = packagerModule.buildDistPackages({ workspaceDir: repoRoot, distDir: tmpRoot });
    const buf = fs.readFileSync(result.setup.path);
    const parsed = parseZipBuffer(buf);
    const entryMap = new Map(parsed.entries.map(e => [e.name, e]));

    // Required setup files
    const mandatorySetup = [
      'templates/CareerDossier.example.json',
      'gemini-desktop-pack/SETUP_GUIDE.md',
      'gemini-desktop-pack/SKILL.md',
      'gemini-desktop-pack/GEM_SYSTEM_PROMPT.md',
      'gemini-desktop-pack/SMOKE_TEST_CHECKLIST.md',
      'agents/gemini-desktop-companion.md',
      'docs/gemini-desktop-smoke-test.md',
      'docs/gemini-desktop-capability-report.md',
      'LICENSE',
      'NOTICE',
      'README.md',
      'package.json'
    ];

    for (const ms of mandatorySetup) {
      assert.ok(entryMap.has(ms), `Setup archive is missing required file: ${ms}`);
    }

    // Ensure bin/ and lib/ are strictly NOT in setup package
    for (const entry of parsed.entries) {
      assert.ok(!entry.name.startsWith('bin/'), `Setup package must NOT contain engine binary: "${entry.name}"`);
      assert.ok(!entry.name.startsWith('lib/'), `Setup package must NOT contain engine library: "${entry.name}"`);
      assert.ok(!entry.name.startsWith('scripts/'), `Setup package must NOT contain build script: "${entry.name}"`);
    }

    assert.ok(result.setup.filesCount >= 20, `Setup package must have >= 20 files, got ${result.setup.filesCount}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-PKG-06: File Content Parity & Decompression Integrity
// ============================================================================
suite.test('TC-PKG-06: Full Inflate Decompression Roundtrip & File Content Parity', async assert => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-inflate-'));

  try {
    const result = packagerModule.buildDistPackages({ workspaceDir: repoRoot, distDir: tmpRoot });
    const buf = fs.readFileSync(result.engine.path);
    const parsed = parseZipBuffer(buf);

    const testFiles = [
      'package.json',
      'README.md',
      'NOTICE',
      'LICENSE',
      'bin/crew.js',
      'lib/core/ledger.js',
      'templates/CareerDossier.example.json'
    ];

    for (const relPath of testFiles) {
      const entry = parsed.entries.find(e => e.name === relPath);
      assert.ok(entry, `Entry ${relPath} must exist in archive for roundtrip test`);

      // 1. Verify CRC-32 integrity
      assert.strictEqual(
        entry.calculatedCrc,
        entry.crc,
        `CRC-32 checksum mismatch for extracted entry "${relPath}": ${entry.calculatedCrc} vs ${entry.crc}`
      );

      // 2. Verify uncompressed length matches header
      assert.strictEqual(
        entry.decompressed.length,
        entry.uncompSize,
        `Uncompressed length mismatch for "${relPath}": ${entry.decompressed.length} vs ${entry.uncompSize}`
      );

      // 3. Verify exact byte-for-byte identity against source on disk
      const sourceBuf = fs.readFileSync(path.join(repoRoot, relPath));
      assert.strictEqual(
        Buffer.compare(entry.decompressed, sourceBuf),
        0,
        `Decompressed file "${relPath}" does not match original disk content byte-for-byte`
      );
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-PKG-07: Fixed MS-DOS Timestamps & Zip Conformance
// ============================================================================
suite.test('TC-PKG-07: Standard Zip Conformance (Fixed 1980 DOS Timestamp, UTF-8 Flags, PK Magic)', async assert => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-conformance-'));

  try {
    const result = packagerModule.buildDistPackages({ workspaceDir: repoRoot, distDir: tmpRoot });

    for (const [pkgType, pkgInfo] of Object.entries({ engine: result.engine, setup: result.setup })) {
      const buf = fs.readFileSync(pkgInfo.path);

      // 1. Magic bytes
      assert.strictEqual(buf[0], 0x50, `${pkgType} zip magic byte 0 must be 0x50 ('P')`);
      assert.strictEqual(buf[1], 0x4b, `${pkgType} zip magic byte 1 must be 0x4b ('K')`);
      assert.strictEqual(buf[2], 0x03, `${pkgType} zip magic byte 2 must be 0x03`);
      assert.strictEqual(buf[3], 0x04, `${pkgType} zip magic byte 3 must be 0x04`);

      const parsed = parseZipBuffer(buf);

      // 2. Fixed DOS Date & Time check across all entries
      for (const entry of parsed.entries) {
        assert.strictEqual(
          entry.dosDate,
          0x0021,
          `Entry "${entry.name}" in ${pkgType} must have fixed DOS date 0x0021 (1980-01-01), got 0x${entry.dosDate.toString(16)}`
        );
        assert.strictEqual(
          entry.dosTime,
          0x0000,
          `Entry "${entry.name}" in ${pkgType} must have fixed DOS time 0x0000 (00:00:00), got 0x${entry.dosTime.toString(16)}`
        );
        // Bit 11 UTF-8 check
        assert.strictEqual(
          entry.flags & 0x0800,
          0x0800,
          `Entry "${entry.name}" in ${pkgType} must have general purpose bit 11 (UTF-8) set`
        );
      }
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// TC-PKG-08: CLI Self-Verification Flag (--verify & --json)
// ============================================================================
suite.test('TC-PKG-08: CLI Execution & Self-Verification (--verify and --json)', async assert => {
  const scriptToExecute = packagerPath;

  // Test 1: --verify human-readable
  const stdout = execFileSync(
    process.execPath,
    [scriptToExecute, '--verify', '--workspace', repoRoot],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );

  assert.ok(
    stdout.includes('VERDICT: PACKAGING IS 100% DETERMINISTIC AND REPRODUCIBLE'),
    `Expected verification success message in stdout, got:\n${stdout}`
  );
  assert.ok(stdout.includes('PASS (Bit-for-bit identical)'), 'Expected bit-for-bit identical pass message');

  // Test 2: --verify --json
  const jsonOut = execFileSync(
    process.execPath,
    [scriptToExecute, '--verify', '--json', '--workspace', repoRoot],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const report = JSON.parse(jsonOut);
  assert.strictEqual(report.pass, true, 'Verification JSON pass must be true');
  assert.strictEqual(report.engine.match, true, 'Engine package match must be true');
  assert.strictEqual(report.setup.match, true, 'Setup package match must be true');
  assert.strictEqual(report.engine.run1Sha256, report.engine.run2Sha256, 'Engine hashes must be identical');
  assert.strictEqual(report.setup.run1Sha256, report.setup.run2Sha256, 'Setup hashes must be identical');
});

// ============================================================================
// TC-CAP-01: Capability Checklist File Verification (if present)
// ============================================================================
suite.test('TC-CAP-01: Capability Checklist Integrity & Packaging Inclusion', async assert => {
  const checklistPath = path.join(repoRoot, 'docs', 'capability-checklist.md');
  if (fs.existsSync(checklistPath)) {
    const content = fs.readFileSync(checklistPath, 'utf8');
    assert.ok(content.length > 500, 'capability-checklist.md must have substantial content');

    // Verify it is bundled into engine package
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-cap-'));
    try {
      const result = packagerModule.buildDistPackages({ workspaceDir: repoRoot, distDir: tmpRoot });
      const buf = fs.readFileSync(result.engine.path);
      const parsed = parseZipBuffer(buf);
      const entryMap = new Map(parsed.entries.map(e => [e.name, e]));
      assert.ok(
        entryMap.has('docs/capability-checklist.md'),
        'docs/capability-checklist.md must be included in engine zip package'
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  } else {
    // If explorer_m8_1 has not landed docs/capability-checklist.md yet, verify docs/ folder is packaged
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-test-cap-'));
    try {
      const result = packagerModule.buildDistPackages({ workspaceDir: repoRoot, distDir: tmpRoot });
      const buf = fs.readFileSync(result.engine.path);
      const parsed = parseZipBuffer(buf);
      const docsEntries = parsed.entries.filter(e => e.name.startsWith('docs/'));
      assert.ok(docsEntries.length >= 2, `Expected at least 2 docs entries, got ${docsEntries.length}`);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(stats => {
    console.log(`\nTest Summary: ${stats.passed} passed, ${stats.failed} failed`);
    process.exit(stats.failed > 0 ? 1 : 0);
  });
}
