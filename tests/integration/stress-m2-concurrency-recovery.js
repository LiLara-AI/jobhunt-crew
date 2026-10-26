'use strict';
/**
 * JobHunt Crew — Milestone M2 Empirical Challenger Stress Suite
 * Author: challenger_m2_1 (Empirical Challenger)
 * Location: tests/integration/stress-m2-concurrency-recovery.js
 *
 * Adversarial stress harness covering:
 * 1. Concurrency: >= 4 concurrent worker processes appending events simultaneously.
 *    Verifies 0 lost records, 0 sequence collisions, 100% hash chain integrity.
 * 2. Concurrency: 6 concurrent worker processes under heavy contention.
 * 3. Concurrency: 4 concurrent CLI processes (`bin/crew.js ledger append`) simultaneously.
 * 4. Stale Lock Recovery:
 *    - Dead PID stale lock recovery (even when expiresAt is set to the future).
 *    - Expired lease recovery (past expiresAt).
 *    - crew doctor --fix detection and remediation of stale locks.
 * 5. Live Lock Protection (Anti-Theft):
 *    - Verified that an active live PID holding the lock CANNOT be stolen under contention.
 * 6. Snapshot Corruption Recovery:
 *    - Corrupted snapshot.json recovered via `crew ledger replay --rebuild`.
 *    - Deleted snapshot.json reconstructed from ledger.
 *    - Corrupted snapshot.json gracefully recovered during regular replay without --rebuild.
 * 7. Lock Contention Stability:
 *    - 50 rapid sequential withLock operations without deadlocks or unhandled rejections.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork, spawnSync } = require('child_process');
const { TestSuite } = require('../helpers/test-harness');
const { EventLedger } = require('../../lib/ledger/ledger');
const { FileLock, withLock } = require('../../lib/ledger/lock');
const { replayLedger } = require('../../lib/ledger/reducer');

// ============================================================================
// WORKER CHILD PROCESS ROLES
// ============================================================================

function runConcurrencyWorker() {
  (async () => {
    try {
      const ledgerPath = process.env.LEDGER_PATH;
      const lockPath = process.env.LOCK_PATH;
      const workerId = process.env.WORKER_ID;
      const eventCount = parseInt(process.env.EVENT_COUNT || '20', 10);

      const ledger = new EventLedger({ ledgerPath, lockPath, timeoutMs: 15000 });

      for (let i = 0; i < eventCount; i++) {
        await ledger.appendEvent({
          event: 'JOB_DISCOVERED',
          payload: {
            id: `job_${workerId}_${i}`,
            title: `Position ${i} - ${workerId}`,
            company: `Corp_${workerId}`,
            url: `https://example.com/${workerId}/${i}`
          },
          actor: `agent:${workerId}`
        });

        // Add randomized micro-jitter (1-10ms) to maximize lock race conditions
        const jitter = Math.floor(Math.random() * 10) + 1;
        await new Promise(r => setTimeout(r, jitter));
      }

      if (process.send) {
        process.send({ status: 'done', workerId, count: eventCount });
      }
      process.exit(0);
    } catch (err) {
      console.error(`[Worker ${process.env.WORKER_ID}] Error: ${err.message}`);
      if (process.send) {
        process.send({ status: 'error', workerId: process.env.WORKER_ID, error: err.message });
      }
      process.exit(1);
    }
  })();
}

function runLockHolder() {
  (async () => {
    const lockPath = process.env.LOCK_PATH;
    const holdMs = parseInt(process.env.HOLD_MS || '2000', 10);
    const lock = new FileLock(lockPath, { leaseMs: 4000 });

    try {
      await lock.acquire(5000);
      if (process.send) {
        process.send({ status: 'acquired', pid: process.pid });
      }

      await new Promise(r => setTimeout(r, holdMs));
      lock.release();
      if (process.send) {
        process.send({ status: 'released', pid: process.pid });
      }
      process.exit(0);
    } catch (err) {
      console.error(`[LockHolder] Error: ${err.message}`);
      process.exit(1);
    }
  })();
}

if (process.env.CHALLENGER_ROLE === 'concurrency_worker') {
  runConcurrencyWorker();
} else if (process.env.CHALLENGER_ROLE === 'lock_holder') {
  runLockHolder();
} else {
  // Main test suite execution
  const suite = new TestSuite('M2 Concurrency, Lock & Snapshot Recovery Stress Suite (challenger_m2_1)');
  const crewCli = path.resolve(__dirname, '../../bin/crew.js');

  // --------------------------------------------------------------------------
  // 1. CONCURRENCY STRESS TESTS
  // --------------------------------------------------------------------------

  suite.test('Concurrency: 4 concurrent worker processes append 25 events each simultaneously', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-c4-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const lockPath = path.join(crewDir, 'ledger.lock');

    const workerCount = 4;
    const eventsPerWorker = 25;
    const totalExpected = workerCount * eventsPerWorker;

    try {
      const workerPromises = [];

      for (let w = 1; w <= workerCount; w++) {
        const workerId = `w4_${w}`;
        const p = new Promise((resolve, reject) => {
          const child = fork(__filename, [], {
            env: Object.assign({}, process.env, {
              CHALLENGER_ROLE: 'concurrency_worker',
              LEDGER_PATH: ledgerPath,
              LOCK_PATH: lockPath,
              WORKER_ID: workerId,
              EVENT_COUNT: String(eventsPerWorker)
            }),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
          });

          let stderr = '';
          child.stderr.on('data', d => { stderr += d.toString(); });

          child.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`Worker ${workerId} failed with exit code ${code}: ${stderr}`));
          });
        });
        workerPromises.push(p);
      }

      await Promise.all(workerPromises);

      const ledger = new EventLedger({ ledgerPath, lockPath });
      const events = ledger.readEvents();

      assert.equal(events.length, totalExpected, `Must record exactly ${totalExpected} events (0 lost records)`);

      const seenSeqs = new Set();
      for (let i = 0; i < events.length; i++) {
        const expectedSeq = i + 1;
        const actualSeq = events[i].seq !== undefined ? events[i].seq : events[i].id;
        assert.equal(actualSeq, expectedSeq, `Event index ${i} must have monotonic seq ${expectedSeq}`);
        assert.ok(!seenSeqs.has(actualSeq), `Sequence collision detected at ${actualSeq}`);
        seenSeqs.add(actualSeq);
      }

      const integrity = ledger.verifyChainIntegrity();
      assert.equal(integrity.valid, true, `Chain integrity must be valid: ${integrity.reason}`);
      assert.equal(integrity.count, totalExpected, `Integrity count must match total events`);

      for (let w = 1; w <= workerCount; w++) {
        const workerId = `w4_${w}`;
        const workerEvents = events.filter(e => e.actor === `agent:${workerId}`);
        assert.equal(workerEvents.length, eventsPerWorker, `Worker ${workerId} must have recorded ${eventsPerWorker} events`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  suite.test('Concurrency: 6 concurrent worker processes under high contention (120 events total)', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-c6-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const lockPath = path.join(crewDir, 'ledger.lock');

    const workerCount = 6;
    const eventsPerWorker = 20;
    const totalExpected = workerCount * eventsPerWorker;

    try {
      const workerPromises = [];

      for (let w = 1; w <= workerCount; w++) {
        const workerId = `w6_${w}`;
        const p = new Promise((resolve, reject) => {
          const child = fork(__filename, [], {
            env: Object.assign({}, process.env, {
              CHALLENGER_ROLE: 'concurrency_worker',
              LEDGER_PATH: ledgerPath,
              LOCK_PATH: lockPath,
              WORKER_ID: workerId,
              EVENT_COUNT: String(eventsPerWorker)
            }),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
          });

          let stderr = '';
          child.stderr.on('data', d => { stderr += d.toString(); });

          child.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`Worker ${workerId} exited with ${code}: ${stderr}`));
          });
        });
        workerPromises.push(p);
      }

      await Promise.all(workerPromises);

      const ledger = new EventLedger({ ledgerPath, lockPath });
      const events = ledger.readEvents();

      assert.equal(events.length, totalExpected, `Expected ${totalExpected} events, got ${events.length}`);
      const integrity = ledger.verifyChainIntegrity();
      assert.equal(integrity.valid, true, `Chain integrity failed: ${integrity.reason}`);
      assert.equal(integrity.count, totalExpected);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  suite.test('Concurrency: 4 concurrent CLI processes appending via bin/crew.js ledger append simultaneously', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-cli-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const snapshotPath = path.join(crewDir, 'snapshot.json');

    const workerCount = 4;
    const eventsPerWorker = 8;
    const totalExpected = workerCount * eventsPerWorker;

    try {
      const cliTasks = [];

      for (let w = 1; w <= workerCount; w++) {
        const workerId = `cli_w_${w}`;
        const task = (async () => {
          for (let i = 0; i < eventsPerWorker; i++) {
            const payload = JSON.stringify({
              id: `job_${workerId}_${i}`,
              title: `Job ${i} by ${workerId}`,
              company: 'TechCorp',
              url: `https://techcorp.com/jobs/${workerId}/${i}`
            });

            const res = spawnSync(process.execPath, [
              crewCli, 'ledger', 'append',
              '--event', 'JOB_DISCOVERED',
              '--payload', payload,
              '--actor', `agent:${workerId}`,
              '--workspace', tmpDir
            ], { encoding: 'utf8' });

            if (res.status !== 0) {
              throw new Error(`CLI append failed for ${workerId} event ${i}: ${res.stderr || res.stdout}`);
            }

            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 8) + 1));
          }
        })();
        cliTasks.push(task);
      }

      await Promise.all(cliTasks);

      const ledger = new EventLedger({ ledgerPath });
      const events = ledger.readEvents();
      assert.equal(events.length, totalExpected, `CLI workers must record all ${totalExpected} events without loss`);

      const integrity = ledger.verifyChainIntegrity();
      assert.equal(integrity.valid, true, `Chain integrity must be valid: ${integrity.reason}`);
      assert.equal(integrity.count, totalExpected);

      assert.ok(fs.existsSync(snapshotPath), 'Snapshot must exist after CLI appends');
      const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      assert.equal(snap.lastEventId, totalExpected, 'Snapshot lastEventId must match total event count');
      assert.equal(Object.keys(snap.jobs).length, totalExpected, 'Snapshot must contain all jobs');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 2. STALE LOCK RECOVERY & ANTI-THEFT TESTS
  // --------------------------------------------------------------------------

  suite.test('Stale Lock: Recovers immediately when lockfile has a dead PID (even with future expiration)', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-deadpid-'));
    const lockPath = path.join(tmpDir, 'ledger.lock');

    try {
      const deadProcess = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      const deadPid = deadProcess.pid;
      assert.ok(deadPid > 0, 'Must obtain a valid PID from dead process');

      const now = Date.now();
      const staleLockPayload = {
        pid: deadPid,
        hostname: os.hostname(),
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        time: now
      };
      fs.writeFileSync(lockPath, JSON.stringify(staleLockPayload), 'utf8');

      const lock = new FileLock(lockPath, { leaseMs: 3000 });
      const acquired = await lock.acquire(2000);

      assert.equal(acquired, true, 'Lock must be acquired by recovering stale dead-PID lock');
      assert.equal(lock.acquired, true);

      const currentPayload = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.equal(currentPayload.pid, process.pid, 'Lockfile must be updated with current live PID');

      lock.release();
      assert.equal(fs.existsSync(lockPath), false, 'Lockfile must be cleaned up after release');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  suite.test('Live Lock Protection: Lock held by live active process is NOT stolen under contention', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-livelock-'));
    const lockPath = path.join(tmpDir, 'ledger.lock');

    try {
      const child = fork(__filename, [], {
        env: Object.assign({}, process.env, {
          CHALLENGER_ROLE: 'lock_holder',
          LOCK_PATH: lockPath,
          HOLD_MS: '2500'
        }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });

      await new Promise((resolve, reject) => {
        child.on('message', msg => {
          if (msg && msg.status === 'acquired') resolve(msg);
        });
        child.on('error', reject);
        setTimeout(() => reject(new Error('Child failed to acquire lock in time')), 3000);
      });

      assert.ok(fs.existsSync(lockPath), 'Lockfile must exist on disk');
      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.equal(lockData.pid, child.pid, 'Lockfile PID must belong to child process');

      const contenderLock = new FileLock(lockPath, { leaseMs: 3000 });
      let errorCaught = null;
      try {
        await contenderLock.acquire(350);
      } catch (err) {
        errorCaught = err;
      }

      assert.ok(errorCaught !== null, 'Acquisition must fail and throw timeout error while live process holds lock');
      assert.ok(errorCaught.message.includes('contention timeout') || errorCaught.message.includes('Failed to acquire lock'),
        `Error message must indicate contention timeout: ${errorCaught.message}`);

      assert.ok(fs.existsSync(lockPath), 'Lockfile must still exist');
      const lockDataAfter = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.equal(lockDataAfter.pid, child.pid, 'Lock must NOT have been stolen from child process');

      await new Promise(resolve => child.on('exit', resolve));
      assert.equal(fs.existsSync(lockPath), false, 'Lockfile should be unlinked after child release');

      const parentAcquired = await contenderLock.acquire(1000);
      assert.equal(parentAcquired, true, 'Parent must be able to acquire lock after child releases');
      contenderLock.release();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  suite.test('Stale Lock: Recovers when lockfile has expired lease (past expiresAt)', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-expired-'));
    const lockPath = path.join(tmpDir, 'ledger.lock');

    try {
      const expiredPayload = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 10000).toISOString(),
        expiresAt: new Date(Date.now() - 5000).toISOString(),
        time: Date.now() - 10000
      };
      fs.writeFileSync(lockPath, JSON.stringify(expiredPayload), 'utf8');

      const lock = new FileLock(lockPath, { leaseMs: 3000 });
      const acquired = await lock.acquire(1500);

      assert.equal(acquired, true, 'Expired lease must be recovered');
      lock.release();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  suite.test('Doctor Stale Lock Recovery: crew doctor --fix identifies and purges stale lockfile', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-doclock-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const lockPath = path.join(crewDir, 'ledger.lock');

    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, hostname: os.hostname(), time: Date.now() - 10000 }), 'utf8');
      const oldTime = (Date.now() - 15000) / 1000;
      fs.utimesSync(lockPath, oldTime, oldTime);

      const docRes = spawnSync(process.execPath, [crewCli, 'doctor', '--workspace', tmpDir], { encoding: 'utf8' });
      assert.ok(docRes.stdout.includes('STALE LOCK DETECTED'), `Doctor must flag stale lock: ${docRes.stdout}`);
      assert.ok(fs.existsSync(lockPath), 'Lockfile must still exist before --fix');

      const fixRes = spawnSync(process.execPath, [crewCli, 'doctor', '--fix', '--workspace', tmpDir], { encoding: 'utf8' });
      assert.ok(fixRes.stdout.includes('STALE LOCK REMOVED'), `Doctor --fix must remove stale lock: ${fixRes.stdout}`);
      assert.equal(fs.existsSync(lockPath), false, 'Lockfile must be unlinked after doctor --fix');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  suite.test('Lock Stability: 50 sequential withLock calls under rapid succession with zero deadlock', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-rapidlock-'));
    const lockPath = path.join(tmpDir, 'rapid.lock');

    try {
      let counter = 0;
      for (let i = 0; i < 50; i++) {
        await withLock(async () => {
          counter++;
        }, { lockPath, timeoutMs: 3000 });
      }

      assert.equal(counter, 50, 'All 50 withLock operations must complete');
      assert.equal(fs.existsSync(lockPath), false, 'Lock must be fully released at end');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 3. SNAPSHOT CORRUPTION & RECOVERY TESTS
  // --------------------------------------------------------------------------

  suite.test('Snapshot Recovery: Corrupted snapshot.json is recovered via crew ledger replay --rebuild', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-snapcorrupt-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const snapshotPath = path.join(crewDir, 'snapshot.json');

    try {
      const ledger = new EventLedger({ ledgerPath });

      await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_rec_1', title: 'Security Architect', company: 'DefCorp', url: 'https://defcorp.com/1' }
      });
      await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_rec_2', title: 'Staff Engineer', company: 'CloudCorp', url: 'https://cloudcorp.com/2' }
      });
      await ledger.appendEvent({
        event: 'JOB_TRIAGED',
        payload: { id: 'job_rec_1', score: 4.8, status: 'shortlisted' }
      });
      await ledger.appendEvent({
        event: 'JOB_TRIAGED',
        payload: { id: 'job_rec_2', score: 3.2, status: 'parked' }
      });
      await ledger.appendEvent({
        event: 'JOB_SELECTED',
        payload: { jobId: 'job_rec_1', decisionId: 'dec_101', decisionType: 'apply' },
        actor: 'human:owner'
      });

      await replayLedger({ workspaceDir: tmpDir, rebuild: true });
      assert.ok(fs.existsSync(snapshotPath), 'Initial snapshot must exist');

      fs.writeFileSync(snapshotPath, '{"version": 1, "lastEventId": 5, "jobs": {"job_rec_1": {MALFORMED_TRUNCATED_JSON...', 'utf8');

      const res = spawnSync(process.execPath, [crewCli, 'ledger', 'replay', '--rebuild', '--workspace', tmpDir], {
        encoding: 'utf8'
      });

      assert.equal(res.status, 0, `crew ledger replay --rebuild must exit 0: ${res.stderr || res.stdout}`);
      assert.ok(res.stdout.includes('rebuilt') || res.stdout.includes('OK'), `Output must confirm rebuild: ${res.stdout}`);

      const recoveredContent = fs.readFileSync(snapshotPath, 'utf8');
      const recoveredState = JSON.parse(recoveredContent);

      assert.equal(recoveredState.lastEventId, 5, 'Recovered snapshot must have lastEventId 5');
      assert.ok(recoveredState.jobs['job_rec_1'], 'job_rec_1 must exist in recovered state');
      assert.equal(recoveredState.jobs['job_rec_1'].status, 'selected', 'job_rec_1 status must be selected');
      assert.equal(recoveredState.jobs['job_rec_2'].status, 'parked', 'job_rec_2 status must be parked');
      assert.equal(recoveredState.decisions.length, 1, 'decisions array must contain 1 decision');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  suite.test('Snapshot Recovery: Deleted snapshot.json is recreated via crew ledger replay --rebuild', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-snapdelete-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const snapshotPath = path.join(crewDir, 'snapshot.json');

    try {
      const ledger = new EventLedger({ ledgerPath });
      await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_del_1', title: 'Data Lead', company: 'Nova', url: 'https://nova.com/1' }
      });
      await ledger.appendEvent({
        event: 'JOB_TRIAGED',
        payload: { id: 'job_del_1', score: 4.5, status: 'shortlisted' }
      });

      if (fs.existsSync(snapshotPath)) {
        fs.unlinkSync(snapshotPath);
      }
      assert.equal(fs.existsSync(snapshotPath), false, 'snapshot.json must not exist before replay');

      const res = spawnSync(process.execPath, [crewCli, 'ledger', 'replay', '--rebuild', '--workspace', tmpDir], {
        encoding: 'utf8'
      });

      assert.equal(res.status, 0, `crew ledger replay --rebuild must exit 0: ${res.stderr || res.stdout}`);
      assert.ok(fs.existsSync(snapshotPath), 'snapshot.json must be recreated on disk');

      const state = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      assert.equal(state.lastEventId, 2);
      assert.equal(state.jobs['job_del_1'].title, 'Data Lead');
      assert.equal(state.jobs['job_del_1'].status, 'shortlisted');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  suite.test('Snapshot Recovery: Corrupted snapshot.json is gracefully recovered during regular replay without --rebuild', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-snapfallback-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const snapshotPath = path.join(crewDir, 'snapshot.json');

    try {
      const ledger = new EventLedger({ ledgerPath });
      await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_fb_1', title: 'Solutions Architect', company: 'Orbit', url: 'https://orbit.com/1' }
      });

      fs.writeFileSync(snapshotPath, 'GARBAGE_UNPARSEABLE_DATA_CORRUPTION', 'utf8');

      const res = spawnSync(process.execPath, [crewCli, 'ledger', 'replay', '--workspace', tmpDir], {
        encoding: 'utf8'
      });

      assert.equal(res.status, 0, `Regular replay must recover from corrupt snapshot without crashing: ${res.stderr || res.stdout}`);

      const state = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      assert.equal(state.lastEventId, 1);
      assert.equal(state.jobs['job_fb_1'].title, 'Solutions Architect');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  module.exports = suite;

  if (require.main === module) {
    suite.run({ verbose: true }).then(res => {
      process.exit(res.failed > 0 ? 1 : 0);
    });
  }
}
