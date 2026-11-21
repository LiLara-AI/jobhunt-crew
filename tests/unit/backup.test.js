'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackup, restoreBackup } = require('../../lib/operational/backup');
const { EventLedger } = require('../../lib/ledger/ledger');

describe('operational/backup createBackup/restoreBackup (temp workspaces only)', () => {
  let srcDir;
  let dstDir;
  let backupFile;

  before(async () => {
    srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-backup-src-'));
    dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-backup-dst-'));
    const ledger = new EventLedger({ workspaceDir: srcDir });
    await ledger.appendEvent({ event: 'JOB_DISCOVERED', actor: 'agent:recon', payload: { id: 'job_1', title: 'Engineer', company: 'Acme' } });
    fs.writeFileSync(path.join(srcDir, '.crew', 'notes.txt'), 'synthetic notes\n', 'utf8');
    backupFile = path.join(srcDir, 'archive.json');
  });

  after(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(dstDir, { recursive: true, force: true });
  });

  test('createBackup writes a checksummed archive excluding lock files', () => {
    const res = createBackup({ workspaceDir: srcDir, outFile: backupFile });
    assert.strictEqual(res.backupPath, backupFile);
    assert.ok(res.fileCount >= 2);
    const archive = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    assert.ok(archive.files['ledger.jsonl']);
    assert.ok(archive._metadata.checksums['ledger.jsonl']);
    assert.ok(!Object.keys(archive.files).some(name => name.endsWith('.lock')));
  });

  test('createBackup rejects a workspace without .crew', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-backup-empty-'));
    try {
      assert.throws(() => createBackup({ workspaceDir: empty }), /\.crew directory not found/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('restoreBackup round-trips files and verifies the ledger chain', async () => {
    const res = await restoreBackup({ file: backupFile, workspaceDir: dstDir });
    assert.strictEqual(res.status, 'RESTORE_VERIFIED');
    assert.strictEqual(res.ledgerVerified, true);
    assert.strictEqual(res.eventCount, 1);
    assert.ok(res.restoredFiles.includes('ledger.jsonl'));
    const restored = new EventLedger({ workspaceDir: dstDir }).readEvents();
    assert.strictEqual(restored.length, 1);
    assert.strictEqual(restored[0].event, 'JOB_DISCOVERED');
    // Snapshot is rebuilt from the restored ledger.
    assert.ok(fs.existsSync(path.join(dstDir, '.crew', 'snapshot.json')));
  });

  test('restoreBackup rejects checksum-tampered archives', async () => {
    const tamperedFile = path.join(srcDir, 'tampered.json');
    const archive = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    archive.files['ledger.jsonl'] = archive.files['ledger.jsonl'] + ' ';
    fs.writeFileSync(tamperedFile, JSON.stringify(archive, null, 2), 'utf8');
    await assert.rejects(
      restoreBackup({ file: tamperedFile, workspaceDir: dstDir }),
      /checksum mismatch/
    );
  });

  test('restoreBackup rejects missing file arguments', async () => {
    await assert.rejects(restoreBackup({}), /Missing required backup file path/);
    await assert.rejects(
      restoreBackup({ file: path.join(srcDir, 'does-not-exist.json'), workspaceDir: dstDir }),
      /does not exist/
    );
  });

  test('nested .crew files round-trip with POSIX names after a wipe', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-backup-nested-'));
    try {
      const crew = path.join(work, '.crew');
      fs.mkdirSync(path.join(crew, 'tasks'), { recursive: true });
      fs.mkdirSync(path.join(crew, 'archives', 'deep'), { recursive: true });
      fs.mkdirSync(path.join(crew, 'empty-dir'), { recursive: true });
      fs.writeFileSync(path.join(crew, 'tasks', 'a.json'), '{"task":"a"}\n', 'utf8');
      fs.writeFileSync(path.join(crew, 'archives', 'deep', 'b.txt'), 'deep archive\n', 'utf8');
      fs.writeFileSync(path.join(crew, 'tasks', 'scratch.lock'), 'excluded\n', 'utf8');
      const nestedBackup = path.join(work, 'nested-archive.json');

      createBackup({ workspaceDir: work, outFile: nestedBackup });
      const archive = JSON.parse(fs.readFileSync(nestedBackup, 'utf8'));
      assert.strictEqual(archive.files['tasks/a.json'], '{"task":"a"}\n');
      assert.strictEqual(archive.files['archives/deep/b.txt'], 'deep archive\n');
      assert.ok(archive._metadata.checksums['tasks/a.json']);
      assert.ok(archive._metadata.checksums['archives/deep/b.txt']);
      assert.ok(archive._metadata.directories.includes('empty-dir'));
      assert.ok(!Object.keys(archive.files).some((name) => name.includes('\\')));
      assert.ok(!Object.keys(archive.files).some((name) => name.endsWith('.lock')));

      fs.rmSync(crew, { recursive: true, force: true });
      assert.strictEqual(fs.existsSync(crew), false);

      const res = await restoreBackup({ file: nestedBackup, workspaceDir: work });
      assert.ok(res.restoredFiles.includes('tasks/a.json'));
      assert.ok(res.restoredFiles.includes('archives/deep/b.txt'));
      assert.strictEqual(fs.readFileSync(path.join(crew, 'tasks', 'a.json'), 'utf8'), '{"task":"a"}\n');
      assert.strictEqual(fs.readFileSync(path.join(crew, 'archives', 'deep', 'b.txt'), 'utf8'), 'deep archive\n');
      assert.ok(fs.statSync(path.join(crew, 'empty-dir')).isDirectory());
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  test('restoreBackup still restores old flat backups and rejects traversal entries', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-backup-flat-'));
    try {
      const hash = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
      const flatFile = path.join(work, 'flat.json');
      fs.writeFileSync(flatFile, JSON.stringify({
        _metadata: { version: '0.1.0', fileCount: 1, checksums: { 'plain.txt': hash('flat\n') } },
        files: { 'plain.txt': 'flat\n' }
      }), 'utf8');
      const flatRes = await restoreBackup({ file: flatFile, workspaceDir: work });
      assert.deepStrictEqual(flatRes.restoredFiles, ['plain.txt']);
      assert.strictEqual(fs.readFileSync(path.join(work, '.crew', 'plain.txt'), 'utf8'), 'flat\n');

      const evilFile = path.join(work, 'evil.json');
      fs.writeFileSync(evilFile, JSON.stringify({
        _metadata: { version: '0.1.0', fileCount: 1, checksums: { '../evil.txt': hash('nope\n') } },
        files: { '../evil.txt': 'nope\n' }
      }), 'utf8');
      await assert.rejects(restoreBackup({ file: evilFile, workspaceDir: work }), /escapes \.crew/);
      assert.strictEqual(fs.existsSync(path.join(work, 'evil.txt')), false);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
  test('the profile and search settings at the workspace root are backed up and restored', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-backup-profile-'));
    const out = path.join(work, 'archive.json');
    try {
      const ledger = new EventLedger({ workspaceDir: work });
      await ledger.appendEvent({ event: 'JOB_DISCOVERED', actor: 'agent:recon', payload: { id: 'job_1', title: 'Engineer', company: 'Acme' } });
      fs.writeFileSync(path.join(work, 'dossier.json'), '{"claims":[{"id":"C-01"}]}', 'utf8');
      fs.writeFileSync(path.join(work, 'search-config.json'), '{"targetTitles":["Engineer"]}', 'utf8');
      assert.deepStrictEqual(createBackup({ workspaceDir: work, outFile: out }).workspaceFiles, ['dossier.json', 'search-config.json']);

      fs.writeFileSync(path.join(work, 'dossier.json'), '{"claims":[]}', 'utf8');
      fs.rmSync(path.join(work, 'search-config.json'));
      const res = await restoreBackup({ file: out, workspaceDir: work });
      assert.deepStrictEqual(res.restoredWorkspaceFiles, ['dossier.json', 'search-config.json']);
      assert.strictEqual(fs.readFileSync(path.join(work, 'dossier.json'), 'utf8'), '{"claims":[{"id":"C-01"}]}');
      assert.strictEqual(fs.readFileSync(path.join(work, 'search-config.json'), 'utf8'), '{"targetTitles":["Engineer"]}');

      // A tampered profile is refused before anything is written.
      const archive = JSON.parse(fs.readFileSync(out, 'utf8'));
      archive.workspaceFiles['dossier.json'] = '{"claims":[{"id":"C-99"}]}';
      fs.writeFileSync(out, JSON.stringify(archive), 'utf8');
      await assert.rejects(restoreBackup({ file: out, workspaceDir: work }), /checksum mismatch for dossier.json/);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});

