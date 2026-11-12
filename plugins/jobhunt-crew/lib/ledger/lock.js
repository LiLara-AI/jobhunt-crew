'use strict';

/**
 * JobHunt Crew — Cross-Process Concurrency Lockfile
 * Provides kernel-level mutual exclusion, automatic heartbeat lease renewal,
 * and stale lock recovery for multi-agent processes.
 * Location: lib/ledger/lock.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Active process lock registry for automatic exit cleanup
const ACTIVE_LOCKS = new Set();
let EXIT_HANDLERS_INSTALLED = false;

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // Alive but owned by different user
  }
}

function installExitHandlers() {
  if (EXIT_HANDLERS_INSTALLED) return;
  EXIT_HANDLERS_INSTALLED = true;

  const cleanup = () => {
    for (const lock of ACTIVE_LOCKS) {
      try {
        lock.release();
      } catch (_) {}
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}

class FileLock {
  /**
   * @param {string} lockPath - Path to the lockfile (e.g. .crew/ledger.lock)
   * @param {Object} [options]
   * @param {number} [options.leaseMs=5000] - Duration before lock is considered expired
   * @param {number} [options.retryIntervalMs=25] - Base wait time between contention checks
   */
  constructor(lockPath, options = {}) {
    this.lockPath = path.resolve(lockPath);
    this.leaseMs = options.leaseMs || 5000;
    this.retryIntervalMs = options.retryIntervalMs || 25;
    this.fd = null;
    this.refreshTimer = null;
    this.acquired = false;

    installExitHandlers();
  }

  _writePayload() {
    const now = Date.now();
    const payload = JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.leaseMs).toISOString(),
      time: now
    });
    fs.ftruncateSync(this.fd, 0);
    fs.writeSync(this.fd, payload, 0, 'utf8');
    fs.fsyncSync(this.fd);
  }

  _startHeartbeat() {
    const interval = Math.max(500, Math.floor(this.leaseMs / 2));
    this.refreshTimer = setInterval(() => {
      if (this.acquired && this.fd !== null) {
        try {
          this._writePayload();
        } catch (_) {}
      }
    }, interval);
    if (this.refreshTimer.unref) {
      this.refreshTimer.unref();
    }
  }

  _isStale() {
    try {
      if (!fs.existsSync(this.lockPath)) return false;

      let stat = null;
      try {
        stat = fs.statSync(this.lockPath);
      } catch (_) {
        return false;
      }

      let content = '';
      try {
        content = fs.readFileSync(this.lockPath, 'utf8').trim();
      } catch (_) {
        // File may be locked or being written: check mtime age
        return stat ? (Date.now() - stat.mtimeMs) > this.leaseMs : false;
      }

      if (!content) {
        return stat ? (Date.now() - stat.mtimeMs) > this.leaseMs : false;
      }

      let data;
      try {
        data = JSON.parse(content);
      } catch (_) {
        // Invalid JSON or partially written: check mtime age
        return stat ? (Date.now() - stat.mtimeMs) > this.leaseMs : false;
      }

      if (!data || typeof data !== 'object') {
        return stat ? (Date.now() - stat.mtimeMs) > this.leaseMs : false;
      }

      const now = Date.now();
      const expiresAt = data.expiresAt ? new Date(data.expiresAt).getTime() : (data.time ? data.time + this.leaseMs : 0);

      if (expiresAt && now > expiresAt) return true;

      if (typeof data.pid === 'number' && data.pid > 0 && data.hostname === os.hostname() && !isPidAlive(data.pid)) {
        return true; // Dead process
      }

      return false;
    } catch (_) {
      return false;
    }
  }

  /**
   * Removes a lock file already judged stale, tolerating Windows sharing
   * violations (EPERM/EBUSY) with jittered 25-75ms retries. Any descriptor
   * this instance holds is closed before unlinking so the unlink cannot
   * fail on our own open handle.
   * @returns {Promise<boolean>} true when the stale file is gone
   */
  async _removeStaleLock() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch (_) {}
      this.fd = null;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.unlinkSync(this.lockPath);
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return true;
        if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') {
          return false;
        }
        const delay = 25 + Math.floor(Math.random() * 51);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return !fs.existsSync(this.lockPath);
  }

  /**
   * Acquires the lock, waiting up to timeoutMs.
   */
  async acquire(timeoutMs = 10000) {
    const startTime = Date.now();
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    while (Date.now() - startTime < timeoutMs) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        this.fd = fd;
        this.acquired = true;
        this._writePayload();
        this._startHeartbeat();
        ACTIVE_LOCKS.add(this);
        return true;
      } catch (err) {
        if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
          // Lock contention: inspect for stale lease or dead PID.
          // On Windows an existing lock file with an open descriptor surfaces
          // as EPERM/EBUSY rather than EEXIST, so stale recovery must run for
          // every contention code, not only EEXIST.
          if (this._isStale() && await this._removeStaleLock()) {
            continue; // Re-attempt immediately
          }
          // Backoff with randomized 25-75ms jitter to prevent lock starvation
          const delay = 25 + Math.floor(Math.random() * 51);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw err;
        }
      }
    }

    throw new Error(`Failed to acquire lock at ${this.lockPath} within ${timeoutMs}ms (contention timeout)`);
  }

  /**
   * Releases the lock and unlinks the lockfile.
   */
  release() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch (_) {}
      this.fd = null;
    }
    if (this.acquired) {
      this.acquired = false;
      ACTIVE_LOCKS.delete(this);
      try {
        if (fs.existsSync(this.lockPath)) {
          let shouldUnlink = false;
          try {
            const content = fs.readFileSync(this.lockPath, 'utf8').trim();
            if (content) {
              const data = JSON.parse(content);
              if (data && data.pid === process.pid) {
                shouldUnlink = true;
              }
            }
          } catch (_) {
            shouldUnlink = false;
          }

          if (shouldUnlink) {
            // Descriptor is already closed above; retry briefly because
            // Windows can report EPERM/EBUSY until handles fully drain.
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                fs.unlinkSync(this.lockPath);
                break;
              } catch (unlinkErr) {
                if (unlinkErr.code !== 'EPERM' && unlinkErr.code !== 'EBUSY' && unlinkErr.code !== 'EACCES') {
                  break;
                }
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 + Math.floor(Math.random() * 51));
              }
            }
          }
        }
      } catch (_) {}
    }
  }
}

/**
 * Concurrency helper function. Executes an async callback under lock.
 */
async function withLock(fn, options = {}) {
  const lockPath = options.lockPath || path.join(process.cwd(), '.crew', 'ledger.lock');
  const lock = new FileLock(lockPath, options);
  await lock.acquire(options.timeoutMs || 10000);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

module.exports = {
  FileLock,
  withLock,
  isPidAlive
};
