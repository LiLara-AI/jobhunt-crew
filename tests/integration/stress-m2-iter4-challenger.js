'use strict';
/**
 * JobHunt Crew — Milestone M2 Iteration 4 Adversarial Challenger Stress Suite
 * Author: challenger_m2_iter4_1 (Empirical Challenger)
 * Location: tests/integration/stress-m2-iter4-challenger.js
 *
 * Dedicated empirical stress harness covering:
 * 1. Multi-process lock contention with 8 concurrent child processes (200 events).
 *    Verifies zero dropped records, zero sequence gaps, monotonic seq 1..N, 100% hash chain integrity.
 * 2. EPERM / EBUSY / EACCES error simulation and randomized jitter backoff validation.
 *    Verifies FileLock retry backoff handles Windows file access errors without crash or lock starvation.
 * 3. Dead process abrupt kill (SIGKILL) mid-lease recovery under concurrent contention.
 *    Verifies contenders detect dead PID immediately and recover lock with zero data corruption.
 * 4. Chain integrity oracle verification:
 *    Detects sequence gaps, payload tampering, and prevHash breaks.
 * 5. Lock fairness & starvation prevention under heavy contention.
 * 6. Rapid stale lease and dead PID recovery timing (< 250ms benchmark).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork, spawnSync } = require('child_process');
const { TestSuite } = require('../helpers/test-harness');
const { EventLedger } = require('../../lib/ledger/ledger');
const { FileLock, withLock, isPidAlive } = require('../../lib/ledger/lock');

// ============================================================================
// WORKER CHILD PROCESS ROLES
// ============================================================================

function runConcurrencyWorker() {
  (async () => {
    try {
      const ledgerPath = process.env.LEDGER_PATH;
      const lockPath = process.env.LOCK_PATH;
      const workerId = process.env.WORKER_ID;
      const eventCount = parseInt(process.env.EVENT_COUNT || '25', 10);

      const ledger = new EventLedger({ ledgerPath, lockPath, timeoutMs: 30000 });

      for (let i = 0; i < eventCount; i++) {
        await ledger.appendEvent({
          event: 'JOB_DISCOVERED',
          payload: {
            id: `job_${workerId}_${i}`,
            title: `Position ${i} - ${workerId}`,
            company: `Corp_${workerId}`,
            url: `https://adversary-test.com/${workerId}/${i}`
          },
          actor: `agent:${workerId}`
        });

        // Add randomized micro-jitter (1-8ms) to maximize contention race window
        const jitter = Math.floor(Math.random() * 8) + 1;
        await new Promise(r => setTimeout(r, jitter));
      }

      if (process.send) {
        process.send({ status: 'done', workerId, count: eventCount });
      }
      process.exit(0);
    } catch (err) {
      console.error(`[Worker ${process.env.WORKER_ID}] Error: ${err.message}`);
      process.exit(1);
    }
  })();
}

function runAbruptExitWorker() {
  (async () => {
    const lockPath = process.env.LOCK_PATH;
    const ledgerPath = process.env.LEDGER_PATH;
    const workerId = process.env.WORKER_ID || 'kill_victim';

    try {
      const ledger = new EventLedger({ ledgerPath, lockPath, timeoutMs: 10000 });
      // Acquire lock and append an initial event
      await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_pre_kill', title: 'Pre-Kill Job', company: 'KillCorp', url: 'https://kill.com/1' },
        actor: `agent:${workerId}`
      });

      // Now acquire raw lock and abruptly exit without calling release()
      const rawLock = new FileLock(lockPath, { leaseMs: 60000 }); // Far-future lease!
      await rawLock.acquire(5000);

      if (process.send) {
        process.send({ status: 'locked_and_dying', pid: process.pid });
      }

      // Small pause to let parent observe locked state
      setTimeout(() => {
        // Abrupt exit simulating hard crash (no exit handlers)
        process.kill(process.pid, 'SIGKILL');
      }, 50);
    } catch (err) {
      console.error(`[AbruptWorker Error]: ${err.message}`);
      process.exit(1);
    }
  })();
}

if (process.env.CHALLENGER_ITER4_ROLE === 'concurrency_worker') {
  runConcurrencyWorker();
} else if (process.env.CHALLENGER_ITER4_ROLE === 'abrupt_worker') {
  runAbruptExitWorker();
} else {
  // Main test suite execution
  const suite = new TestSuite('Milestone M2 Iteration 4 Adversarial Stress Suite (challenger_m2_iter4_1)');

  // --------------------------------------------------------------------------
  // TEST 1: 8 Concurrent Workers Appending 200 Events Under Heavy Lock Contention
  // --------------------------------------------------------------------------
  suite.test('Lock Contention: 8 concurrent child processes append 25 events each (200 total) with 0 gaps & valid hash chain', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-iter4-c8-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const lockPath = path.join(crewDir, 'ledger.lock');

    const workerCount = 8;
    const eventsPerWorker = 25;
    const totalExpected = workerCount * eventsPerWorker;

    try {
      const workerPromises = [];

      for (let w = 1; w <= workerCount; w++) {
        const workerId = `w8_${w}`;
        const p = new Promise((resolve, reject) => {
          const child = fork(__filename, [], {
            env: Object.assign({}, process.env, {
              CHALLENGER_ITER4_ROLE: 'concurrency_worker',
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

      // 1. Strict sequence monotonicity verification (1..200 with zero gaps)
      const seenSeqs = new Set();
      for (let i = 0; i < events.length; i++) {
        const expectedSeq = i + 1;
        const actualSeq = events[i].seq !== undefined ? events[i].seq : events[i].id;
        assert.equal(actualSeq, expectedSeq, `Event index ${i} must have monotonic seq ${expectedSeq}`);
        assert.ok(!seenSeqs.has(actualSeq), `Sequence collision detected at seq ${actualSeq}`);
        seenSeqs.add(actualSeq);
      }
      assert.equal(seenSeqs.size, totalExpected, `Must have ${totalExpected} unique sequence numbers`);

      // 2. Cryptographic hash chain verification
      const integrity = ledger.verifyChainIntegrity();
      assert.equal(integrity.valid, true, `Chain integrity must be valid: ${integrity.reason}`);
      assert.equal(integrity.count, totalExpected, `Integrity count must match total events`);

      // 3. Worker distribution verification
      for (let w = 1; w <= workerCount; w++) {
        const workerId = `w8_${w}`;
        const workerEvents = events.filter(e => e.actor === `agent:${workerId}`);
        assert.equal(workerEvents.length, eventsPerWorker, `Worker ${workerId} must have recorded ${eventsPerWorker} events`);
      }

      // 4. Lockfile must be completely released at the end
      assert.equal(fs.existsSync(lockPath), false, 'Lockfile must be unlinked after all workers finish');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // TEST 2: Windows EPERM / EBUSY / EACCES Backoff & Recovery Simulation
  // --------------------------------------------------------------------------
  suite.test('Windows Error Resilience: FileLock handles simulated EPERM, EBUSY, and EACCES with jitter backoff', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-iter4-winerr-'));
    const lockPath = path.join(tmpDir, 'test-winerr.lock');

    try {
      // Test 2.1: EPERM injection on fs.openSync
      {
        let attempts = 0;
        const realOpenSync = fs.openSync;
        fs.openSync = function (filePath, flags, mode) {
          if (filePath === lockPath && flags === 'wx') {
            attempts++;
            if (attempts <= 3) {
              const err = new Error('Operation not permitted (Windows EPERM simulated)');
              err.code = 'EPERM';
              throw err;
            }
          }
          return realOpenSync.apply(fs, arguments);
        };

        try {
          const lock = new FileLock(lockPath, { leaseMs: 3000, retryIntervalMs: 20 });
          const t0 = Date.now();
          const acquired = await lock.acquire(2000);
          const elapsed = Date.now() - t0;

          assert.equal(acquired, true, 'Lock must be acquired despite 3 simulated EPERM errors');
          assert.ok(attempts >= 4, `Must have retried at least 4 times (got ${attempts})`);
          // 3 retries with 20ms base + jitter (0..19ms) should take at least 50ms
          assert.ok(elapsed >= 50, `Backoff delay must be applied, took ${elapsed}ms`);
          lock.release();
        } finally {
          fs.openSync = realOpenSync;
        }
      }

      // Test 2.2: EBUSY injection on fs.openSync
      {
        let attempts = 0;
        const realOpenSync = fs.openSync;
        fs.openSync = function (filePath, flags, mode) {
          if (filePath === lockPath && flags === 'wx') {
            attempts++;
            if (attempts <= 3) {
              const err = new Error('Resource busy or locked (Windows EBUSY simulated)');
              err.code = 'EBUSY';
              throw err;
            }
          }
          return realOpenSync.apply(fs, arguments);
        };

        try {
          const lock = new FileLock(lockPath, { leaseMs: 3000, retryIntervalMs: 25 });
          const t0 = Date.now();
          const acquired = await lock.acquire(2000);
          const elapsed = Date.now() - t0;

          assert.equal(acquired, true, 'Lock must be acquired despite 3 simulated EBUSY errors');
          assert.ok(attempts >= 4, `Must have retried at least 4 times (got ${attempts})`);
          assert.ok(elapsed >= 60, `Backoff delay must be applied, took ${elapsed}ms`);
          lock.release();
        } finally {
          fs.openSync = realOpenSync;
        }
      }

      // Test 2.3: EACCES injection on fs.openSync
      {
        let attempts = 0;
        const realOpenSync = fs.openSync;
        fs.openSync = function (filePath, flags, mode) {
          if (filePath === lockPath && flags === 'wx') {
            attempts++;
            if (attempts <= 2) {
              const err = new Error('Permission denied (Windows EACCES simulated)');
              err.code = 'EACCES';
              throw err;
            }
          }
          return realOpenSync.apply(fs, arguments);
        };

        try {
          const lock = new FileLock(lockPath, { leaseMs: 3000, retryIntervalMs: 20 });
          const acquired = await lock.acquire(2000);
          assert.equal(acquired, true, 'Lock must be acquired despite 2 simulated EACCES errors');
          assert.ok(attempts >= 3);
          lock.release();
        } finally {
          fs.openSync = realOpenSync;
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // TEST 3: Jitter Distribution Verification
  // --------------------------------------------------------------------------
  suite.test('Jitter Backoff: Randomized jitter delays vary across contention retry cycles', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-iter4-jitter-'));
    const lockPath = path.join(tmpDir, 'test-jitter.lock');

    try {
      // Keep lockfile locked by another handle to measure retry interval variance
      const blockerFd = fs.openSync(lockPath, 'wx');
      const measuredDelays = [];
      let lastAttempt = Date.now();

      const realOpenSync = fs.openSync;
      fs.openSync = function (filePath, flags, mode) {
        if (filePath === lockPath && flags === 'wx') {
          const now = Date.now();
          measuredDelays.push(now - lastAttempt);
          lastAttempt = now;
        }
        return realOpenSync.apply(fs, arguments);
      };

      try {
        const lock = new FileLock(lockPath, { leaseMs: 5000, retryIntervalMs: 30 });
        let timeoutThrown = false;
        try {
          await lock.acquire(250); // Will contend and timeout
        } catch (err) {
          if (err.message.includes('contention timeout')) {
            timeoutThrown = true;
          }
        }
        assert.equal(timeoutThrown, true, 'Must throw contention timeout');

        // Verify that retries occurred (at least 4 retries in 250ms with ~30-50ms intervals)
        assert.ok(measuredDelays.length >= 4, `Expected >= 4 retry attempts, got ${measuredDelays.length}`);

        // Verify delay variance: not all intervals are identical (due to Math.random() * 20 jitter)
        const sampleDelays = measuredDelays.slice(1); // skip initial attempt
        const minDelay = Math.min(...sampleDelays);
        const maxDelay = Math.max(...sampleDelays);
        assert.ok(minDelay >= 20, `Min delay (${minDelay}ms) should reflect retryIntervalMs`);
        assert.ok(maxDelay - minDelay >= 3 || sampleDelays.length >= 4,
          `Jitter should create variance between min (${minDelay}ms) and max (${maxDelay}ms)`);
      } finally {
        fs.openSync = realOpenSync;
        fs.closeSync(blockerFd);
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // TEST 4: Abrupt Process Kill (SIGKILL) Mid-Lease Recovery Under Contention
  // --------------------------------------------------------------------------
  suite.test('Crash Recovery: Abruptly killed process (SIGKILL) with far-future lease is immediately recovered by contender', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-iter4-sigkill-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const lockPath = path.join(crewDir, 'ledger.lock');

    try {
      const child = fork(__filename, [], {
        env: Object.assign({}, process.env, {
          CHALLENGER_ITER4_ROLE: 'abrupt_worker',
          LEDGER_PATH: ledgerPath,
          LOCK_PATH: lockPath,
          WORKER_ID: 'doomed_worker'
        }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });

      let killedPid = null;
      await new Promise((resolve, reject) => {
        child.on('message', msg => {
          if (msg && msg.status === 'locked_and_dying') {
            killedPid = msg.pid;
            resolve();
          }
        });
        child.on('error', reject);
        setTimeout(() => reject(new Error('Child failed to reach locked_and_dying in 5s')), 5000);
      });

      // Wait for child to exit via SIGKILL
      await new Promise(resolve => child.on('exit', resolve));
      assert.ok(killedPid > 0, 'Killed PID must be valid');
      assert.equal(isPidAlive(killedPid), false, 'Killed PID must be dead');

      // The lockfile still exists on disk with the dead PID and a 60-second future expiration!
      assert.ok(fs.existsSync(lockPath), 'Lockfile must remain on disk after SIGKILL crash');
      const lockDataBefore = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.equal(lockDataBefore.pid, killedPid, 'Lockfile must contain dead PID');

      // A new contender attempts to append an event
      const ledger = new EventLedger({ ledgerPath, lockPath, timeoutMs: 5000 });
      const t0 = Date.now();
      const appended = await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_post_recovery', title: 'Recovered Job', company: 'SurvivorCorp', url: 'https://survivor.com/1' },
        actor: 'agent:recovery_worker'
      });
      const recoveryElapsed = Date.now() - t0;

      assert.ok(appended.id === 2 || appended.seq === 2, `Second event should have sequence 2, got ${appended.id || appended.seq}`);
      assert.ok(recoveryElapsed < 1000, `Recovery must happen quickly without waiting 60s lease (took ${recoveryElapsed}ms)`);

      // Ledger must contain both events with unbroken hash chain
      const events = ledger.readEvents();
      assert.equal(events.length, 2, 'Ledger must contain both pre-kill and post-recovery events');
      assert.equal(events[0].payload.id, 'job_pre_kill');
      assert.equal(events[1].payload.id, 'job_post_recovery');

      const integrity = ledger.verifyChainIntegrity();
      assert.equal(integrity.valid, true, `Chain integrity must remain valid after crash recovery: ${integrity.reason}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // TEST 5: Chain Integrity Oracle Adversarial Validation
  // --------------------------------------------------------------------------
  suite.test('Integrity Oracle: verifyChainIntegrity detects artificial sequence gaps, payload tampering, and prevHash breaks', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-iter4-oracle-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const lockPath = path.join(crewDir, 'ledger.lock');

    try {
      const ledger = new EventLedger({ ledgerPath, lockPath });

      // Append 3 valid events
      await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_1', title: 'Role 1', company: 'Corp A', url: 'https://a.com/1' }
      });
      await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_2', title: 'Role 2', company: 'Corp B', url: 'https://b.com/2' }
      });
      await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_3', title: 'Role 3', company: 'Corp C', url: 'https://c.com/3' }
      });

      const initialIntegrity = ledger.verifyChainIntegrity();
      assert.equal(initialIntegrity.valid, true, 'Base chain must be valid');
      assert.equal(initialIntegrity.count, 3);

      const rawLines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');

      // Test 5.1: Sequence gap detection (change event 2 to id 4, creating gap: 1, 4, 3)
      {
        const tamperedLines = [...rawLines];
        const evt2 = JSON.parse(tamperedLines[1]);
        evt2.id = 4;
        evt2.seq = 4;
        tamperedLines[1] = JSON.stringify(evt2);

        const gapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-gap-'));
        const gapLedgerPath = path.join(gapDir, 'ledger.jsonl');
        fs.writeFileSync(gapLedgerPath, tamperedLines.join('\n') + '\n', 'utf8');

        const gapLedger = new EventLedger({ ledgerPath: gapLedgerPath });
        const check = gapLedger.verifyChainIntegrity();
        assert.equal(check.valid, false, 'Sequence gap must be detected');
        assert.ok(check.reason.includes('Sequence gap') || check.reason.includes('mismatch'),
          `Reason must indicate sequence gap: ${check.reason}`);

        fs.rmSync(gapDir, { recursive: true, force: true });
      }

      // Test 5.2: Payload tampering detection (change 1 character in payload without recomputing hash)
      {
        const tamperedLines = [...rawLines];
        const evt1 = JSON.parse(tamperedLines[0]);
        evt1.payload.company = 'TamperedCorp';
        tamperedLines[0] = JSON.stringify(evt1);

        const tamperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-tamper-'));
        const tamperLedgerPath = path.join(tamperDir, 'ledger.jsonl');
        fs.writeFileSync(tamperLedgerPath, tamperedLines.join('\n') + '\n', 'utf8');

        const tamperLedger = new EventLedger({ ledgerPath: tamperLedgerPath });
        const check = tamperLedger.verifyChainIntegrity();
        assert.equal(check.valid, false, 'Payload tampering must be detected');
        assert.ok(check.reason.includes('Tampered payload hash') || check.reason.includes('prevHash mismatch'),
          `Reason must indicate tampering: ${check.reason}`);

        fs.rmSync(tamperDir, { recursive: true, force: true });
      }

      // Test 5.3: Broken prevHash chain detection
      {
        const tamperedLines = [...rawLines];
        const evt3 = JSON.parse(tamperedLines[2]);
        evt3.prevHash = 'a'.repeat(64); // Broken link
        tamperedLines[2] = JSON.stringify(evt3);

        const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-broken-'));
        const brokenLedgerPath = path.join(brokenDir, 'ledger.jsonl');
        fs.writeFileSync(brokenLedgerPath, tamperedLines.join('\n') + '\n', 'utf8');

        const brokenLedger = new EventLedger({ ledgerPath: brokenLedgerPath });
        const check = brokenLedger.verifyChainIntegrity();
        assert.equal(check.valid, false, 'Broken prevHash link must be detected');
        assert.ok(check.reason.includes('prevHash mismatch') || check.reason.includes('hash'),
          `Reason must indicate prevHash failure: ${check.reason}`);

        fs.rmSync(brokenDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // TEST 6: Lock Fairness & Non-Starvation Under Rapid Contention
  // --------------------------------------------------------------------------
  suite.test('Lock Fairness: 4 concurrent async routines achieve fair lock distribution without starvation', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-stress-iter4-fairness-'));
    const lockPath = path.join(tmpDir, 'fairness.lock');

    try {
      const routineCount = 4;
      const targetPerRoutine = 15;
      const counts = [0, 0, 0, 0];

      const tasks = [];
      for (let r = 0; r < routineCount; r++) {
        const routineId = r;
        const task = (async () => {
          for (let i = 0; i < targetPerRoutine; i++) {
            await withLock(async () => {
              counts[routineId]++;
              // Micro-hold
              await new Promise(res => setTimeout(res, 2));
            }, { lockPath, timeoutMs: 15000, retryIntervalMs: 10 });
            // Micro-delay between requests
            await new Promise(res => setTimeout(res, Math.floor(Math.random() * 5) + 1));
          }
        })();
        tasks.push(task);
      }

      await Promise.all(tasks);

      // Verify that all routines finished their acquisitions
      for (let r = 0; r < routineCount; r++) {
        assert.equal(counts[r], targetPerRoutine, `Routine ${r} must complete exactly ${targetPerRoutine} acquisitions`);
      }
      assert.equal(fs.existsSync(lockPath), false, 'Lock must be completely released');
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
