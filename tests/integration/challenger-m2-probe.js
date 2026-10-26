'use strict';
/**
 * JobHunt Crew — Adversarial Challenger M2 Iteration 2 Deep Probes
 * Author: challenger_m2_iter2_1 (Empirical Challenger)
 * Location: tests/integration/challenger-m2-probe.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork, spawnSync } = require('child_process');
const { TestSuite } = require('../helpers/test-harness');
const { EventLedger } = require('../../lib/ledger/ledger');
const { FileLock, withLock } = require('../../lib/ledger/lock');
const { replayLedger } = require('../../lib/ledger/reducer');

// Worker child process routines
function runWorker() {
  (async () => {
    try {
      const ledgerPath = process.env.LEDGER_PATH;
      const lockPath = process.env.LOCK_PATH;
      const workerId = process.env.WORKER_ID;
      const eventCount = parseInt(process.env.EVENT_COUNT || '25', 10);

      const ledger = new EventLedger({ ledgerPath, lockPath, timeoutMs: 25000 });

      for (let i = 0; i < eventCount; i++) {
        await ledger.appendEvent({
          event: 'JOB_DISCOVERED',
          payload: {
            id: `job_${workerId}_${i}`,
            title: `Challenger Role ${i} from ${workerId}`,
            company: `Corp_${workerId}`,
            url: `https://test-adversary.com/${workerId}/${i}`
          },
          actor: `agent:${workerId}`
        });

        // Micro-jitter to maximize lock acquisition race window
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

function runHeartbeatLockHolder() {
  (async () => {
    const lockPath = process.env.LOCK_PATH;
    const holdMs = parseInt(process.env.HOLD_MS || '3500', 10);
    const leaseMs = parseInt(process.env.LEASE_MS || '1500', 10);

    const lock = new FileLock(lockPath, { leaseMs });

    try {
      await lock.acquire(5000);
      if (process.send) {
        process.send({ status: 'acquired', pid: process.pid });
      }

      // Hold lock beyond initial leaseMs to test heartbeat renewal
      await new Promise(r => setTimeout(r, holdMs));

      lock.release();
      if (process.send) {
        process.send({ status: 'released', pid: process.pid });
      }
      process.exit(0);
    } catch (err) {
      console.error(`[HeartbeatHolder] Error: ${err.message}`);
      process.exit(1);
    }
  })();
}

if (process.env.CHALLENGER_PROBE_ROLE === 'worker') {
  runWorker();
} else if (process.env.CHALLENGER_PROBE_ROLE === 'heartbeat_holder') {
  runHeartbeatLockHolder();
} else {
  // Main test suite execution
  const suite = new TestSuite('Adversarial Challenger M2 Iteration 2 Deep Probes');
  const crewCli = path.resolve(__dirname, '../../bin/crew.js');

  // Probe 1: Extreme Multi-Process Concurrency (8 concurrent workers, 25 events = 200 events)
  suite.test('Probe 1: 8 concurrent workers append 25 events each (200 total) with zero loss & valid hash chain', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger-c8-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const lockPath = path.join(crewDir, 'ledger.lock');

    const workerCount = 8;
    const eventsPerWorker = 25;
    const totalExpected = workerCount * eventsPerWorker;

    try {
      const promises = [];
      for (let w = 1; w <= workerCount; w++) {
        const workerId = `w8_${w}`;
        const p = new Promise((resolve, reject) => {
          const child = fork(__filename, [], {
            env: Object.assign({}, process.env, {
              CHALLENGER_PROBE_ROLE: 'worker',
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
        promises.push(p);
      }

      await Promise.all(promises);

      const ledger = new EventLedger({ ledgerPath, lockPath });
      const events = ledger.readEvents();

      assert.equal(events.length, totalExpected, `Expected exactly ${totalExpected} events, got ${events.length}`);

      // Verify sequence monotonicity (1..200)
      for (let i = 0; i < events.length; i++) {
        const expectedSeq = i + 1;
        const actualSeq = events[i].seq !== undefined ? events[i].seq : events[i].id;
        assert.equal(actualSeq, expectedSeq, `Event at index ${i} must have sequence ${expectedSeq}`);
      }

      // Verify hash chain integrity
      const integrity = ledger.verifyChainIntegrity();
      assert.equal(integrity.valid, true, `Hash chain integrity must be valid: ${integrity.reason}`);
      assert.equal(integrity.count, totalExpected, 'Integrity event count must match total');

      // Verify each worker's event count
      for (let w = 1; w <= workerCount; w++) {
        const workerId = `w8_${w}`;
        const workerEvents = events.filter(e => e.actor === `agent:${workerId}`);
        assert.equal(workerEvents.length, eventsPerWorker, `Worker ${workerId} count mismatch`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Probe 2: High-contention CLI processes appending simultaneously
  suite.test('Probe 2: 6 concurrent CLI processes appending via bin/crew.js ledger append (60 total events)', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger-cli6-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const snapshotPath = path.join(crewDir, 'snapshot.json');

    const workerCount = 6;
    const eventsPerWorker = 10;
    const totalExpected = workerCount * eventsPerWorker;

    try {
      const tasks = [];
      for (let w = 1; w <= workerCount; w++) {
        const workerId = `cli6_${w}`;
        const task = (async () => {
          for (let i = 0; i < eventsPerWorker; i++) {
            const payload = JSON.stringify({
              id: `job_${workerId}_${i}`,
              title: `CLI Job ${i} by ${workerId}`,
              company: `Adversary Corp ${workerId}`,
              url: `https://adversary.com/${workerId}/${i}`
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

            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 6) + 1));
          }
        })();
        tasks.push(task);
      }

      await Promise.all(tasks);

      const ledger = new EventLedger({ ledgerPath });
      const events = ledger.readEvents();
      assert.equal(events.length, totalExpected, `CLI workers must record all ${totalExpected} events`);

      const integrity = ledger.verifyChainIntegrity();
      assert.equal(integrity.valid, true, `Chain integrity failed: ${integrity.reason}`);

      assert.ok(fs.existsSync(snapshotPath), 'Snapshot must exist');
      const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      assert.equal(snap.lastEventId, totalExpected);
      assert.equal(Object.keys(snap.jobs).length, totalExpected);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Probe 3: Live Lock Protection with Active Heartbeat Renewal
  suite.test('Probe 3: Lock held for 3500ms with leaseMs=1500ms is NOT stolen due to active heartbeat renewal', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger-heartbeat-'));
    const lockPath = path.join(tmpDir, 'ledger.lock');

    try {
      const child = fork(__filename, [], {
        env: Object.assign({}, process.env, {
          CHALLENGER_PROBE_ROLE: 'heartbeat_holder',
          LOCK_PATH: lockPath,
          HOLD_MS: '3500',
          LEASE_MS: '1500'
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

      // Wait 2200ms (exceeding initial 1500ms lease)
      await new Promise(r => setTimeout(r, 2200));

      // Inspect lockfile on disk to verify heartbeat updated expiresAt
      assert.ok(fs.existsSync(lockPath), 'Lockfile must exist on disk');
      const payloadMid = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.equal(payloadMid.pid, child.pid);
      const expiresAtMs = new Date(payloadMid.expiresAt).getTime();
      assert.ok(expiresAtMs > Date.now(), `expiresAt (${payloadMid.expiresAt}) must have been refreshed into the future by heartbeat`);

      // Attempt to acquire lock by contender — MUST fail with contention timeout
      const contender = new FileLock(lockPath, { leaseMs: 1500 });
      let contenderError = null;
      try {
        await contender.acquire(400);
      } catch (err) {
        contenderError = err;
      }
      assert.ok(contenderError !== null, 'Contender must NOT steal lock while active process holds it');

      // Wait for child to finish and release
      await new Promise(resolve => child.on('exit', resolve));
      assert.equal(fs.existsSync(lockPath), false, 'Lockfile must be unlinked after holder exits');

      // Now contender acquires cleanly
      const acquiredAfter = await contender.acquire(1000);
      assert.equal(acquiredAfter, true, 'Contender must acquire after release');
      contender.release();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Probe 4: Dead PID Stale Lock Recovery with Far-Future Expiration
  suite.test('Probe 4: Lockfile with dead PID and 24h future expiration is recovered immediately', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger-deadpid-'));
    const lockPath = path.join(tmpDir, 'ledger.lock');

    try {
      const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      const deadPid = dead.pid;

      const now = Date.now();
      const payload = {
        pid: deadPid,
        hostname: os.hostname(),
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 86400000).toISOString(), // 24 hours in future
        time: now
      };
      fs.writeFileSync(lockPath, JSON.stringify(payload), 'utf8');

      const lock = new FileLock(lockPath, { leaseMs: 3000 });
      const startTime = Date.now();
      const acquired = await lock.acquire(1500);
      const elapsed = Date.now() - startTime;

      assert.equal(acquired, true, 'Dead PID lock must be recovered');
      assert.ok(elapsed < 1000, `Recovery must happen immediately without waiting for lease (took ${elapsed}ms)`);

      lock.release();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Probe 5: Expired Lease Recovery
  suite.test('Probe 5: Lockfile with expired lease (past expiresAt) is safely recovered', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger-expired-'));
    const lockPath = path.join(tmpDir, 'ledger.lock');

    try {
      const payload = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 20000).toISOString(),
        expiresAt: new Date(Date.now() - 10000).toISOString(),
        time: Date.now() - 20000
      };
      fs.writeFileSync(lockPath, JSON.stringify(payload), 'utf8');

      const lock = new FileLock(lockPath, { leaseMs: 2000 });
      const acquired = await lock.acquire(1000);
      assert.equal(acquired, true, 'Expired lease must be recovered');
      lock.release();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Probe 6: Corrupted / Unparseable Lockfile Recovery Behavior (Empirical Exploration)
  suite.test('Probe 6 [CORRUPTED LOCK PROBE]: Tests behavior when lockfile has unparseable garbage text', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger-corrupt-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const lockPath = path.join(crewDir, 'ledger.lock');

    try {
      // Write unparseable garbage to lockfile and backdate mtime to 1 hour ago
      fs.writeFileSync(lockPath, 'UNPARSEABLE_GARBAGE_CRASH_DUMP', 'utf8');
      const oldTime = (Date.now() - 3600000) / 1000;
      fs.utimesSync(lockPath, oldTime, oldTime);

      const lock = new FileLock(lockPath, { leaseMs: 1000 });
      const isStaleResult = lock._isStale();

      // We document empirically what _isStale returns for unparseable lockfiles
      if (isStaleResult === false) {
        // Document vulnerability/characteristic: unparseable lockfile with old mtime is NOT recognized as stale by FileLock._isStale()
        // FileLock.acquire() will timeout trying to acquire unless crew doctor --fix is run.
        let timedOut = false;
        try {
          await lock.acquire(400);
        } catch (err) {
          timedOut = true;
        }
        assert.ok(timedOut, 'Observed behavior: unparseable lockfile cannot be recovered by acquire() directly due to JSON.parse failure returning false');

        // Check that crew doctor --fix detects and cleans the stale unparseable lockfile
        const docRes = spawnSync(process.execPath, [crewCli, 'doctor', '--fix', '--workspace', tmpDir], { encoding: 'utf8' });
        assert.ok(docRes.stdout.includes('STALE LOCK REMOVED'), `crew doctor --fix must report STALE LOCK REMOVED: ${docRes.stdout}`);
        assert.equal(fs.existsSync(lockPath), false, 'Lockfile must be unlinked after doctor --fix');

        // Now acquire succeeds after doctor fix
        const acquired = await lock.acquire(500);
        assert.equal(acquired, true, 'Acquisition succeeds after doctor --fix cleans unparseable lock');
        lock.release();
      } else {
        const acquired = await lock.acquire(500);
        assert.equal(acquired, true);
        lock.release();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Probe 7: Full Snapshot Reconstruction across all 15 Event Types
  suite.test('Probe 7: Reconstructs state from ledger containing all domain event types via replay --rebuild', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger-rebuild-all-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const snapshotPath = path.join(crewDir, 'snapshot.json');

    try {
      const ledger = new EventLedger({ ledgerPath });

      // 1. JOB_DISCOVERED
      await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_all_1', title: 'Principal Architect', company: 'GlobalTech', url: 'https://globaltech.com/p1?utm_source=test' }
      });

      // 2. JOB_TRIAGED
      await ledger.appendEvent({
        event: 'JOB_TRIAGED',
        payload: { id: 'job_all_1', score: 4.9, status: 'shortlisted', rationale: 'Strong fit' }
      });

      // 3. JOB_SELECTED
      await ledger.appendEvent({
        event: 'JOB_SELECTED',
        payload: { jobId: 'job_all_1', decisionId: 'dec_1', decisionType: 'apply' },
        actor: 'human:candidate'
      });

      // 4. DRAFT_GENERATED
      await ledger.appendEvent({
        event: 'DRAFT_GENERATED',
        payload: { jobId: 'job_all_1', cvText: 'Tailored CV', clText: 'Cover letter', claimsUsed: ['c_1', 'c_2'] }
      });

      // 5. CLAIMS_VERIFIED
      await ledger.appendEvent({
        event: 'CLAIMS_VERIFIED',
        payload: { jobId: 'job_all_1', passed: true, violationsCount: 0 }
      });

      // 6. BLIND_REVIEW_RECORDED
      await ledger.appendEvent({
        event: 'BLIND_REVIEW_RECORDED',
        payload: { jobId: 'job_all_1', verdict: 'APPROVE', score: 5.0, recruiterFeedback: 'Great' }
      });

      // 7. PACKAGE_MARKED_READY
      await ledger.appendEvent({
        event: 'PACKAGE_MARKED_READY',
        payload: {
          jobId: 'job_all_1',
          claimVerification: { passed: true },
          reviewPanel: { verdict: 'APPROVE' },
          applyPackUrl: 'Applications/GlobalTech_PrincipalArchitect/apply-pack.md'
        }
      });

      // 8. BROWSER_FORM_PREFILLED
      await ledger.appendEvent({
        event: 'BROWSER_FORM_PREFILLED',
        payload: { jobId: 'job_all_1', fieldsFilled: ['name', 'email', 'salary'], tabTitle: 'Workday Application' }
      });

      // 9. APPLICATION_SUBMITTED
      await ledger.appendEvent({
        event: 'APPLICATION_SUBMITTED',
        payload: { jobId: 'job_all_1', token: 'human-auth-token-123' },
        actor: 'human:candidate'
      });

      // 10. FOLLOW_UP_SCHEDULED
      await ledger.appendEvent({
        event: 'FOLLOW_UP_SCHEDULED',
        payload: { jobId: 'job_all_1', cadenceDay7: '2026-11-01', cadenceDay14: '2026-11-08' }
      });

      // 11. OUTREACH_DRAFTED
      await ledger.appendEvent({
        event: 'OUTREACH_DRAFTED',
        payload: { jobId: 'job_all_1', persona: 'hiring_manager', text: 'Hi, I applied...' }
      });

      // 12. OFFER_EVALUATED
      await ledger.appendEvent({
        event: 'OFFER_EVALUATED',
        payload: { jobId: 'job_all_1', baseSalarySar: 45000, housingAllowanceSar: 11250, grossTotalSar: 56250 }
      });

      // 13. HEALTH_RECORDED
      await ledger.appendEvent({
        event: 'HEALTH_RECORDED',
        payload: { component: 'connector_chrome', status: 'HEALTHY', message: 'All active' }
      });

      // 14. Second job discovered and closed with verifiable evidence
      await ledger.appendEvent({
        event: 'JOB_DISCOVERED',
        payload: { id: 'job_all_2', title: 'Legacy Role', company: 'OldCorp', url: 'https://oldcorp.com/2' }
      });

      // 15. JOB_CLOSED
      await ledger.appendEvent({
        event: 'JOB_CLOSED',
        payload: { id: 'job_all_2', reason: 'Role cancelled', evidence: { type: 'http_status_404', proof: 'HTTP 404 Not Found' } }
      });

      // Delete snapshot.json completely to test rebuild from scratch
      if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);

      const replayRes = spawnSync(process.execPath, [
        crewCli, 'ledger', 'replay', '--rebuild', '--workspace', tmpDir
      ], { encoding: 'utf8' });

      assert.equal(replayRes.status, 0, `Replay --rebuild failed: ${replayRes.stderr || replayRes.stdout}`);
      assert.ok(fs.existsSync(snapshotPath), 'Snapshot must be created by rebuild');

      const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      assert.equal(snap.lastEventId, 15, 'Rebuilt snapshot must have processed all 15 events');

      // Verify job 1 state
      const j1 = snap.jobs['job_all_1'];
      assert.ok(j1, 'job_all_1 must exist');
      assert.equal(j1.status, 'submitted');
      assert.equal(j1.canonicalUrl, 'https://globaltech.com/p1', 'URL tracking params must be stripped in projection');

      // Verify application 1 state
      const a1 = snap.applications['job_all_1'];
      assert.ok(a1, 'application for job_all_1 must exist');
      assert.equal(a1.status, 'submitted');
      assert.equal(a1.confirmedByHuman, true);
      assert.equal(a1.verification.passed, true);
      assert.equal(a1.review.verdict, 'APPROVE');
      assert.equal(a1.prefill.status, 'ready-to-submit');
      assert.equal(a1.offer.grossTotalSar, 56250);

      // Verify outreach
      assert.ok(snap.outreach['job_all_1'], 'outreach must exist');
      assert.equal(snap.outreach['job_all_1'].persona, 'hiring_manager');

      // Verify health
      assert.ok(snap.health['connector_chrome'], 'health must exist');
      assert.equal(snap.health['connector_chrome'].status, 'HEALTHY');

      // Verify job 2 closed
      const j2 = snap.jobs['job_all_2'];
      assert.ok(j2, 'job_all_2 must exist');
      assert.equal(j2.status, 'closed');
      assert.equal(j2.closureEvidence.type, 'http_status_404');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Probe 8: Replay Idempotency Check
  suite.test('Probe 8: Replaying twice yields byte-for-byte identical state projection', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger-idempotent-'));
    const crewDir = path.join(tmpDir, '.crew');
    fs.mkdirSync(crewDir, { recursive: true });
    const ledgerPath = path.join(crewDir, 'ledger.jsonl');
    const snapshotPath = path.join(crewDir, 'snapshot.json');

    try {
      const ledger = new EventLedger({ ledgerPath });
      for (let i = 1; i <= 5; i++) {
        await ledger.appendEvent({
          event: 'JOB_DISCOVERED',
          payload: { id: `idem_job_${i}`, title: `Idem Job ${i}`, company: 'Idem Corp', url: `https://idem.com/${i}` }
        });
      }

      await replayLedger({ workspaceDir: tmpDir, rebuild: true });
      const snap1 = fs.readFileSync(snapshotPath, 'utf8');

      await replayLedger({ workspaceDir: tmpDir, rebuild: true });
      const snap2 = fs.readFileSync(snapshotPath, 'utf8');

      assert.equal(snap1, snap2, 'Snapshot after two rebuild replays must be byte-for-byte identical');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Probe 9: Rapid concurrent withLock contention in single process
  suite.test('Probe 9: 50 concurrent async withLock operations complete with zero deadlock or race', async assert => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger-withlock-'));
    const lockPath = path.join(tmpDir, 'async.lock');

    try {
      let counter = 0;
      const tasks = [];
      for (let i = 0; i < 50; i++) {
        tasks.push(withLock(async () => {
          const current = counter;
          await new Promise(r => setTimeout(r, Math.floor(Math.random() * 5) + 1));
          counter = current + 1;
        }, { lockPath, timeoutMs: 10000 }));
      }

      await Promise.all(tasks);
      assert.equal(counter, 50, 'All 50 async withLock operations must execute mutually exclusively');
      assert.equal(fs.existsSync(lockPath), false, 'Lockfile must be unlinked at end');
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
