'use strict';
/**
 * Tier 1: Feature Coverage - Gemini Desktop Companion Pack & Proposal Bridge
 * Verifies asynchronous inbox proposal bridge, rejection of unauthorized 'submitted' claims,
 * and enforcement of deterministic claim verification on companion drafts.
 */

const { TestSuite } = require('../helpers/test-harness');

const { CompanionBridge } = require('../../lib/companion/bridge');

const suite = new TestSuite('Tier 1: Gemini Desktop Companion & Proposal Bridge');

suite.test('Companion bridge rejects malformed JSON without corrupting state', assert => {
  const malformed = '{"title": "Senior Architect", broken_json:';
  const res = CompanionBridge.ingestProposal(malformed);
  assert.equal(res.ingested, false);
  assert.equal(res.error, 'MALFORMED_JSON');
  assert.equal(res.stateCorrupted, false);
});

suite.test('Companion bridge strictly rejects unauthorized submitted status in proposal files', assert => {
  const badProposal = JSON.stringify({
    type: 'status_update',
    jobId: 'job_42',
    action: 'submitted',
    notes: 'Companion pretending to have submitted application'
  });

  const res = CompanionBridge.ingestProposal(badProposal);
  assert.equal(res.ingested, false);
  assert.ok(res.error.includes('GUARDRAIL_VIOLATION'));
  assert.equal(res.stateCorrupted, false);
});

suite.test('Draft proposals created in companion are quarantined as unverified pending Inquisitor gate', assert => {
  const draftProposal = JSON.stringify({
    type: 'draft_proposal',
    jobId: 'job_42',
    draftText: 'Drafted in Gemini Desktop app'
  });

  const res = CompanionBridge.ingestProposal(draftProposal);
  assert.equal(res.ingested, true);
  assert.equal(res.action, 'HOLD_FOR_CLAIM_VERIFICATION');
  assert.equal(res.status, 'pending_inquisitor_verification');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
