#!/usr/bin/env node
'use strict';

/**
 * JobHunt Crew — Deterministic Packaging & Reproducible Distribution Builder
 *
 * Compiles standalone, bit-for-bit reproducible PKZIP distribution packages
 * using 100% pure Node.js built-in modules (fs, path, crypto, zlib).
 *
 * Invariants & Guarantees:
 * 1. Zero external npm dependencies.
 * 2. Deterministic PKZIP 2.0 archives with fixed MS-DOS date/time (1980-01-01 00:00:00).
 * 3. Strict lexicographical sorting of entry paths (POSIX forward slashes).
 * 4. Normalized file permissions (0o755 for executables in bin/, 0o644 for regular files).
 * 5. Zero extra timestamps or OS-specific extended metadata headers.
 * 6. Zero duplicate paths and zero directory-only entries.
 * 7. Mathematical proof of determinism: consecutive builds yield identical SHA-256 digests.
 *
 * Usage:
 *   node scripts/package-dist.js [--workspace <dir>] [--dist <dir>] [--verify] [--json]
 *
 * @module scripts/package-dist
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// Canonical constants for MS-DOS timestamping (1980-01-01 00:00:00)
// DOS Date: (year - 1980) << 9 | (month << 5) | day -> (0 << 9) | (1 << 5) | 1 = 0x0021 (33)
// DOS Time: (hour << 11) | (minute << 5) | (second / 2) -> 0x0000 (0)
const DOS_DATE_CONSTANT = 0x0021;
const DOS_TIME_CONSTANT = 0x0000;

// POSIX normalized modes
const MODE_REGULAR_FILE = 0o100644; // -rw-r--r--
const MODE_EXECUTABLE   = 0o100755; // -rwxr-xr-x

// General Purpose Bit Flag: Bit 11 set indicates UTF-8 encoded filename/comment
const FLAG_UTF8 = 0x0800;

/**
 * Pure Node.js In-Memory Deterministic PKZIP 2.0 Archiver
 */
class DeterministicZipArchiver {
  /**
   * @param {Object} [options]
   * @param {number} [options.dosDate] Fixed DOS date (defaults to 1980-01-01)
   * @param {number} [options.dosTime] Fixed DOS time (defaults to 00:00:00)
   * @param {number} [options.compressionLevel] zlib deflate level (defaults to 9)
   */
  constructor(options = {}) {
    this.dosDate = options.dosDate !== undefined ? options.dosDate : DOS_DATE_CONSTANT;
    this.dosTime = options.dosTime !== undefined ? options.dosTime : DOS_TIME_CONSTANT;
    this.compressionLevel = options.compressionLevel !== undefined ? options.compressionLevel : 9;
    this.entries = new Map();
  }

  /**
   * Normalizes an archive path to standard POSIX format.
   * Purges backslashes, leading './', leading slashes, and trailing slashes.
   * @param {string} rawPath
   * @returns {string}
   */
  static normalizePath(rawPath) {
    if (typeof rawPath !== 'string') return '';
    let p = rawPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    while (p.includes('//')) {
      p = p.replace('//', '/');
    }
    return p.replace(/\/+$/, '');
  }

  /**
   * Computes IEEE 802.3 32-bit CRC.
   * @param {Buffer} buffer
   * @returns {number} Unsigned 32-bit integer
   */
  static crc32(buffer) {
    if (typeof zlib.crc32 === 'function') {
      return zlib.crc32(buffer) >>> 0;
    }
    // Fallback CRC-32 table
    let crc = ~0;
    for (let i = 0; i < buffer.length; i++) {
      crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ buffer[i]) & 0xff];
    }
    return (crc ^ ~0) >>> 0;
  }

  /**
   * Adds a file entry to the archive.
   * Replaces any existing entry with the same path, ensuring zero duplicate entries.
   *
   * @param {string} archivePath Relative path inside the zip archive
   * @param {Buffer|string} content File contents
   * @param {Object} [options]
   * @param {boolean} [options.isExecutable] Whether the file is executable
   * @param {number} [options.mode] Explicit POSIX file mode
   */
  addFile(archivePath, content, options = {}) {
    const cleanPath = DeterministicZipArchiver.normalizePath(archivePath);
    if (!cleanPath) return;

    const rawBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const isExec = options.isExecutable !== undefined
      ? options.isExecutable
      : (cleanPath.startsWith('bin/') || cleanPath.endsWith('.sh') || cleanPath.endsWith('.js') && rawBuffer.slice(0, 2).toString() === '#!');

    const mode = options.mode !== undefined
      ? options.mode
      : (isExec ? MODE_EXECUTABLE : MODE_REGULAR_FILE);

    this.entries.set(cleanPath, {
      path: cleanPath,
      buffer: rawBuffer,
      mode
    });
  }

  /**
   * Returns list of sorted entry paths currently registered.
   * @returns {string[]}
   */
  getEntryPaths() {
    return Array.from(this.entries.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /**
   * Compiles the deterministic PKZIP binary buffer.
   * @returns {Buffer}
   */
  build() {
    // 1. Strict byte-by-byte lexicographical sorting of all entry paths
    const sortedPaths = this.getEntryPaths();

    const localChunks = [];
    const centralChunks = [];
    let currentOffset = 0;

    for (const entryPath of sortedPaths) {
      const entry = this.entries.get(entryPath);
      const nameBuf = Buffer.from(entry.path, 'utf8');
      const rawBuf = entry.buffer;
      const crc = DeterministicZipArchiver.crc32(rawBuf);

      // Raw DEFLATE compression (no zlib or gzip envelope)
      let compressed = zlib.deflateRawSync(rawBuf, { level: this.compressionLevel });
      let method = 8; // DEFLATE

      // If compressed size is not smaller than raw size, store uncompressed
      if (compressed.length >= rawBuf.length) {
        compressed = rawBuf;
        method = 0; // STORED
      }

      // ----------------------------------------------------------------------
      // Local File Header (30 bytes + nameBuf.length + compressed.length)
      // ----------------------------------------------------------------------
      const lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);       // Signature: PK\x03\x04
      lfh.writeUInt16LE(20, 4);               // Version needed to extract: 2.0
      lfh.writeUInt16LE(FLAG_UTF8, 6);        // General purpose bit flag (UTF-8)
      lfh.writeUInt16LE(method, 8);           // Compression method (0 or 8)
      lfh.writeUInt16LE(this.dosTime, 10);    // Last mod file time (constant)
      lfh.writeUInt16LE(this.dosDate, 12);    // Last mod file date (constant)
      lfh.writeUInt32LE(crc, 14);             // CRC-32
      lfh.writeUInt32LE(compressed.length, 18);// Compressed size
      lfh.writeUInt32LE(rawBuf.length, 22);   // Uncompressed size
      lfh.writeUInt16LE(nameBuf.length, 26);  // File name length
      lfh.writeUInt16LE(0, 28);               // Extra field length (0: strictly zero extra headers)

      localChunks.push(lfh, nameBuf, compressed);

      // ----------------------------------------------------------------------
      // Central Directory File Header (46 bytes + nameBuf.length)
      // ----------------------------------------------------------------------
      const cdfh = Buffer.alloc(46);
      cdfh.writeUInt32LE(0x02014b50, 0);              // Signature: PK\x01\x02
      cdfh.writeUInt16LE((3 << 8) | 20, 4);           // Version made by: UNIX (3), Zip 2.0 (20)
      cdfh.writeUInt16LE(20, 6);                      // Version needed to extract: 2.0
      cdfh.writeUInt16LE(FLAG_UTF8, 8);               // General purpose bit flag (UTF-8)
      cdfh.writeUInt16LE(method, 10);                 // Compression method
      cdfh.writeUInt16LE(this.dosTime, 12);           // Last mod file time (constant)
      cdfh.writeUInt16LE(this.dosDate, 14);           // Last mod file date (constant)
      cdfh.writeUInt32LE(crc, 16);                    // CRC-32
      cdfh.writeUInt32LE(compressed.length, 20);      // Compressed size
      cdfh.writeUInt32LE(rawBuf.length, 24);          // Uncompressed size
      cdfh.writeUInt16LE(nameBuf.length, 28);         // File name length
      cdfh.writeUInt16LE(0, 30);                      // Extra field length (0)
      cdfh.writeUInt16LE(0, 32);                      // File comment length (0)
      cdfh.writeUInt16LE(0, 34);                      // Disk number start (0)
      cdfh.writeUInt16LE(0, 36);                      // Internal file attributes (0)
      // External file attributes: High 16 bits hold POSIX permissions; unsigned 32-bit shift
      cdfh.writeUInt32LE((entry.mode << 16) >>> 0, 38);
      cdfh.writeUInt32LE(currentOffset, 42);          // Relative offset of local header

      centralChunks.push(cdfh, nameBuf);

      currentOffset += 30 + nameBuf.length + compressed.length;
    }

    const centralDirectoryOffset = currentOffset;
    let centralDirectorySize = 0;
    for (const chunk of centralChunks) {
      centralDirectorySize += chunk.length;
    }

    // ------------------------------------------------------------------------
    // End of Central Directory Record (22 bytes)
    // ------------------------------------------------------------------------
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);            // Signature: PK\x05\x06
    eocd.writeUInt16LE(0, 4);                     // Number of this disk (0)
    eocd.writeUInt16LE(0, 6);                     // Disk where central directory starts (0)
    eocd.writeUInt16LE(sortedPaths.length, 8);    // Entries on this disk
    eocd.writeUInt16LE(sortedPaths.length, 10);   // Total entries
    eocd.writeUInt32LE(centralDirectorySize, 12); // Central directory size
    eocd.writeUInt32LE(centralDirectoryOffset, 16);// Offset of start of central directory
    eocd.writeUInt16LE(0, 20);                    // Comment length (0)

    return Buffer.concat([...localChunks, ...centralChunks, eocd]);
  }
}

// Fallback CRC-32 lookup table
const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[n] = c;
}

// ----------------------------------------------------------------------------
// File Collection & Filtering
// ----------------------------------------------------------------------------

/**
 * Common exclusion patterns across all JobHunt Crew package archives.
 */
const GLOBAL_EXCLUSION_PATTERNS = [
  /\.git(\/|$)/,
  /node_modules(\/|$)/,
  /tests(\/|$)/,
  /\.agents(\/|$)/,
  /\.crew(\/|$)/,
  /\.clean-room(\/|$)/,
  /tmp(\/|$)/,
  /dist(\/|$)/,
  /coverage(\/|$)/,
  /\.DS_Store$/,
  /Thumbs\.db$/,
  /desktop\.ini$/,
  /^\.pii-denylist$/,
  /\.lock$/,
  /\.log$/,
  /\.tmp$/,
  /TEST_INFRA\.md$/,
  /TEST_READY\.md$/
];

/**
 * Collects matching file paths relative to baseDir deterministically.
 *
 * @param {string} baseDir Base workspace directory
 * @param {string[]} targets Relative target directories or files to include
 * @param {RegExp[]} [exclusions] Exclusion regexes
 * @returns {string[]} Sorted array of normalized POSIX relative file paths
 */
function collectWorkspaceFiles(baseDir, targets, exclusions = GLOBAL_EXCLUSION_PATTERNS) {
  const filePaths = [];

  function isExcluded(relPath) {
    for (const pattern of exclusions) {
      if (pattern.test(relPath)) return true;
    }
    return false;
  }

  function walk(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    const items = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(currentDir, item.name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

      if (isExcluded(relPath)) continue;

      if (item.isDirectory()) {
        walk(fullPath);
      } else if (item.isFile()) {
        filePaths.push(relPath);
      }
    }
  }

  for (const target of targets) {
    const fullTarget = path.join(baseDir, target);
    if (!fs.existsSync(fullTarget)) continue;

    const relTarget = target.replace(/\\/g, '/');
    if (isExcluded(relTarget)) continue;

    const stat = fs.statSync(fullTarget);
    if (stat.isDirectory()) {
      walk(fullTarget);
    } else if (stat.isFile()) {
      filePaths.push(relTarget);
    }
  }

  // Deduplicate and sort strictly lexicographically
  return Array.from(new Set(filePaths)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ----------------------------------------------------------------------------
// Target Manifest Definitions
// ----------------------------------------------------------------------------

const ENGINE_TARGETS = [
  'bin',
  'lib',
  'agents',
  'skills',
  'templates',
  'scripts',
  'docs',
  'gemini-desktop-pack',
  'LICENSE',
  'NOTICE',
  'README.md',
  'package.json',
  '.pii-denylist.example'
];

const SETUP_TARGETS = [
  'templates',
  'gemini-desktop-pack',
  'agents',
  'skills',
  'docs',
  'LICENSE',
  'NOTICE',
  'README.md',
  'package.json',
  '.pii-denylist.example'
];

/**
 * Builds the distribution packages.
 *
 * @param {Object} [options]
 * @param {string} [options.workspaceDir] Root workspace directory (defaults to cwd)
 * @param {string} [options.distDir] Destination directory for .zip archives (defaults to <workspace>/dist)
 * @param {number} [options.compressionLevel] Deflate compression level
 * @returns {Object} Build manifest and SHA-256 digests
 */
function buildDistPackages(options = {}) {
  const workspaceDir = options.workspaceDir ? path.resolve(options.workspaceDir) : path.resolve(__dirname, '..');
  const distDir = options.distDir ? path.resolve(options.distDir) : path.join(workspaceDir, 'dist');
  const level = options.compressionLevel !== undefined ? options.compressionLevel : 9;

  let version = '0.1.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workspaceDir, 'package.json'), 'utf8'));
    version = pkg.version || '0.1.0';
  } catch (_) {}

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // 1. Build Deployable Engine Package (dist/jobhunt-crew-v<version>.zip)
  const engineFiles = collectWorkspaceFiles(workspaceDir, ENGINE_TARGETS);
  const engineArchiver = new DeterministicZipArchiver({ compressionLevel: level });
  for (const relPath of engineFiles) {
    const fullPath = path.join(workspaceDir, relPath);
    engineArchiver.addFile(relPath, fs.readFileSync(fullPath));
  }
  const engineZipBuffer = engineArchiver.build();
  const engineZipName = `jobhunt-crew-v${version}.zip`;
  const engineZipPath = path.join(distDir, engineZipName);
  fs.writeFileSync(engineZipPath, engineZipBuffer);
  const engineSha256 = crypto.createHash('sha256').update(engineZipBuffer).digest('hex');

  // 2. Build Setup & Onboarding Package (dist/jobhunt-crew-setup.zip)
  const setupFiles = collectWorkspaceFiles(workspaceDir, SETUP_TARGETS);
  const setupArchiver = new DeterministicZipArchiver({ compressionLevel: level });
  for (const relPath of setupFiles) {
    const fullPath = path.join(workspaceDir, relPath);
    setupArchiver.addFile(relPath, fs.readFileSync(fullPath));
  }
  const setupZipBuffer = setupArchiver.build();
  const setupZipName = 'jobhunt-crew-setup.zip';
  const setupZipPath = path.join(distDir, setupZipName);
  fs.writeFileSync(setupZipPath, setupZipBuffer);
  const setupSha256 = crypto.createHash('sha256').update(setupZipBuffer).digest('hex');

  return {
    workspaceDir,
    distDir,
    version,
    engine: {
      filename: engineZipName,
      path: engineZipPath,
      filesCount: engineFiles.length,
      sizeBytes: engineZipBuffer.length,
      sha256: engineSha256,
      files: engineFiles
    },
    setup: {
      filename: setupZipName,
      path: setupZipPath,
      filesCount: setupFiles.length,
      sizeBytes: setupZipBuffer.length,
      sha256: setupSha256,
      files: setupFiles
    }
  };
}

/**
 * Verifies reproducibility by executing two consecutive builds in isolated locations
 * and asserting 100% bit-for-bit parity across SHA-256 digests.
 *
 * @param {Object} [options]
 * @returns {Object} Verification results
 */
function verifyDistPackages(options = {}) {
  const os = require('os');
  const workspaceDir = options.workspaceDir ? path.resolve(options.workspaceDir) : path.resolve(__dirname, '..');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-pkg-verify-'));

  try {
    const dist1 = path.join(tmpRoot, 'run1');
    const dist2 = path.join(tmpRoot, 'run2');

    const result1 = buildDistPackages({ workspaceDir, distDir: dist1 });
    const result2 = buildDistPackages({ workspaceDir, distDir: dist2 });

    const engineMatch = result1.engine.sha256 === result2.engine.sha256;
    const setupMatch = result1.setup.sha256 === result2.setup.sha256;
    const engineSizeMatch = result1.engine.sizeBytes === result2.engine.sizeBytes;
    const setupSizeMatch = result1.setup.sizeBytes === result2.setup.sizeBytes;

    const pass = engineMatch && setupMatch && engineSizeMatch && setupSizeMatch;

    return {
      pass,
      workspaceDir,
      engine: {
        filename: result1.engine.filename,
        run1Sha256: result1.engine.sha256,
        run2Sha256: result2.engine.sha256,
        match: engineMatch,
        sizeBytes: result1.engine.sizeBytes,
        filesCount: result1.engine.filesCount
      },
      setup: {
        filename: result1.setup.filename,
        run1Sha256: result1.setup.sha256,
        run2Sha256: result2.setup.sha256,
        match: setupMatch,
        sizeBytes: result1.setup.sizeBytes,
        filesCount: result1.setup.filesCount
      }
    };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  }
}

// ----------------------------------------------------------------------------
// CLI Entrypoint
// ----------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  let workspaceDir = path.resolve(__dirname, '..');
  let distDir = path.join(workspaceDir, 'dist');
  let doVerify = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && i + 1 < args.length) {
      workspaceDir = path.resolve(args[++i]);
    } else if (args[i] === '--dist' && i + 1 < args.length) {
      distDir = path.resolve(args[++i]);
    } else if (args[i] === '--verify') {
      doVerify = true;
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`JobHunt Crew — Deterministic Distribution Packager

Usage:
  node scripts/package-dist.js [options]

Options:
  --workspace <dir>  Path to repository root (default: current directory)
  --dist <dir>       Path to output distribution folder (default: dist/)
  --verify           Execute consecutive build verification and assert matching SHA-256
  --json             Print report as machine-parseable JSON
  --help, -h         Show this help screen
`);
      process.exit(0);
    }
  }

  if (doVerify) {
    const report = verifyDistPackages({ workspaceDir });
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('======================================================================');
      console.log('JOBHUNT CREW — DETERMINISTIC PACKAGING VERIFICATION');
      console.log('======================================================================');
      console.log(`Workspace : ${report.workspaceDir}`);
      console.log('----------------------------------------------------------------------');
      console.log(`Engine Package : ${report.engine.filename}`);
      console.log(`  Run 1 SHA-256: ${report.engine.run1Sha256}`);
      console.log(`  Run 2 SHA-256: ${report.engine.run2Sha256}`);
      console.log(`  Files Count  : ${report.engine.filesCount}`);
      console.log(`  Archive Size : ${report.engine.sizeBytes} bytes`);
      console.log(`  Parity Match : ${report.engine.match ? 'PASS (Bit-for-bit identical)' : 'FAIL'}`);
      console.log('----------------------------------------------------------------------');
      console.log(`Setup Package  : ${report.setup.filename}`);
      console.log(`  Run 1 SHA-256: ${report.setup.run1Sha256}`);
      console.log(`  Run 2 SHA-256: ${report.setup.run2Sha256}`);
      console.log(`  Files Count  : ${report.setup.filesCount}`);
      console.log(`  Archive Size : ${report.setup.sizeBytes} bytes`);
      console.log(`  Parity Match : ${report.setup.match ? 'PASS (Bit-for-bit identical)' : 'FAIL'}`);
      console.log('======================================================================');
      if (report.pass) {
        console.log('VERDICT: PACKAGING IS 100% DETERMINISTIC AND REPRODUCIBLE');
      } else {
        console.error('VERDICT: PACKAGING VERIFICATION FAILED');
      }
      console.log('======================================================================');
    }
    process.exit(report.pass ? 0 : 1);
  }

  const result = buildDistPackages({ workspaceDir, distDir });
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('======================================================================');
    console.log('JOBHUNT CREW — DISTRIBUTION PACKAGES BUILT');
    console.log('======================================================================');
    console.log(`Target Distribution Dir: ${result.distDir}`);
    console.log('----------------------------------------------------------------------');
    console.log(`1. Deployable Engine Bundle: ${result.engine.filename}`);
    console.log(`   Path      : ${result.engine.path}`);
    console.log(`   Files     : ${result.engine.filesCount} entries (0 duplicates)`);
    console.log(`   Size      : ${result.engine.sizeBytes} bytes`);
    console.log(`   SHA-256   : ${result.engine.sha256}`);
    console.log('----------------------------------------------------------------------');
    console.log(`2. Setup & Onboarding Bundle: ${result.setup.filename}`);
    console.log(`   Path      : ${result.setup.path}`);
    console.log(`   Files     : ${result.setup.filesCount} entries (0 duplicates)`);
    console.log(`   Size      : ${result.setup.sizeBytes} bytes`);
    console.log(`   SHA-256   : ${result.setup.sha256}`);
    console.log('======================================================================');
    console.log('SUCCESS: All packages created deterministically with zero npm dependencies.');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
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
};
