'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateRetrospective } = require('../../lib/operational/retrospective');
const { EventLedger } = require('../../lib/ledger/ledger');

describe('operational/retrospective generateRetrospective', () => {
  const ref = new Date('2026-01-08T00:00:00.000Z');
  const at = iso => iso;

  test('computes funnel metrics and proposals from a raw event array', () => {
    const events = [
      { event: 'JOB_DISCOVERED', timestamp: at('2026-01-07T00:00:00.000Z'), payload: {} },
      { event: 'JOB_DISCOVERED', timestamp: at('2026-01-07T01:00:00.000Z'), payload: {} },
      { event: 'JOB_TRIAGED', timestamp: at('2026-01-07T02:00:00.000Z'), payload: { status: 'PASS' } },
      { event: 'JOB_TRIAGED', timestamp: at('2026-01-07T03:00:00.000Z'), payload: { status: 'MARGINAL', missingSkills: ['kubernetes'] } },
      { event: 'JOB_TRIAGED', timestamp: at('2026-01-07T04:00:00.000Z'), payload: { status: 'FAIL', knockoutReason: 'location', missingSkills: ['kubernetes'] } },
      { event: 'APPLICATION_SUBMITTED', timestamp: at('2026-01-07T05:00:00.000Z'), payload: {} },
      // Outside the 7-day window: must be excluded.
      { event: 'JOB_DISCOVERED', timestamp: at('2025-12-20T00:00:00.000Z'), payload: {} }
    ];
    const retro = generateRetrospective(events, { days: 7, referenceTime: ref });
    assert.strictEqual(retro.windowDays, 7);
    assert.strictEqual(retro.eventCount, 6);
    assert.deepStrictEqual(retro.funnel, {
      discovered: 2,
      triaged: 3,
      passed: 1,
      marginal: 1,
      failed: 1,
      submitted: 1,
      passRatePercent: 33.3
    });
    assert.strictEqual(retro.topKnockoutReasons.location, 1);
    assert.strictEqual(retro.missingKeywords.kubernetes, 2);
    assert.strictEqual(retro.proposals[0].type, 'SKILL_COVERAGE_GAP');
    assert.strictEqual(retro.proposals[0].keyword, 'kubernetes');
  });

  test('handles empty input without division errors', () => {
    const retro = generateRetrospective([], { referenceTime: ref });
    assert.strictEqual(retro.eventCount, 0);
    assert.strictEqual(retro.funnel.passRatePercent, 0);
    assert.deepStrictEqual(retro.proposals, []);
  });

  describe('with a real EventLedger instance (readEvents path)', () => {
    let tmpDir;
    let ledger;
    before(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-retro-unit-'));
      ledger = new EventLedger({ workspaceDir: tmpDir });
      await ledger.appendEvent({ event: 'JOB_DISCOVERED', actor: 'agent:recon', payload: { id: 'job_1' } });
      await ledger.appendEvent({ event: 'JOB_TRIAGED', actor: 'agent:recon', payload: { id: 'job_1', status: 'SHORTLISTED' } });
    });
    after(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('reads events via EventLedger.readEvents', () => {
      const retro = generateRetrospective(ledger, { days: 7 });
      assert.strictEqual(retro.funnel.discovered, 1);
      assert.strictEqual(retro.funnel.triaged, 1);
      assert.strictEqual(retro.funnel.passed, 1);
    });
  });
});
