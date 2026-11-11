'use strict';

/**
 * JobHunt Crew — CLI Backup & Restore Commands
 *
 * Thin wrappers over lib/operational/backup executed inside the ledger
 * cross-process lock so archives capture a consistent .crew/ snapshot.
 *
 * @module lib/cli/commands/backup
 */

const fs = require('fs');
const path = require('path');
const { withLock } = require('../../ledger/lock');
const { createBackup, restoreBackup } = require('../../operational/backup');
const { parseArgs, resolveWorkspace } = require('../shared');

async function runBackup(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const crewDir = path.join(targetDir, '.crew');
  const lockPath = path.join(crewDir, 'ledger.lock');
  try {
    const res = await withLock(async () => createBackup({
      workspaceDir: targetDir,
      outFile: flags.out || flags.o
    }), { lockPath });
    console.log(`[BACKUP] Successfully created backup at: ${res.backupPath}`);
    console.log(`  Files included : ${res.fileCount}`);
    return 0;
  } catch (err) {
    console.error(`[BACKUP] Failed to create backup: ${err.message}`);
    return 1;
  }
}

async function runRestore(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const crewDir = path.join(targetDir, '.crew');
  const lockPath = path.join(crewDir, 'ledger.lock');
  const file = flags.file || flags.f;
  if (!file) {
    console.error('[RESTORE] Missing required --file parameter');
    return 1;
  }
  if (!fs.existsSync(crewDir)) {
    fs.mkdirSync(crewDir, { recursive: true });
  }
  try {
    const res = await withLock(async () => restoreBackup({
      file,
      workspaceDir: targetDir
    }), { lockPath });
    console.log(`[RESTORE] Successfully restored ${res.restoredFiles.length} files into ${targetDir}`);
    console.log(`  Ledger verified: ${res.ledgerVerified} (${res.eventCount} events)`);
    return 0;
  } catch (err) {
    console.error(`[RESTORE] Failed to restore backup: ${err.message}`);
    return 1;
  }
}

module.exports = {
  runBackup,
  runRestore
};
