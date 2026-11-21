'use strict';

/**
 * JobHunt Crew — Disaster Recovery Backup & Restore
 *
 * Implements roundtrip-verified cryptographic backup archives for the local
 * `.crew/` workspace directory.
 *
 * @module lib/operational/backup
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventLedger } = require('../ledger/ledger');
const { replayLedger } = require('../ledger/reducer');

// The profile and search settings live at the workspace root, outside .crew.
// Fixed names only: restore never takes a workspace path from the archive.
const WORKSPACE_FILES = ['dossier.json', 'search-config.json'];
const sha256 = content => crypto.createHash('sha256').update(content, 'utf8').digest('hex');

function toPosixPath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function compareNames(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function collectCrewEntries(crewDir, currentDir, files, checksums, directories) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    .sort((a, b) => compareNames(a.name, b.name));

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(currentDir, entry.name);
    const posixName = toPosixPath(path.relative(crewDir, fullPath));
    if (entry.isDirectory()) {
      directories.push(posixName);
      collectCrewEntries(crewDir, fullPath, files, checksums, directories);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.lock') || entry.name.endsWith('.tmp')) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      files[posixName] = content;
      checksums[posixName] = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    }
  }
}

function traversalError(name) {
  return new Error(`Backup entry escapes .crew directory (path traversal outside .crew): ${name}`);
}

function resolveEntryTarget(crewDir, name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new Error(`Invalid backup entry path: ${name}`);
  }
  if (name.includes('\\')) {
    throw traversalError(name);
  }
  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) {
    throw traversalError(name);
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw traversalError(name);
  }
  if (segments.some((segment) => segment === '' || segment === '.')) {
    throw new Error(`Invalid backup entry path: ${name}`);
  }
  const crewResolved = path.resolve(crewDir);
  const targetPath = path.resolve(crewResolved, ...segments);
  if (targetPath === crewResolved || !targetPath.startsWith(crewResolved + path.sep)) {
    throw traversalError(name);
  }
  return targetPath;
}

function assertNoSymlinkComponents(crewDir, targetPath, name) {
  const relative = path.relative(path.resolve(crewDir), targetPath);
  let current = path.resolve(crewDir);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw traversalError(name);
    }
  }
}

/**
 * Creates a cryptographic backup of the `.crew/` workspace directory.
 * @param {Object} options
 * @param {string} [options.workspaceDir] Workspace root
 * @param {string} [options.outFile] Target backup JSON path
 * @returns {Object} Backup summary metadata
 */
function createBackup(options = {}) {
  const workspace = path.resolve(options.workspaceDir || process.cwd());
  const crewDir = path.join(workspace, '.crew');
  const outFile = options.outFile ? path.resolve(options.outFile) : path.join(workspace, `crew-backup-${Date.now()}.json`);

  if (!fs.existsSync(crewDir)) {
    throw new Error(`Cannot backup: .crew directory not found at ${crewDir}`);
  }

  const files = {};
  const checksums = {};
  const directories = [];
  collectCrewEntries(crewDir, crewDir, files, checksums, directories);
  directories.sort(compareNames);

  const workspaceFiles = {};
  const workspaceChecksums = {};
  for (const name of WORKSPACE_FILES) {
    const filePath = path.join(workspace, name);
    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) continue;
    workspaceFiles[name] = fs.readFileSync(filePath, 'utf8');
    workspaceChecksums[name] = sha256(workspaceFiles[name]);
  }

  const backupData = {
    _metadata: {
      version: '0.1.0',
      createdAt: new Date().toISOString(),
      fileCount: Object.keys(files).length,
      directories,
      checksums,
      workspaceChecksums
    },
    files,
    workspaceFiles
  };

  fs.writeFileSync(outFile, JSON.stringify(backupData, null, 2) + '\n', 'utf8');

  return {
    backupPath: outFile,
    fileCount: Object.keys(files).length,
    checksums,
    workspaceFiles: Object.keys(workspaceFiles)
  };
}

/**
 * Restores a cryptographic backup archive with integrity verification.
 * @param {Object} options
 * @param {string} options.file Backup archive file path
 * @param {string} [options.workspaceDir] Target workspace root
 * @returns {Promise<Object>} Restore verification summary
 */
async function restoreBackup(options = {}) {
  if (!options.file) {
    throw new Error('Missing required backup file path (--file)');
  }
  const backupFile = path.resolve(options.file);
  const workspace = path.resolve(options.workspaceDir || process.cwd());
  const crewDir = path.join(workspace, '.crew');

  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup file does not exist: ${backupFile}`);
  }

  const raw = fs.readFileSync(backupFile, 'utf8');
  const backup = JSON.parse(raw);

  if (!backup || !backup.files || !backup._metadata || !backup._metadata.checksums) {
    throw new Error('Invalid backup archive structure: missing metadata or file table');
  }

  if (!fs.existsSync(crewDir)) {
    fs.mkdirSync(crewDir, { recursive: true });
  }

  const declaredDirectories = backup._metadata.directories;
  if (declaredDirectories !== undefined && !Array.isArray(declaredDirectories)) {
    throw new Error('Invalid backup archive structure: directories must be an array');
  }
  // Validate every entry before writing so a bad archive cannot partially
  // restore or write outside .crew. Flat names from older backups pass here.
  const directoryPlan = (declaredDirectories || []).map((name) => ({
    name,
    targetPath: resolveEntryTarget(crewDir, name)
  }));
  const filePlan = [];
  for (const [name, content] of Object.entries(backup.files)) {
    if (typeof content !== 'string') {
      throw new Error(`Invalid backup entry content: ${name}`);
    }
    filePlan.push({ name, content, targetPath: resolveEntryTarget(crewDir, name) });
  }
  for (const entry of [...directoryPlan, ...filePlan]) {
    assertNoSymlinkComponents(crewDir, entry.targetPath, entry.name);
  }

  // Checksums pre-check
  for (const { name, content } of filePlan) {
    const expectedHash = backup._metadata.checksums[name];
    const actualHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    if (expectedHash && expectedHash !== actualHash) {
      throw new Error(`Backup archive corrupted: checksum mismatch for ${name}`);
    }
  }

  // Profile files at the workspace root (absent in older backups).
  const workspacePlan = [];
  for (const name of WORKSPACE_FILES) {
    const content = backup.workspaceFiles ? backup.workspaceFiles[name] : undefined;
    if (content === undefined) continue;
    if (typeof content !== 'string') throw new Error(`Invalid backup entry content: ${name}`);
    const expectedHash = (backup._metadata.workspaceChecksums || {})[name];
    if (expectedHash !== sha256(content)) throw new Error(`Backup archive corrupted: checksum mismatch for ${name}`);
    const targetPath = path.join(workspace, name);
    // lstat, not existsSync: a dangling link reports as missing and would be written through.
    const existing = fs.lstatSync(targetPath, { throwIfNoEntry: false });
    if (existing && existing.isSymbolicLink()) throw traversalError(name);
    workspacePlan.push({ name, content, targetPath, replaces: Boolean(existing) });
  }

  // Restore directories, then files (each file's parent is ensured too, so
  // nested entries restore even when directories metadata is absent).
  for (const { targetPath } of directoryPlan) {
    fs.mkdirSync(targetPath, { recursive: true });
  }
  const restoredFiles = [];
  for (const { name, content, targetPath } of filePlan) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf8');
    restoredFiles.push(name);
  }
  for (const { content, targetPath, replaces } of workspacePlan) {
    // Keep the profile being replaced: a restore must not be the way it is lost.
    if (replaces) fs.copyFileSync(targetPath, `${targetPath}.pre-restore`);
    fs.writeFileSync(targetPath, content, 'utf8');
  }

  // Verify restored ledger chain
  const ledgerPath = path.join(crewDir, 'ledger.jsonl');
  let ledgerVerified = false;
  let eventCount = 0;
  if (fs.existsSync(ledgerPath)) {
    const ledger = new EventLedger({ ledgerPath });
    const check = ledger.verifyChainIntegrity();
    if (!check.valid) {
      throw new Error(`Restored ledger failed cryptographic chain verification: ${check.reason}`);
    }
    ledgerVerified = true;
    eventCount = check.count;
    // Replay snapshot
    await replayLedger({ workspaceDir: workspace, rebuild: true });
  }

  return {
    restoredFiles,
    restoredWorkspaceFiles: workspacePlan.map(entry => entry.name),
    ledgerVerified,
    eventCount,
    status: 'RESTORE_VERIFIED'
  };
}

module.exports = {
  createBackup,
  restoreBackup
};
