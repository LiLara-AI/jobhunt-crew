'use strict';
/**
 * Tier 4: Real-World Scenarios - Backup & Restore Lifecycle
 * Verifies one-command workspace state backup, simulated catastrophic wipe,
 * and restoration reproducing identical state down to the byte.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');

class WorkspaceBackupManager {
  static createBackup(crewDir, backupFilePath) {
    if (!fs.existsSync(crewDir)) throw new Error(`Source directory not found: ${crewDir}`);

    const backupData = {};
    const files = fs.readdirSync(crewDir);
    for (const f of files) {
      const fullPath = path.join(crewDir, f);
      if (fs.statSync(fullPath).isFile()) {
        backupData[f] = fs.readFileSync(fullPath, 'utf8');
      }
    }

    fs.writeFileSync(backupFilePath, JSON.stringify(backupData, null, 2), 'utf8');
    return { filesArchived: Object.keys(backupData).length, backupFilePath };
  }

  static restoreBackup(backupFilePath, targetCrewDir) {
    if (!fs.existsSync(backupFilePath)) throw new Error(`Backup file not found: ${backupFilePath}`);

    const backupData = JSON.parse(fs.readFileSync(backupFilePath, 'utf8'));
    if (!fs.existsSync(targetCrewDir)) {
      fs.mkdirSync(targetCrewDir, { recursive: true });
    }

    for (const [filename, content] of Object.entries(backupData)) {
      fs.writeFileSync(path.join(targetCrewDir, filename), content, 'utf8');
    }
    return { filesRestored: Object.keys(backupData).length };
  }
}

const suite = new TestSuite('Tier 4: Backup & Restore Lifecycle');

let tempDir;
let crewDir;
let backupFile;

suite.test('Set up temporary workspace for backup and restore test', assert => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-backup-test-'));
  crewDir = path.join(tempDir, '.crew');
  backupFile = path.join(tempDir, 'backup-archive.json');

  fs.mkdirSync(crewDir, { recursive: true });

  // Seed sample ledger and snapshot
  const sampleLedger = [
    '{"seq":1,"type":"JOB_DISCOVERED","payload":{"id":"j1","title":"Staff Architect"}}',
    '{"seq":2,"type":"JOB_TRIAGED","payload":{"id":"j1","verdict":"PASS"}}'
  ].join('\n');
  fs.writeFileSync(path.join(crewDir, 'ledger.jsonl'), sampleLedger, 'utf8');

  const sampleSnapshot = JSON.stringify({ version: '1.0', totalJobs: 1 });
  fs.writeFileSync(path.join(crewDir, 'snapshot.json'), sampleSnapshot, 'utf8');

  assert.ok(fs.existsSync(path.join(crewDir, 'ledger.jsonl')));
});

suite.test('Execute backup, catastrophic wipe, and restore verifying 100% data equality', assert => {
  const originalLedger = fs.readFileSync(path.join(crewDir, 'ledger.jsonl'), 'utf8');
  const originalSnapshot = fs.readFileSync(path.join(crewDir, 'snapshot.json'), 'utf8');

  // 1. Create backup
  const backupRes = WorkspaceBackupManager.createBackup(crewDir, backupFile);
  assert.equal(backupRes.filesArchived, 2);
  assert.ok(fs.existsSync(backupFile));

  // 2. Wipe .crew directory completely
  fs.rmSync(crewDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(crewDir), false, '.crew directory must be wiped');

  // 3. Restore backup
  const restoreRes = WorkspaceBackupManager.restoreBackup(backupFile, crewDir);
  assert.equal(restoreRes.filesRestored, 2);

  // 4. Verify byte-for-byte equality
  const restoredLedger = fs.readFileSync(path.join(crewDir, 'ledger.jsonl'), 'utf8');
  const restoredSnapshot = fs.readFileSync(path.join(crewDir, 'snapshot.json'), 'utf8');

  assert.equal(restoredLedger, originalLedger, 'Restored ledger must match original exactly');
  assert.equal(restoredSnapshot, originalSnapshot, 'Restored snapshot must match original exactly');
});

suite.test('Clean up temporary backup workspace', assert => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(tempDir), false);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
