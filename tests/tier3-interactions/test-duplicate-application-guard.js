'use strict';
/**
 * Tier 3: Cross-Feature Interactions - Duplicate Application & Cooldown Guard
 * Verifies that duplicate applications to the same requisition ID are strictly blocked,
 * and company cooldown periods (e.g. 30/90 days) trigger appropriate user warnings.
 * Uses production DuplicateApplicationGuard.
 */

const { TestSuite } = require('../helpers/test-harness');
const { DuplicateApplicationGuard } = require('../../lib/guardrails/dedup');

const suite = new TestSuite('Tier 3: Duplicate Application Guard');

suite.test('Applying to identical requisition ID is strictly blocked as duplicate', assert => {
  const guard = new DuplicateApplicationGuard();
  guard.recordApplication('JR-9001', 'Apex Cloud Technologies', '2026-10-01T10:00:00Z');

  const check = guard.evaluateApplicationEligibility('JR-9001', 'Apex Cloud Technologies');
  assert.equal(check.allowed, false);
  assert.equal(check.reason, 'DUPLICATE_REQUISITION');
  assert.ok(check.message.includes('Repeated submissions are blocked'));
});

suite.test('Applying to a different requisition at same company within cooldown triggers warning but allows progression', assert => {
  const guard = new DuplicateApplicationGuard(30);
  const now = new Date('2026-10-15T12:00:00Z');
  guard.recordApplication('JR-1001', 'NEOM', '2026-10-05T12:00:00Z'); // 10 days ago

  const check = guard.evaluateApplicationEligibility('JR-2002', 'NEOM', now);
  assert.equal(check.allowed, true);
  assert.equal(check.warning, 'COMPANY_COOLDOWN_ACTIVE');
  assert.equal(check.cooldownRemainingDays, 20);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
