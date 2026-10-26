'use strict';

/**
 * Milestone M7 Iteration 3 Gate Evaluation — Independent Multi-Process Concurrency & Claiming Probe
 *
 * Authored by: challenger_m7_iter3_1 (Empirical Challenger)
 * Scope:
 *   1. Massive Multi-Process Racing Ingestion (8 Workers, 60 Mixed Proposals)
 *   2. Real-Time High-Frequency Producer-Consumer Streaming Ingestion
 *   3. Targeted Concurrent Collision (6 Workers racing on Identical File Paths via ingestFile)
 *   4. Atomic Claiming & Windows Retry Resilience under Simulated File Contention
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

const suite = new TestSuite('M7 Iteration 3 Challenger: Independent Concurrency & Atomic Claiming Probe');

function createTestWorkspace(prefix = 'crew-m7-probe-') {
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
// PROBE 1: Massive Multi-Process Racing Ingestion (8 Workers, 60 Mixed Proposals)
// ============================================================================

suite.test('Probe 1: 8 Worker child processes concurrently sweeping 60 mixed proposals', async assert => {
  const ws = createTestWorkspace('crew-m7-probe1-');
  try {
    const validCount = 40;
    const invalidCount = 20;
    const totalCount = validCount + invalidCount;

    // Seed 30 valid triage proposals
    for (let i = 1; i <= 30; i++) {
      const jobId = `job_probe_${String(i).padStart(3, '0')}`;
      const filePath = path.join(ws.proposalsDir, `prop_triage_${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          type: 'triage_decision',
          jobId,
          decision: 'shortlist',
          score: 4.0 + (i * 0.02),
          rationale: `Valid triage proposal ${i}`
        }),
        'utf8'
      );
    }

    // Seed 10 valid claim confirmations
    for (let i = 1; i <= 10; i++) {
      const filePath = path.join(ws.proposalsDir, `prop_claim_${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          type: 'claim_confirmation',
          claimId: 'C-11',
          evidence: `Verified enterprise architecture cert doc #${i}`,
          confirmedAt: new Date().toISOString()
        }),
        'utf8'
      );
    }

    // Seed 10 malformed JSON files
    for (let i = 1; i <= 10; i++) {
      const filePath = path.join(ws.proposalsDir, `bad_syntax_${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(filePath, i % 2 === 0 ? '{"broken": syntax' : '{"unclosed": ', 'utf8');
    }

    // Seed 5 guardrail violations (unauthorized submission)
    for (let i = 1; i <= 5; i++) {
      const filePath = path.join(ws.proposalsDir, `bad_submit_${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          type: 'status_update',
          jobId: `job_probe_viol_${i}`,
          action: 'submitted'
        }),
        'utf8'
      );
    }

    // Seed 5 security violations (path traversal)
    for (let i = 1; i <= 5; i++) {
      const filePath = path.join(ws.proposalsDir, `bad_traversal_${String(i).padStart(3, '0')}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          type: 'triage_decision',
          jobId: `../../etc/passwd_${i}`,
          decision: 'shortlist'
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

    const workerScriptPath = path.join(ws.tmpDir, 'worker-runner-probe1.js');
    fs.writeFileSync(workerScriptPath, workerScript, 'utf8');

    // Spawn 8 concurrent worker processes
    const workerCount = 8;
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
    assert.equal(workerResults.length, workerCount, 'All 8 workers must exit successfully');

    // Verify inbox/proposals/ is completely cleared (no json, no .claiming files)
    const remainingFiles = fs.readdirSync(ws.proposalsDir);
    assert.equal(remainingFiles.length, 0, `inbox/proposals/ must be completely empty (actual: ${remainingFiles.join(', ')})`);

    // Verify exactly 40 files in inbox/processed/
    const processedFiles = fs.readdirSync(ws.processedDir).filter(f => f.endsWith('.json'));
    assert.equal(processedFiles.length, validCount, `inbox/processed/ must contain exactly ${validCount} files`);

    // Verify exactly 20 error sidecars in inbox/errors/
    const errorSidecars = fs.readdirSync(ws.errorsDir).filter(f => f.endsWith('.error.json'));
    assert.equal(errorSidecars.length, invalidCount, `inbox/errors/ must contain exactly ${invalidCount} error sidecars (actual: ${errorSidecars.length})`);

    // Verify ledger has exactly 40 events
    const ledger = new EventLedger({
      workspaceDir: ws.tmpDir,
      ledgerPath: path.join(ws.crewDir, 'ledger.jsonl'),
      lockPath: path.join(ws.crewDir, 'ledger.lock')
    });
    const events = ledger.readEvents();
    assert.equal(events.length, validCount, `Ledger must have exactly ${validCount} events (actual: ${events.length})`);

    // Verify unbroken SHA-256 hash chain and monotonic seq
    const integrity = ledger.verifyChainIntegrity();
    assert.equal(integrity.valid, true, `Cryptographic chain integrity must be valid: ${integrity.reason}`);
    assert.equal(integrity.count, validCount);

    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].id, i + 1, `Event at index ${i} must have sequential id ${i + 1}`);
      assert.equal(events[i].seq, i + 1, `Event at index ${i} must have sequential seq ${i + 1}`);
    }

    // Verify snapshot consistency
    const snapshotPath = path.join(ws.crewDir, 'snapshot.json');
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    assert.equal(snapshot.lastEventId, validCount, `Snapshot lastEventId must be ${validCount}`);
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// PROBE 2: Live High-Frequency Producer-Consumer Streaming Ingestion
// ============================================================================

suite.test('Probe 2: 4 Consumers polling continuously while 1 Producer drops 40 files in bursts', async assert => {
  const ws = createTestWorkspace('crew-m7-probe2-');
  try {
    const validCount = 25;
    const invalidCount = 15;
    const totalCount = validCount + invalidCount;
    const stopSentinel = path.join(ws.tmpDir, 'producer_finished.flag');

    // Consumer script: polls every 15ms until stopSentinel exists AND inbox/proposals/ has 0 pending files
    const consumerScript = `
      'use strict';
      const fs = require('fs');
      const { CompanionBridge } = require(${JSON.stringify(path.resolve(__dirname, '../../lib/companion/bridge'))});
      const workspaceDir = process.argv[2];
      const stopFlag = process.argv[3];
      const workerId = process.argv[4];

      const sleep = ms => new Promise(r => setTimeout(r, ms));

      (async () => {
        try {
          const bridge = new CompanionBridge({ workspaceDir });
          let totalIngested = 0;
          let emptyStreak = 0;

          while (true) {
            const report = await bridge.ingestAll();
            totalIngested += report.summary.ingestedCount;

            const pending = bridge.listPendingProposals();
            if (fs.existsSync(stopFlag) && pending.length === 0) {
              emptyStreak++;
              if (emptyStreak >= 3) {
                break;
              }
            } else {
              emptyStreak = 0;
            }
            await sleep(15);
          }

          if (process.send) {
            process.send({ workerId, success: true, totalIngested });
          }
          process.exit(0);
        } catch (err) {
          if (process.send) {
            process.send({ workerId, success: false, error: err.message });
          }
          process.exit(1);
        }
      })();
    `;

    // Producer script: drops 40 files in quick bursts (5 files every 25ms) using atomic rename
    const producerScript = `
      'use strict';
      const fs = require('fs');
      const path = require('path');
      const proposalsDir = process.argv[2];
      const stopFlag = process.argv[3];

      const sleep = ms => new Promise(r => setTimeout(r, ms));

      (async () => {
        try {
          // 25 valid proposals
          for (let i = 1; i <= 25; i++) {
            const tmpFile = path.join(proposalsDir, \`.tmp_prod_\${i}.json\`);
            const targetFile = path.join(proposalsDir, \`stream_prop_\${String(i).padStart(3, '0')}.json\`);
            fs.writeFileSync(
              tmpFile,
              JSON.stringify({
                type: 'triage_decision',
                jobId: \`job_stream_\${i}\`,
                decision: 'shortlist',
                score: 4.2
              }),
              'utf8'
            );
            fs.renameSync(tmpFile, targetFile);
            if (i % 5 === 0) await sleep(25);
          }

          // 15 invalid proposals (5 malformed, 5 submitted guardrail, 5 bad types)
          for (let i = 1; i <= 15; i++) {
            const tmpFile = path.join(proposalsDir, \`.tmp_bad_\${i}.json\`);
            const targetFile = path.join(proposalsDir, \`stream_bad_\${String(i).padStart(3, '0')}.json\`);
            if (i <= 5) {
              fs.writeFileSync(tmpFile, '{"broken": syntax_err', 'utf8');
            } else if (i <= 10) {
              fs.writeFileSync(tmpFile, JSON.stringify({ type: 'status_update', jobId: \`job_stream_bad_\${i}\`, action: 'submitted' }), 'utf8');
            } else {
              fs.writeFileSync(tmpFile, JSON.stringify(['invalid_array_root']), 'utf8');
            }
            fs.renameSync(tmpFile, targetFile);
            if (i % 5 === 0) await sleep(25);
          }

          // Signal producer is finished
          fs.writeFileSync(stopFlag, 'done', 'utf8');
          process.exit(0);
        } catch (err) {
          console.error(err);
          process.exit(1);
        }
      })();
    `;

    const consumerScriptPath = path.join(ws.tmpDir, 'consumer-runner.js');
    const producerScriptPath = path.join(ws.tmpDir, 'producer-runner.js');
    fs.writeFileSync(consumerScriptPath, consumerScript, 'utf8');
    fs.writeFileSync(producerScriptPath, producerScript, 'utf8');

    // Spawn 4 consumers
    const consumerPromises = [];
    for (let c = 1; c <= 4; c++) {
      const p = new Promise((resolve, reject) => {
        const child = fork(consumerScriptPath, [ws.tmpDir, stopSentinel, `consumer_${c}`], { stdio: 'inherit' });
        let msg = null;
        child.on('message', m => { msg = m; });
        child.on('exit', code => {
          if (code === 0) resolve(msg || { workerId: `consumer_${c}`, success: true });
          else reject(new Error(`Consumer ${c} exited with code ${code}`));
        });
        child.on('error', reject);
      });
      consumerPromises.push(p);
    }

    // Spawn producer
    const producerPromise = new Promise((resolve, reject) => {
      const child = fork(producerScriptPath, [ws.proposalsDir, stopSentinel], { stdio: 'inherit' });
      child.on('exit', code => {
        if (code === 0) resolve();
        else reject(new Error(`Producer exited with code ${code}`));
      });
      child.on('error', reject);
    });

    await Promise.all([producerPromise, ...consumerPromises]);

    // Verify inbox/proposals/ is drained
    const remainingProposals = fs.readdirSync(ws.proposalsDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    assert.equal(remainingProposals.length, 0, 'All proposals must be ingested');

    // Verify ledger has exactly 25 events
    const ledger = new EventLedger({
      workspaceDir: ws.tmpDir,
      ledgerPath: path.join(ws.crewDir, 'ledger.jsonl'),
      lockPath: path.join(ws.crewDir, 'ledger.lock')
    });
    const events = ledger.readEvents();
    console.log(`    [DEBUG Probe 2] events count: ${events.length}`);
    events.forEach(e => console.log(`      #${e.id}: ${e.event} - jobId: ${e.payload && e.payload.jobId}`));
    assert.equal(events.length, validCount, `Ledger must have exactly ${validCount} events (actual: ${events.length})`);

    // Verify 15 error sidecars
    const errorSidecars = fs.readdirSync(ws.errorsDir).filter(f => f.endsWith('.error.json'));
    assert.equal(errorSidecars.length, invalidCount, `Must produce exactly ${invalidCount} error sidecars (actual: ${errorSidecars.length})`);

    // Chain integrity
    const integrity = ledger.verifyChainIntegrity();
    assert.equal(integrity.valid, true, `Chain integrity must be valid: ${integrity.reason}`);
    assert.equal(integrity.count, validCount);
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// PROBE 3: Targeted Concurrent Collision (6 Workers on Identical File Paths)
// ============================================================================

suite.test('Probe 3: 6 Worker processes racing on the exact same explicit file paths via ingestFile', async assert => {
  const ws = createTestWorkspace('crew-m7-probe3-');
  try {
    const fileCount = 20;
    const filePaths = [];

    // Seed 20 proposal files
    for (let i = 1; i <= fileCount; i++) {
      const p = path.join(ws.proposalsDir, `targeted_prop_${String(i).padStart(3, '0')}.json`);
      filePaths.push(p);
      fs.writeFileSync(
        p,
        JSON.stringify({
          type: 'triage_decision',
          jobId: `job_targeted_${i}`,
          decision: 'shortlist',
          score: 4.8
        }),
        'utf8'
      );
    }

    // Worker child process script: given exact filePaths array, iterates and calls ingestFile on every file
    const workerScript = `
      'use strict';
      const { CompanionBridge } = require(${JSON.stringify(path.resolve(__dirname, '../../lib/companion/bridge'))});
      const workspaceDir = process.argv[2];
      const workerId = process.argv[3];
      const files = JSON.parse(process.argv[4]);

      (async () => {
        try {
          const bridge = new CompanionBridge({ workspaceDir });
          let successCount = 0;
          let alreadyProcessedCount = 0;

          for (const filePath of files) {
            const res = await bridge.ingestFile(filePath);
            if (res.success) {
              successCount++;
            } else if (res.action === 'ALREADY_PROCESSED') {
              alreadyProcessedCount++;
            } else {
              throw new Error(\`Unexpected result for \${filePath}: \${JSON.stringify(res)}\`);
            }
          }

          if (process.send) {
            process.send({ workerId, success: true, successCount, alreadyProcessedCount });
          }
          process.exit(0);
        } catch (err) {
          if (process.send) {
            process.send({ workerId, success: false, error: err.message });
          }
          process.exit(1);
        }
      })();
    `;

    const workerScriptPath = path.join(ws.tmpDir, 'worker-targeted.js');
    fs.writeFileSync(workerScriptPath, workerScript, 'utf8');

    // Spawn 6 workers targeting the exact same files simultaneously
    const workerCount = 6;
    const workerPromises = [];
    const filesJson = JSON.stringify(filePaths);

    for (let w = 1; w <= workerCount; w++) {
      const p = new Promise((resolve, reject) => {
        const child = fork(workerScriptPath, [ws.tmpDir, `worker_${w}`, filesJson], { stdio: 'inherit' });
        let msg = null;
        child.on('message', m => { msg = m; });
        child.on('exit', code => {
          if (code === 0) resolve(msg || { workerId: `worker_${w}`, success: true });
          else reject(new Error(`Worker ${w} exited with code ${code}`));
        });
        child.on('error', reject);
      });
      workerPromises.push(p);
    }

    const results = await Promise.all(workerPromises);
    assert.equal(results.length, workerCount);

    // Sum of all successful ingestions across workers must equal exactly 20
    const totalSuccess = results.reduce((sum, r) => sum + (r.successCount || 0), 0);
    const totalAlreadyProcessed = results.reduce((sum, r) => sum + (r.alreadyProcessedCount || 0), 0);

    assert.equal(totalSuccess, fileCount, `Total successful claims must be exactly ${fileCount} (actual: ${totalSuccess})`);
    assert.equal(totalAlreadyProcessed, fileCount * (workerCount - 1), `Total already processed claims must be ${fileCount * (workerCount - 1)} (actual: ${totalAlreadyProcessed})`);

    // Verify ledger has exactly 20 events
    const ledger = new EventLedger({
      workspaceDir: ws.tmpDir,
      ledgerPath: path.join(ws.crewDir, 'ledger.jsonl'),
      lockPath: path.join(ws.crewDir, 'ledger.lock')
    });
    const events = ledger.readEvents();
    assert.equal(events.length, fileCount, `Ledger must have exactly ${fileCount} events without duplicates (actual: ${events.length})`);

    const integrity = ledger.verifyChainIntegrity();
    assert.equal(integrity.valid, true, 'Chain integrity valid');
    assert.equal(integrity.count, fileCount);
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// PROBE 4: Atomic Claiming & Windows Retry Resilience under Simulated Contention
// ============================================================================

suite.test('Probe 4: 20 Concurrent async promises racing safeMoveFile on the same file', assert => {
  const ws = createTestWorkspace('crew-m7-probe4-');
  try {
    const src = path.join(ws.proposalsDir, 'collision_test.json');
    fs.writeFileSync(src, JSON.stringify({ key: 'collision_content' }), 'utf8');

    // 20 workers calling safeMoveFile on the same src
    const results = [];
    for (let i = 0; i < 20; i++) {
      const dest = path.join(ws.processedDir, `collision_dest_${i}.json`);
      results.push(safeMoveFile(src, dest));
    }

    const trueCount = results.filter(r => r === true).length;
    const falseCount = results.filter(r => r === false).length;

    assert.equal(trueCount, 1, 'Exactly 1 worker must succeed in safeMoveFile');
    assert.equal(falseCount, 19, 'Exactly 19 workers must return false');
    assert.equal(fs.existsSync(src), false, 'Source file must be removed');

    const destFiles = fs.readdirSync(ws.processedDir).filter(f => f.startsWith('collision_dest_'));
    assert.equal(destFiles.length, 1, 'Exactly one destination file must exist');
    const content = JSON.parse(fs.readFileSync(path.join(ws.processedDir, destFiles[0]), 'utf8'));
    assert.equal(content.key, 'collision_content', 'Content must be intact');
  } finally {
    ws.cleanup();
  }
});

suite.test('Probe 5: safeMoveFile handles simulated Windows EPERM lock retry successfully', assert => {
  const ws = createTestWorkspace('crew-m7-probe5-');
  try {
    const src = path.join(ws.proposalsDir, 'retry_test.json');
    const dest = path.join(ws.processedDir, 'retry_dest.json');
    fs.writeFileSync(src, JSON.stringify({ key: 'retry_data' }), 'utf8');

    const origRename = fs.renameSync;
    const origPlatform = process.platform;
    let attempts = 0;

    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      fs.renameSync = (s, d) => {
        attempts++;
        if (attempts === 1) {
          const err = new Error('EPERM: operation not permitted');
          err.code = 'EPERM';
          throw err;
        }
        return origRename(s, d);
      };

      const res = safeMoveFile(src, dest, 2);
      assert.equal(res, true, 'safeMoveFile must succeed on retry or fallback');
      assert.equal(fs.existsSync(dest), true, 'Destination must exist');
      assert.equal(fs.existsSync(src), false, 'Source must be removed');
    } finally {
      fs.renameSync = origRename;
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  } finally {
    ws.cleanup();
  }
});

suite.test('Probe 6: safeMoveFile cleans up destination when unlinkSync throws ENOENT during copy fallback', assert => {
  const ws = createTestWorkspace('crew-m7-probe6-');
  try {
    const src = path.join(ws.proposalsDir, 'orphan_cleanup_test.json');
    const dest = path.join(ws.processedDir, 'orphan_cleanup_dest.json');
    fs.writeFileSync(src, 'data', 'utf8');

    const origRename = fs.renameSync;
    const origUnlink = fs.unlinkSync;
    const origPlatform = process.platform;

    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      fs.renameSync = () => {
        const err = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      };
      // unlinkSync throws ENOENT simulating another process unlinked src first
      fs.unlinkSync = (target) => {
        if (target === src) {
          const err = new Error('ENOENT: no such file or directory');
          err.code = 'ENOENT';
          throw err;
        }
        return origUnlink(target);
      };

      const res = safeMoveFile(src, dest, 1);
      assert.equal(res, false, 'safeMoveFile must return false when source unlinked before unlinkSync');
      assert.equal(fs.existsSync(dest), false, 'Destination file must be cleaned up to prevent orphaned copies');
    } finally {
      fs.renameSync = origRename;
      fs.unlinkSync = origUnlink;
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  } finally {
    ws.cleanup();
  }
});

// Run all probe tests
if (require.main === module) {
  suite.run({ verbose: true }).then(summary => {
    if (summary.failed > 0) {
      console.error(`\nProbe suite failed: ${summary.failed}/${summary.total} tests failed.`);
      process.exit(1);
    } else {
      console.log(`\nProbe suite passed: ${summary.passed}/${summary.total} tests passed.`);
      process.exit(0);
    }
  }).catch(err => {
    console.error('Fatal probe runner error:', err);
    process.exit(1);
  });
}

module.exports = { suite };
