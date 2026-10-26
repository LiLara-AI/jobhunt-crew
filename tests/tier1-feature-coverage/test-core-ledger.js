'use strict';
/**
 * Tier 1: Feature Coverage - Core Event Ledger & Reducer Projection
 * Verifies append-only event ledger contracts, hash chaining, monotonic sequencing,
 * and deterministic snapshot reproduction using production modules.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const { EventLedger } = require('../../lib/ledger/ledger');
const { reduceEvents, replayLedger } = require('../../lib/ledger/reducer');

const suite = new TestSuite('Tier 1: Core Event Ledger & Reducer');

suite.test('Ledger assigns monotonic sequence numbers and valid UTC timestamps', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ledger-test-'));
  try {
    const ledger = new EventLedger({ workspaceDir: tmpDir });
    const e1 = await ledger.appendEvent({
      event: 'JOB_DISCOVERED',
      payload: { id: 'job_001', title: 'Platform Architect', company: 'Apex', url: 'https://example.com/1' }
    });
    const e2 = await ledger.appendEvent({
      event: 'JOB_DISCOVERED',
      payload: { id: 'job_002', title: 'Senior SRE', company: 'Apex', url: 'https://example.com/2' }
    });

    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.ok(new Date(e1.timestamp).getTime() > 0);
    assert.ok(new Date(e2.timestamp).getTime() >= new Date(e1.timestamp).getTime());
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('Cryptographic hash chain maintains tamper-evident parent linking', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ledger-test-'));
  try {
    const ledger = new EventLedger({ workspaceDir: tmpDir });
    const e1 = await ledger.appendEvent({
      event: 'JOB_DISCOVERED',
      payload: { id: 'job_001', title: 'Lead SRE', company: 'Strata', url: 'https://strata.com/1' }
    });
    const e2 = await ledger.appendEvent({
      event: 'JOB_TRIAGED',
      payload: { id: 'job_001', score: 4.8, status: 'shortlisted' }
    });

    assert.equal(e1.prevHash, '0'.repeat(64));
    assert.ok(e2.prevHash.length === 64);
    assert.ok(ledger.verifyChainIntegrity().valid);

    // Simulate malicious tamper
    const lines = fs.readFileSync(ledger.ledgerPath, 'utf8').trim().split('\n');
    const tampered = JSON.parse(lines[0]);
    tampered.payload.title = 'Maliciously Altered Title';
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(ledger.ledgerPath, lines.join('\n') + '\n', 'utf8');

    assert.equal(ledger.verifyChainIntegrity().valid, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('Pure reducer projection is deterministic and idempotent across replays', assert => {
  const events = [
    { id: 1, seq: 1, timestamp: '2026-10-25T01:00:00Z', actor: 'agent:recon', event: 'JOB_DISCOVERED', payload: { id: 'job_100', title: 'Staff Architect', company: 'Apex', url: 'https://apex.com/jobs/100' } },
    { id: 2, seq: 2, timestamp: '2026-10-25T01:01:00Z', actor: 'agent:recon', event: 'JOB_TRIAGED', payload: { id: 'job_100', score: 4.5, status: 'shortlisted' } },
    { id: 3, seq: 3, timestamp: '2026-10-25T01:02:00Z', actor: 'human', event: 'DECISION_RECORDED', payload: { decisionId: 'dec_01', decisionType: 'shortlist_confirm', jobId: 'job_100' } }
  ];

  const snap1 = reduceEvents(events);
  const snap2 = reduceEvents(events);

  assert.deepEqual(snap1, snap2);
  assert.equal(snap1.jobs['job_100'].status, 'shortlisted');
  assert.equal(snap1.decisions.length, 1);
});

suite.test('replayLedger rebuilds snapshot.json from ledger.jsonl idempotently', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ledger-test-'));
  try {
    const ledger = new EventLedger({ workspaceDir: tmpDir });
    await ledger.appendEvent({ event: 'JOB_DISCOVERED', payload: { id: 'job_200', title: 'Principal Architect', company: 'Apex', url: 'https://apex.com/200' } });
    await ledger.appendEvent({ event: 'JOB_TRIAGED', payload: { id: 'job_200', score: 4.9, status: 'shortlisted' } });

    const state = await replayLedger({ workspaceDir: tmpDir, rebuild: true });
    assert.equal(state.jobs['job_200'].title, 'Principal Architect');
    assert.equal(state.jobs['job_200'].status, 'shortlisted');
    assert.equal(state.lastEventId, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
