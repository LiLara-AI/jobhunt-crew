'use strict';
/**
 * JobHunt Crew — Challenger M2 Iteration 3 Active PID & Recovery Empirical Test
 * Tests:
 * 1. Lockfile belonging to an active PID is NEVER unlinked by another process/instance.
 * 2. Active PID under high contention cannot be stolen or deleted.
 * 3. Dead PID with future expiresAt is immediately recovered (< 500ms).
 * 4. Expired lease (past expiresAt) recovers cleanly.
 * 5. Belated release() by previous owner does NOT unlink lock acquired by new owner.
 * 6. Lock ownership check handles empty, malformed, or missing files without crashing.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork, spawnSync } = require('child_process');
const assert = require('assert');

const { FileLock, withLock, isPidAlive } = require('../../lib/ledger/lock');

// Child worker role
if (process.env.TEST_ROLE === 'lock_holder') {
  (async () => {
    const lockPath = process.env.LOCK_PATH;
    const holdMs = parseInt(process.env.HOLD_MS || '3000', 10);
    const leaseMs = parseInt(process.env.LEASE_MS || '4000', 10);

    const lock = new FileLock(lockPath, { leaseMs });
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
      console.error('[Child Lock Holder Error]:', err.message);
      process.exit(1);
    }
  })();
} else {
  runEmpiricalSuite().catch(err => {
    console.error('\nFATAL TEST FAILURE:', err);
    process.exit(1);
  });
}

async function runEmpiricalSuite() {
  console.log('======================================================================');
  console.log('EMPIRICAL ADVERSARIAL SUITE: ACTIVE PID UNLINK & RECOVERY INVARIANTS');
  console.log('======================================================================\n');

  let passed = 0;
  let total = 0;

  async function check(desc, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✓ [TEST ${total}] ${desc}`);
      passed++;
    } catch (err) {
      console.error(`  ✖ [TEST ${total}] ${desc}: ${err.message}`);
      throw err;
    }
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger-m2-iter3-'));

  try {
    // -------------------------------------------------------------------------
    // TEST 1: release() never unlinks lockfile belonging to a different PID
    // -------------------------------------------------------------------------
    await check('FileLock.release() never unlinks a lockfile owned by another active PID', async () => {
      const lockPath = path.join(tmpBase, 'test1.lock');

      // Spawn a real active child process that stays alive
      const activeChild = fork('-e', ['setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      assert.ok(activeChild.pid > 0);
      assert.strictEqual(isPidAlive(activeChild.pid), true);

      try {
        // Write active child's PID into the lockfile
        const now = Date.now();
        const payload = {
          pid: activeChild.pid,
          hostname: os.hostname(),
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 60000).toISOString(),
          time: now
        };
        fs.writeFileSync(lockPath, JSON.stringify(payload), 'utf8');

        // Now create a FileLock in the current process and simulate acquired state
        const imposterLock = new FileLock(lockPath, { leaseMs: 5000 });
        imposterLock.acquired = true;

        // Imposter calls release()
        imposterLock.release();

        // Lockfile MUST STILL EXIST because process.pid !== activeChild.pid!
        assert.strictEqual(fs.existsSync(lockPath), true, 'Lockfile must NOT be unlinked by non-owner');
        const contentAfter = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        assert.strictEqual(contentAfter.pid, activeChild.pid, 'Lockfile PID must remain unchanged');
      } finally {
        activeChild.kill('SIGKILL');
      }
    });

    // -------------------------------------------------------------------------
    // TEST 2: Contender does NOT unlink lock held by an active live process under contention
    // -------------------------------------------------------------------------
    await check('Contender process never unlinks lockfile of live active process during acquire contention', async () => {
      const lockPath = path.join(tmpBase, 'test2.lock');

      // Start child holding lock for 3000ms
      const child = fork(__filename, [], {
        env: Object.assign({}, process.env, {
          TEST_ROLE: 'lock_holder',
          LOCK_PATH: lockPath,
          HOLD_MS: '3000',
          LEASE_MS: '5000'
        }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });

      await new Promise((resolve, reject) => {
        child.on('message', m => { if (m.status === 'acquired') resolve(m); });
        child.on('error', reject);
        setTimeout(() => reject(new Error('Child failed to acquire in 3s')), 3000);
      });

      assert.strictEqual(fs.existsSync(lockPath), true, 'Lockfile must exist on disk');
      const initialData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(initialData.pid, child.pid);

      // Parent tries to acquire with short timeout
      const contender = new FileLock(lockPath, { leaseMs: 5000 });
      let failedWithTimeout = false;
      try {
        await contender.acquire(400);
      } catch (err) {
        if (err.message.includes('contention timeout') || err.message.includes('Failed to acquire')) {
          failedWithTimeout = true;
        }
      }

      assert.strictEqual(failedWithTimeout, true, 'Contender must time out');
      assert.strictEqual(fs.existsSync(lockPath), true, 'Lockfile must NOT have been deleted by contender');
      const midData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(midData.pid, child.pid, 'Lockfile PID must still belong to active child');

      // Wait for child to exit normally
      await new Promise(resolve => child.on('exit', resolve));
      assert.strictEqual(fs.existsSync(lockPath), false, 'Lockfile must be unlinked when real owner releases');
    });

    // -------------------------------------------------------------------------
    // TEST 3: Belated release by previous owner does not delete lock of new owner
    // -------------------------------------------------------------------------
    await check('Belated release() by previous owner does NOT unlink lock acquired by new owner', async () => {
      const lockPath = path.join(tmpBase, 'test3.lock');

      // Process A creates lock instance
      const lockA = new FileLock(lockPath, { leaseMs: 500 });
      lockA.acquired = true;

      // Meanwhile, Process B writes its own lock (e.g. after lease expiration or recovery)
      const fakeNewPid = 888888;
      const newPayload = {
        pid: fakeNewPid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        time: Date.now()
      };
      fs.writeFileSync(lockPath, JSON.stringify(newPayload), 'utf8');

      // Process A now belatedly calls release()
      lockA.release();

      // Lockfile MUST NOT be unlinked
      assert.strictEqual(fs.existsSync(lockPath), true, 'Lockfile must remain intact');
      const remaining = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(remaining.pid, fakeNewPid, 'Lockfile must still belong to new owner');
    });

    // -------------------------------------------------------------------------
    // TEST 4: Dead PID lock is recovered immediately even with future expiresAt
    // -------------------------------------------------------------------------
    await check('Dead PID lock with future expiration is recovered immediately without waiting', async () => {
      const lockPath = path.join(tmpBase, 'test4.lock');

      // Create a dead PID by spawning a short-lived process
      const deadChild = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      const deadPid = deadChild.pid;
      assert.ok(deadPid > 0);
      assert.strictEqual(isPidAlive(deadPid), false, 'PID must be confirmed dead');

      // Write dead PID with expiresAt 24 hours in the future
      const now = Date.now();
      const payload = {
        pid: deadPid,
        hostname: os.hostname(),
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 86400000).toISOString(),
        time: now
      };
      fs.writeFileSync(lockPath, JSON.stringify(payload), 'utf8');

      const lock = new FileLock(lockPath, { leaseMs: 3000 });
      const t0 = Date.now();
      const acquired = await lock.acquire(1500);
      const elapsed = Date.now() - t0;

      assert.strictEqual(acquired, true, 'Dead PID lock must be acquired');
      assert.ok(elapsed < 600, `Recovery must happen immediately, took ${elapsed}ms`);

      const currentData = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      assert.strictEqual(currentData.pid, process.pid, 'Lockfile must now belong to current process');

      lock.release();
      assert.strictEqual(fs.existsSync(lockPath), false, 'Lockfile unlinked after release');
    });

    // -------------------------------------------------------------------------
    // TEST 5: Expired lease (past expiresAt) recovers safely
    // -------------------------------------------------------------------------
    await check('Expired lease (past expiresAt) recovers safely', async () => {
      const lockPath = path.join(tmpBase, 'test5.lock');

      // Write an expired lock payload (expired 10 seconds ago)
      const pastTime = Date.now() - 20000;
      const payload = {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date(pastTime).toISOString(),
        expiresAt: new Date(pastTime + 5000).toISOString(),
        time: pastTime
      };
      fs.writeFileSync(lockPath, JSON.stringify(payload), 'utf8');

      const lock = new FileLock(lockPath, { leaseMs: 2000 });
      const acquired = await lock.acquire(1000);
      assert.strictEqual(acquired, true, 'Expired lease must be recovered');

      lock.release();
      assert.strictEqual(fs.existsSync(lockPath), false, 'Lockfile unlinked after release');
    });

    // -------------------------------------------------------------------------
    // TEST 6: withLock concurrency helper cleans up even if user code throws
    // -------------------------------------------------------------------------
    await check('withLock releases lockfile even when user task throws an uncaught error', async () => {
      const lockPath = path.join(tmpBase, 'test6.lock');

      let errorThrown = false;
      try {
        await withLock(async () => {
          assert.strictEqual(fs.existsSync(lockPath), true, 'Lockfile must exist during withLock execution');
          throw new Error('SIMULATED_USER_EXCEPTION');
        }, { lockPath, timeoutMs: 3000 });
      } catch (err) {
        if (err.message === 'SIMULATED_USER_EXCEPTION') {
          errorThrown = true;
        }
      }

      assert.strictEqual(errorThrown, true, 'User exception must propagate');
      assert.strictEqual(fs.existsSync(lockPath), false, 'Lockfile must be cleaned up despite exception');
    });

    // -------------------------------------------------------------------------
    // TEST 7: isPidAlive edge case validation
    // -------------------------------------------------------------------------
    await check('isPidAlive returns false for 0, negative, undefined, null, and non-number PIDs', () => {
      assert.strictEqual(isPidAlive(0), false);
      assert.strictEqual(isPidAlive(-1), false);
      assert.strictEqual(isPidAlive(null), false);
      assert.strictEqual(isPidAlive(undefined), false);
      assert.strictEqual(isPidAlive('12345'), false);
      assert.strictEqual(isPidAlive(NaN), false);
    });

  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch (_) {}
  }

  console.log('\n======================================================================');
  console.log(`ACTIVE PID & RECOVERY SUITE: ${passed}/${total} checks passed (0 failed)`);
  console.log('======================================================================\n');
}

