'use strict';
/**
 * Tier 2: Boundary & Corner Cases - Concurrent Writers & Atomic Lockfile
 * Simulates >= 4 concurrent workers appending events simultaneously via atomic lock.
 * Verifies zero data loss, zero file corruption, contiguous monotonic sequence numbers,
 * and valid cryptographic hash chaining.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const { EventLedger } = require('../../lib/ledger/ledger');
const { FileLock } = require('../../lib/ledger/lock');

const suite = new TestSuite('Tier 2: Concurrent Writers & Lock Contention');

let tempDir;
let ledgerPath;
let lockPath;

suite.test('Set up temporary isolated directory for concurrency test', assert => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-concurrent-'));
  ledgerPath = path.join(tempDir, 'ledger.jsonl');
  lockPath = path.join(tempDir, 'ledger.lock');
  assert.ok(fs.existsSync(tempDir));
});

suite.test('Simulate 4 concurrent workers writing 10 events each simultaneously', async assert => {
  const ledger = new EventLedger({ ledgerPath, lockPath, workspaceDir: tempDir });
  const workerCount = 4;
  const eventsPerWorker = 10;
  const totalExpectedEvents = workerCount * eventsPerWorker;

  const workerTasks = [];

  for (let w = 0; w < workerCount; w++) {
    const workerId = `worker_${w + 1}`;
    const task = (async () => {
      for (let i = 0; i < eventsPerWorker; i++) {
        await ledger.appendEvent({
          event: 'JOB_DISCOVERED',
          payload: {
            jobId: `job_${workerId}_${i}`,
            title: `Engineer ${i}`,
            worker: workerId
          },
          actor: `agent:${workerId}`
        });
        // Small random jitter between 2ms and 10ms
        await new Promise(r => setTimeout(r, Math.floor(Math.random() * 8) + 2));
      }
    })();
    workerTasks.push(task);
  }

  // Wait for all concurrent writers to complete
  await Promise.all(workerTasks);

  // Validate output integrity
  const events = ledger.readEvents();
  assert.equal(events.length, totalExpectedEvents, `Must have exactly ${totalExpectedEvents} recorded events`);

  // Verify contiguous monotonic sequence ordering: 1, 2, 3, ... N
  for (let idx = 0; idx < events.length; idx++) {
    const seq = events[idx].id !== undefined ? events[idx].id : events[idx].seq;
    assert.equal(seq, idx + 1, `Event at index ${idx} must have seq ${idx + 1}`);
  }

  // Verify complete cryptographic hash chain
  const integrity = ledger.verifyChainIntegrity();
  assert.ok(integrity.valid, `Cryptographic chain integrity failed: ${integrity.reason}`);
  assert.equal(integrity.count, totalExpectedEvents);
});

suite.test('FileLock provides exclusive mutual exclusion under contention', async assert => {
  const testLockFile = path.join(tempDir, 'mutex.lock');
  const lockA = new FileLock(testLockFile, { leaseMs: 3000 });
  const lockB = new FileLock(testLockFile, { leaseMs: 3000 });

  const acqA = await lockA.acquire(1000);
  assert.ok(acqA, 'Lock A should be acquired');

  let lockBAcquired = false;
  try {
    await lockB.acquire(200);
    lockBAcquired = true;
  } catch (_) {
    lockBAcquired = false;
  }
  assert.equal(lockBAcquired, false, 'Lock B should fail to acquire while Lock A is held');

  lockA.release();
  const acqB2 = await lockB.acquire(1000);
  assert.ok(acqB2, 'Lock B should acquire after Lock A is released');
  lockB.release();
});

suite.test('Clean up temporary concurrency directory', assert => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(tempDir), false);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
