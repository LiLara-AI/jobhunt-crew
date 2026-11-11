'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventLedger } = require('../../lib/ledger/ledger');
const { FileLock } = require('../../lib/ledger/lock');

describe('ledger reliability: torn tails and stale locks (temp dirs only)', () => {
  let tmpDir;
  let ledger;
  let ledgerPath;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ledger-unit-'));
    ledgerPath = path.join(tmpDir, '.crew', 'ledger.jsonl');
    ledger = new EventLedger({ workspaceDir: tmpDir, ledgerPath });
    await ledger.appendEvent({ event: 'JOB_DISCOVERED', actor: 'agent:recon', payload: { id: 'job_1' } });
    await ledger.appendEvent({ event: 'JOB_DISCOVERED', actor: 'agent:recon', payload: { id: 'job_2' } });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('appendEvent never resets the sequence on a corrupt trailing line', async () => {
    fs.appendFileSync(ledgerPath, '{"partial": "torn write\n', 'utf8');
    const third = await ledger.appendEvent({ event: 'JOB_DISCOVERED', actor: 'agent:recon', payload: { id: 'job_3' } });
    assert.strictEqual(third.id, 3);
    assert.strictEqual(third.seq, 3);
  });

  test('readEvents skips malformed trailing lines', async () => {
    fs.appendFileSync(ledgerPath, 'not json at all\n', 'utf8');
    const events = ledger.readEvents();
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[2].payload.id, 'job_3');
  });

  test('getLastEvent scans backward past corrupt lines', () => {
    const last = ledger.getLastEvent();
    assert.strictEqual(last.id, 3);
  });

  test('FileLock recovers a stale lock left by a dead process', async () => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-lock-unit-'));
    const lockPath = path.join(lockDir, 'ledger.lock');
    try {
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: 2147483000,
        hostname: os.hostname(),
        acquiredAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() - 30000).toISOString(),
        time: Date.now() - 60000
      }), 'utf8');
      const lock = new FileLock(lockPath, { leaseMs: 1000 });
      const acquired = await lock.acquire(5000);
      assert.strictEqual(acquired, true);
      lock.release();
      assert.strictEqual(fs.existsSync(lockPath), false);
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});
