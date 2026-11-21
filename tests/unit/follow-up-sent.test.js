'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { reduceEvents } = require('../../lib/ledger/reducer');
const { CadenceEngine } = require('../../lib/crew/cadence');

const submittedAt = '2026-01-01T00:00:00.000Z';
const base = [
  { event: 'CLAIMS_VERIFIED', payload: { jobId: 'job_1', passed: true }, timestamp: submittedAt },
  { event: 'APPLICATION_SUBMITTED', payload: { jobId: 'job_1' }, timestamp: submittedAt }
];
const actionOn = (events, date) =>
  CadenceEngine.evaluateApplications(reduceEvents(events).applications, new Date(date))[0].nextAction;

test('a recorded FOLLOW_UP_SENT stops the cadence reporting that touchpoint as due', () => {
  assert.strictEqual(actionOn(base, '2026-01-09T00:00:00.000Z'), 'DUE_CADENCE_7');

  const day7 = [...base, { event: 'FOLLOW_UP_SENT', payload: { jobId: 'job_1', day: 7 } }];
  assert.notStrictEqual(actionOn(day7, '2026-01-09T00:00:00.000Z'), 'DUE_CADENCE_7');
  assert.strictEqual(actionOn(day7, '2026-01-16T00:00:00.000Z'), 'DUE_CADENCE_14');

  const both = [...day7, { event: 'FOLLOW_UP_SENT', payload: { jobId: 'job_1', day: '14' } }];
  assert.strictEqual(actionOn(both, '2026-01-16T00:00:00.000Z'), 'CADENCE_COMPLETE');
});

test('FOLLOW_UP_SENT with an unknown day or job changes nothing', () => {
  const odd = [...base,
    { event: 'FOLLOW_UP_SENT', payload: { jobId: 'job_1', day: 3 } },
    { event: 'FOLLOW_UP_SENT', payload: { jobId: 'job_missing', day: 7 } }];
  assert.strictEqual(actionOn(odd, '2026-01-09T00:00:00.000Z'), 'DUE_CADENCE_7');
  assert.strictEqual(reduceEvents(odd).applications.job_missing, undefined);
});
