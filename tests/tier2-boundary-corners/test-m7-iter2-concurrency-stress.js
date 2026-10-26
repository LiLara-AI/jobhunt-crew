'use strict';

/**
 * Milestone M7 Iteration 2 Gate Evaluation — Concurrency, Safe Moving & Multi-Process Stress
 *
 * Authored by: challenger_m7_iter2_1 (Empirical Challenger)
 * Scope:
 *   1. safeMoveFile Edge Cases & Race Conditions:
 *      - Handling missing source (ENOENT pre-check)
 *      - Handling simulated ENOENT throw from renameSync
 *      - Handling missing destination directories
 *      - Handling concurrent unlink races
 *   2. Multi-Process Concurrent Directory Sweeps:
 *      - Multiple independent child processes executing bridge.ingestAll() concurrently
 *      - Testing for duplicate ledger events, lost files, or double-processing
 *   3. Monotonic Sequence Ordering & SHA-256 Hash Chain Integrity:
 *      - Full cryptographic validation under multi-process write contention
 *   4. Safe Deletion & Mutation Races:
 *      - Files disappearing between directory list and file ingestion
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { fork } = require('child_process');
const { TestSuite } = require('../helpers/test-harness');
const { CompanionBridge, safeMoveFile } = require('../../lib/companion/bridge');
const { EventLedger } = require('../../lib/ledger/ledger');
const { replayLedger } = require('../../lib/ledger/reducer');

const suite = new TestSuite('M7 Iteration 2 Challenger: Concurrency, Safe Moving & Multi-Process Stress');

function createTestWorkspace(prefix = 'crew-m7-stress-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const crewDir = path.join(tmpDir, '.crew');
  const inboxDir = path.join(tmpDir, 'inbox');
  const proposalsDir = path.join(inboxDir, 'proposals');
  const processedDir = path.join(inboxDir, 'processed');
  const errorsDir = path.join(inboxDir, 'errors');

  fs.mkdirSync(crewDir, { recursive: true });
  fs.mkdirSync(proposalsDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });
  fs.mkdirSync(errorsDir, { recursive: true });

  fs.writeFileSync(path.join(crewDir, 'ledger.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(crewDir, 'snapshot.json'),
    JSON.stringify({
      version: 1,
      lastEventId: 0,
      updatedAt: new Date().toISOString(),
      jobs: {},
      applications: {},
      decisions: []
    }, null, 2),
    'utf8'
  );

  const dossierContent = {
    profile: {
      name: 'Dr. Morgan Vance',
      title: 'Principal Systems Architect',
      location: 'Riyadh, KSA'
    },
    employers: [
      { id: 'emp_datadog', name: 'Datadog', isCurrent: false },
      { id: 'emp_aramco', name: 'Saudi Aramco', isCurrent: true }
    ],
    claims: [
      {
        id: 'C-10',
        employerId: 'emp_datadog',
        text: 'Designed real-time metric processing pipeline ingesting 12M pts/sec',
        status: 'VERIFIED',
        metrics: ['12M pts/sec'],
        tools: ['Go', 'Kafka']
      },
      {
        id: 'C-11',
        employerId: 'emp_aramco',
        text: 'Architected enterprise private cloud across 3 data centers',
        status: 'CONFIRM',
        metrics: ['3 data centers'],
        tools: ['OpenStack', 'Ceph']
      }
    ]
  };
  fs.writeFileSync(path.join(tmpDir, 'dossier.json'), JSON.stringify(dossierContent, null, 2), 'utf8');

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  };

  return { tmpDir, crewDir, inboxDir, proposalsDir, processedDir, errorsDir, cleanup };
}

// ============================================================================
// SECTION 1: safeMoveFile Edge Cases & Deletion Races
// ============================================================================

suite.test('1.1 safeMoveFile returns false when source does not exist without throwing', assert => {
  const ws = createTestWorkspace();
  try {
    const nonExistent = path.join(ws.proposalsDir, 'does_not_exist.json');
    const dest = path.join(ws.processedDir, 'dest.json');
    const res = safeMoveFile(nonExistent, dest);
    assert.equal(res, false, 'Moving non-existent file must return false');
    assert.equal(fs.existsSync(dest), false, 'Destination must not be created');
  } finally {
    ws.cleanup();
  }
});

suite.test('1.2 safeMoveFile successfully moves existing file and removes source', assert => {
  const ws = createTestWorkspace();
  try {
    const src = path.join(ws.proposalsDir, 'valid_move.json');
    const dest = path.join(ws.processedDir, 'valid_dest.json');
    fs.writeFileSync(src, JSON.stringify({ hello: 'world' }), 'utf8');

    const res = safeMoveFile(src, dest);
    assert.equal(res, true, 'Moving existing file must return true');
    assert.equal(fs.existsSync(src), false, 'Source must no longer exist');
    assert.equal(fs.existsSync(dest), true, 'Destination must exist');
    const content = JSON.parse(fs.readFileSync(dest, 'utf8'));
    assert.equal(content.hello, 'world');
  } finally {
    ws.cleanup();
  }
});

suite.test('1.3 safeMoveFile handles ENOENT during renameSync gracefully (race condition simulation)', assert => {
  const ws = createTestWorkspace();
  try {
    const src = path.join(ws.proposalsDir, 'race_file.json');
    const dest = path.join(ws.processedDir, 'race_dest.json');
    fs.writeFileSync(src, 'content', 'utf8');

    // Monkey-patch fs.renameSync to simulate race where file is deleted right after existsSync check
    const origRenameSync = fs.renameSync;
    try {
      fs.renameSync = () => {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      };

      const res = safeMoveFile(src, dest);
      assert.equal(res, false, 'safeMoveFile must return false on ENOENT rename error without throwing');
    } finally {
      fs.renameSync = origRenameSync;
    }
  } finally {
    ws.cleanup();
  }
});

suite.test('1.4 safeMoveFile handles missing destination directory (throws or returns)', assert => {
  const ws = createTestWorkspace();
  try {
    const src = path.join(ws.proposalsDir, 'src_file.json');
    const nonExistentDir = path.join(ws.tmpDir, 'non_existent_subdir', 'dest.json');
    fs.writeFileSync(src, 'test content', 'utf8');

    let threw = false;
    let res = null;
    try {
      res = safeMoveFile(src, nonExistentDir);
    } catch (err) {
      threw = true;
    }
    // On Windows/POSIX, renaming into non-existent directory gives ENOENT -> handled gracefully
    if (!threw) {
      assert.equal(res, false, 'safeMoveFile must return false when destination dir missing causes ENOENT');
    }
  } finally {
    ws.cleanup();
  }
});

suite.test('1.5 safeMoveFile handles ENOENT during Windows copy fallback gracefully', assert => {
  const ws = createTestWorkspace();
  try {
    const src = path.join(ws.proposalsDir, 'eperm_src.json');
    const dest = path.join(ws.processedDir, 'eperm_dest.json');
    fs.writeFileSync(src, 'content', 'utf8');

    const origRenameSync = fs.renameSync;
    const origCopyFileSync = fs.copyFileSync;
    try {
      fs.renameSync = () => {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      };
      fs.copyFileSync = () => {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      };

      let threw = false;
      let res = null;
      try {
        res = safeMoveFile(src, dest);
      } catch (err) {
        threw = true;
      }
      assert.equal(threw, false, 'safeMoveFile must not throw if file disappears during Windows copy fallback');
      assert.equal(res, false, 'safeMoveFile must return false');
    } finally {
      fs.renameSync = origRenameSync;
      fs.copyFileSync = origCopyFileSync;
    }
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// SECTION 2: Concurrent File Disappearance & Deletion Races in Ingestion
// ============================================================================

suite.test('2.1 ingestFile returns ALREADY_PROCESSED if file disappears before ingestion', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const phantomPath = path.join(ws.proposalsDir, 'phantom.json');

    const res = await bridge.ingestFile(phantomPath);
    assert.equal(res.success, false);
    assert.equal(res.action, 'ALREADY_PROCESSED');
    assert.equal(res.stateCorrupted, false);
  } finally {
    ws.cleanup();
  }
});

suite.test('2.2 ingestAll handles file deleted mid-sweep by external process', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // Create 3 files
    const f1 = path.join(ws.proposalsDir, 'prop_1.json');
    const f2 = path.join(ws.proposalsDir, 'prop_2.json');
    const f3 = path.join(ws.proposalsDir, 'prop_3.json');

    fs.writeFileSync(f1, JSON.stringify({ type: 'triage_decision', jobId: 'j1', decision: 'shortlist', score: 4.5 }), 'utf8');
    fs.writeFileSync(f2, JSON.stringify({ type: 'triage_decision', jobId: 'j2', decision: 'shortlist', score: 4.6 }), 'utf8');
    fs.writeFileSync(f3, JSON.stringify({ type: 'triage_decision', jobId: 'j3', decision: 'shortlist', score: 4.7 }), 'utf8');

    // List pending
    const pending = bridge.listPendingProposals();
    assert.equal(pending.length, 3);

    // Simulate external process unlinking f2 before bridge ingests it
    fs.unlinkSync(f2);

    const report = await bridge.ingestAll();
    // f1 and f3 succeed; f2 was removed before ingestFile, so it was not pending when ingestAll re-scanned
    assert.equal(report.summary.ingestedCount, 2, '2 remaining files must be ingested');
    assert.equal(report.summary.errorCount, 0, 'Zero errors');
    assert.equal(report.summary.corruptedCount, 0, 'Zero corruption');

    const lines = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'Ledger must have exactly 2 events');
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// SECTION 3: Multi-Process Concurrent Sweeps & Stress Testing
// ============================================================================

suite.test('3.1 Multi-Process Sweep: 4 worker processes running ingestDirectory concurrently', async assert => {
  const ws = createTestWorkspace();
  try {
    const proposalCount = 16;
    const expectedJobIds = [];

    // Seed 16 valid proposal files
    for (let i = 1; i <= proposalCount; i++) {
      const jobId = `job_multi_${String(i).padStart(3, '0')}`;
      expectedJobIds.push(jobId);
      const filePath = path.join(ws.proposalsDir, `proposal_${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          type: 'triage_decision',
          jobId,
          decision: 'shortlist',
          score: 4.0 + (i * 0.05),
          rationale: `Multi-process test proposal ${i}`
        }),
        'utf8'
      );
    }

    // Worker child process script
    const workerScript = `
      'use strict';
      const { CompanionBridge } = require(${JSON.stringify(path.resolve(__dirname, '../../lib/companion/bridge'))});
      const workspaceDir = process.argv[2];
      const workerId = process.argv[3];

      (async () => {
        try {
          const bridge = new CompanionBridge({ workspaceDir });
          const result = await bridge.ingestAll();
          if (process.send) {
            process.send({ workerId, success: true, result });
          }
          process.exit(0);
        } catch (err) {
          if (process.send) {
            process.send({ workerId, success: false, error: err.message, stack: err.stack });
          }
          process.exit(1);
        }
      })();
    `;

    const workerScriptPath = path.join(ws.tmpDir, 'worker-runner.js');
    fs.writeFileSync(workerScriptPath, workerScript, 'utf8');

    // Spawn 4 concurrent worker processes
    const workerCount = 4;
    const workerPromises = [];

    for (let w = 1; w <= workerCount; w++) {
      const p = new Promise((resolve, reject) => {
        const child = fork(workerScriptPath, [ws.tmpDir, `worker_${w}`], { stdio: 'inherit' });
        let msg = null;
        child.on('message', m => { msg = m; });
        child.on('exit', code => {
          if (code === 0) {
            resolve(msg || { workerId: `worker_${w}`, success: true });
          } else {
            reject(new Error(`Worker ${w} exited with code ${code}`));
          }
        });
        child.on('error', reject);
      });
      workerPromises.push(p);
    }

    const workerResults = await Promise.all(workerPromises);
    assert.equal(workerResults.length, workerCount, 'All 4 workers must finish');

    // Verify all proposals have been cleared from inbox/proposals/
    const remainingProposals = fs.readdirSync(ws.proposalsDir).filter(f => f.endsWith('.json'));
    assert.equal(remainingProposals.length, 0, 'No proposals should remain in inbox/proposals/');

    // Read ledger events
    const ledger = new EventLedger({
      workspaceDir: ws.tmpDir,
      ledgerPath: path.join(ws.crewDir, 'ledger.jsonl'),
      lockPath: path.join(ws.crewDir, 'ledger.lock')
    });
    const events = ledger.readEvents();

    // Check for DUPLICATE INGESTION BUG:
    // If concurrent processes read the same files before moving them, events.length would exceed 16!
    console.log(`    [DEBUG] Multi-process result: total recorded events = ${events.length} (expected: ${proposalCount})`);
    
    // Check if each job was recorded exactly once
    const recordedJobIds = events.map(e => e.payload && e.payload.jobId).filter(Boolean);
    const uniqueJobIds = new Set(recordedJobIds);

    assert.equal(uniqueJobIds.size, proposalCount, `Must record all ${proposalCount} unique jobs`);
    assert.equal(events.length, proposalCount, `Ledger must have exactly ${proposalCount} events without duplicates (actual: ${events.length})`);

    // Verify unbroken SHA-256 hash chain
    const integrity = ledger.verifyChainIntegrity();
    assert.equal(integrity.valid, true, `Cryptographic chain integrity must be valid: ${integrity.reason}`);
    assert.equal(integrity.count, proposalCount, `Chain count must match ${proposalCount}`);

    // Verify monotonic sequence numbering: 1, 2, ... 16
    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].id, i + 1, `Event at index ${i} must have id ${i + 1}`);
      assert.equal(events[i].seq, i + 1, `Event at index ${i} must have seq ${i + 1}`);
    }

    // Verify snapshot consistency
    const snapshotPath = path.join(ws.crewDir, 'snapshot.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    assert.equal(snapshot.lastEventId, proposalCount, `Snapshot lastEventId must be ${proposalCount}`);
  } finally {
    ws.cleanup();
  }
});

suite.test('3.2 Multi-Process Quarantine: 4 workers processing 10 invalid proposals concurrently', async assert => {
  const ws = createTestWorkspace();
  try {
    const invalidCount = 10;
    for (let i = 1; i <= invalidCount; i++) {
      const filePath = path.join(ws.proposalsDir, `bad_prop_${i}.json`);
      if (i % 2 === 0) {
        fs.writeFileSync(filePath, '{"broken_json": syntax_error', 'utf8');
      } else {
        // Submission bypass attempt
        fs.writeFileSync(filePath, JSON.stringify({ type: 'status_update', jobId: `j_bad_${i}`, action: 'submitted' }), 'utf8');
      }
    }

    const workerScript = `
      'use strict';
      const { CompanionBridge } = require(${JSON.stringify(path.resolve(__dirname, '../../lib/companion/bridge'))});
      const workspaceDir = process.argv[2];

      (async () => {
        try {
          const bridge = new CompanionBridge({ workspaceDir });
          await bridge.ingestAll();
          process.exit(0);
        } catch (err) {
          process.exit(1);
        }
      })();
    `;

    const workerScriptPath = path.join(ws.tmpDir, 'error-worker.js');
    fs.writeFileSync(workerScriptPath, workerScript, 'utf8');

    const workerPromises = [];
    for (let w = 1; w <= 4; w++) {
      const p = new Promise((resolve, reject) => {
        const child = fork(workerScriptPath, [ws.tmpDir], { stdio: 'inherit' });
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
        child.on('error', reject);
      });
      workerPromises.push(p);
    }

    await Promise.all(workerPromises);

    const errorFiles = fs.readdirSync(ws.errorsDir);
    const sidecars = errorFiles.filter(f => f.endsWith('.error.json'));
    console.log(`    [DEBUG] Multi-process quarantine sidecars = ${sidecars.length} (expected: ${invalidCount})`);
    assert.equal(sidecars.length, invalidCount, `Must produce exactly ${invalidCount} error sidecars (actual: ${sidecars.length})`);
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// SECTION 4: High Concurrency Multi-Process Stress Test (50 Proposals)
// ============================================================================

suite.test('4.1 High-Load Stress: 50 proposals swept concurrently by 4 workers under lock contention', async assert => {
  const ws = createTestWorkspace();
  try {
    const proposalCount = 50;
    for (let i = 1; i <= proposalCount; i++) {
      const typeChoice = i % 3;
      let payload;
      if (typeChoice === 0) {
        payload = {
          type: 'triage_decision',
          jobId: `stress_job_${i}`,
          decision: 'shortlist',
          score: 4.5
        };
      } else if (typeChoice === 1) {
        payload = {
          type: 'draft_proposal',
          jobId: `stress_job_${i}`,
          draftText: `Tailored CV for candidate Morgan Vance on stress job ${i}`,
          draftType: 'cv'
        };
      } else {
        payload = {
          type: 'pack_approval',
          jobId: `stress_job_${i}`,
          verdict: 'APPROVE',
          notes: `Batch approved ${i}`
        };
      }
      fs.writeFileSync(
        path.join(ws.proposalsDir, `stress_prop_${String(i).padStart(3, '0')}.json`),
        JSON.stringify(payload),
        'utf8'
      );
    }

    const workerScript = `
      'use strict';
      const { CompanionBridge } = require(${JSON.stringify(path.resolve(__dirname, '../../lib/companion/bridge'))});
      const workspaceDir = process.argv[2];

      (async () => {
        try {
          const bridge = new CompanionBridge({ workspaceDir });
          await bridge.ingestAll();
          process.exit(0);
        } catch (err) {
          console.error('Worker error:', err);
          process.exit(1);
        }
      })();
    `;

    const workerScriptPath = path.join(ws.tmpDir, 'stress-runner.js');
    fs.writeFileSync(workerScriptPath, workerScript, 'utf8');

    const workerCount = 4;
    const workerPromises = [];
    for (let w = 1; w <= workerCount; w++) {
      const p = new Promise((resolve, reject) => {
        const child = fork(workerScriptPath, [ws.tmpDir], { stdio: 'inherit' });
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
        child.on('error', reject);
      });
      workerPromises.push(p);
    }

    await Promise.all(workerPromises);

    const ledger = new EventLedger({
      workspaceDir: ws.tmpDir,
      ledgerPath: path.join(ws.crewDir, 'ledger.jsonl'),
      lockPath: path.join(ws.crewDir, 'ledger.lock')
    });
    const events = ledger.readEvents();

    console.log(`    [DEBUG] High-load stress result: total recorded events = ${events.length} (expected: ${proposalCount})`);

    const integrity = ledger.verifyChainIntegrity();
    assert.equal(integrity.valid, true, `Chain must remain unbroken under 50-proposal stress`);
    assert.equal(events.length, proposalCount, `All 50 events must be ingested with zero duplicates`);

    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].id, i + 1);
    }
  } finally {
    ws.cleanup();
  }
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true });
}
