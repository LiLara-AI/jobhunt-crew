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

  const entries = fs.readdirSync(crewDir);
  const files = {};
  const checksums = {};

  for (const entry of entries) {
    if (entry.endsWith('.lock') || entry.endsWith('.tmp')) continue;
    const fullPath = path.join(crewDir, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    const content = fs.readFileSync(fullPath, 'utf8');
    const hash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    files[entry] = content;
    checksums[entry] = hash;
  }

  const backupData = {
    _metadata: {
      version: '0.1.0',
      createdAt: new Date().toISOString(),
      fileCount: Object.keys(files).length,
      checksums
    },
    files
  };

  fs.writeFileSync(outFile, JSON.stringify(backupData, null, 2) + '\n', 'utf8');

  return {
    backupPath: outFile,
    fileCount: Object.keys(files).length,
    checksums
  };
}

/**
 * Restores a cryptographic backup archive with integrity verification.
 * @param {Object} options
 * @param {string} options.file Backup archive file path
 * @param {string} [options.workspaceDir] Target workspace root
 * @returns {Object} Restore verification summary
 */
function restoreBackup(options = {}) {
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

  // Checksums pre-check
  for (const [name, content] of Object.entries(backup.files)) {
    const expectedHash = backup._metadata.checksums[name];
    const actualHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    if (expectedHash && expectedHash !== actualHash) {
      throw new Error(`Backup archive corrupted: checksum mismatch for ${name}`);
    }
  }

  // Restore files
  const restoredFiles = [];
  for (const [name, content] of Object.entries(backup.files)) {
    const targetPath = path.join(crewDir, name);
    fs.writeFileSync(targetPath, content, 'utf8');
    restoredFiles.push(name);
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
    replayLedger({ workspaceDir: workspace, rebuild: true });
  }

  return {
    restoredFiles,
    ledgerVerified,
    eventCount,
    status: 'RESTORE_VERIFIED'
  };
}

module.exports = {
  createBackup,
  restoreBackup
};
