'use strict';
/**
 * Tier 1: Feature Coverage - Deterministic Guardrails
 * Verifies Human-Only Submit, Evidence-Based Closure, Readiness Gate, and Canonical Dedup
 * using production GuardrailEngine.
 */

const { TestSuite } = require('../helpers/test-harness');
const { GuardrailEngine } = require('../../lib/guardrails/engine');

const suite = new TestSuite('Tier 1: Deterministic Guardrails');

suite.test('HumanSubmitGuard blocks automated agent actors from submitting', assert => {
  assert.throws(
    () => GuardrailEngine.validateSubmission('agent:scribe'),
    /GUARDRAIL_VIOLATION.*human users/
  );
  assert.throws(
    () => GuardrailEngine.validateSubmission('system'),
    /GUARDRAIL_VIOLATION.*human users/
  );
  assert.ok(GuardrailEngine.validateSubmission('human'));
});

suite.test('EvidenceClosureGuard strictly rejects age-based closures and requires solid proof', assert => {
  // Rejecting age penalties
  assert.throws(
    () => GuardrailEngine.validateClosure({ type: 'posting_age', days: 120 }),
    /cannot be closed or penalized due to posting age/
  );

  // Rejecting empty proof
  assert.throws(
    () => GuardrailEngine.validateClosure({ type: 'http_404', proof: '' }),
    /requires non-empty proof/
  );

  // Accepting valid evidence
  assert.ok(GuardrailEngine.validateClosure({
    type: 'http_404',
    proof: 'HTTP GET returned status code 404 Not Found at 2026-10-24T12:00:00Z'
  }));

  assert.ok(GuardrailEngine.validateClosure({
    type: 'explicit_closure_notice',
    proof: 'DOM selector .job-status contained text "This position is no longer accepting applications"'
  }));

  assert.ok(GuardrailEngine.validateClosure({
    type: 'passed_deadline',
    proof: 'Stated requisition deadline 2026-10-20 passed'
  }));
});

suite.test('ReadinessGate blocks unverified claims or unapproved drafts', assert => {
  assert.throws(
    () => GuardrailEngine.validateReadiness({ claimVerification: { passed: false }, reviewPanel: { verdict: 'APPROVE' } }),
    /passing claim verification/
  );

  assert.throws(
    () => GuardrailEngine.validateReadiness({ claimVerification: { passed: true }, reviewPanel: { verdict: 'REQUEST_CHANGES' } }),
    /review panel approval/
  );

  assert.ok(GuardrailEngine.validateReadiness({
    claimVerification: { passed: true, violations: [] },
    reviewPanel: { verdict: 'APPROVE', score: 4.8 }
  }));
});

suite.test('Canonical URL Dedup strips tracking parameters to collapse duplicate discovery', assert => {
  const urlA = 'https://boards.greenhouse.io/techcorp/jobs/50101?gh_src=linkedin&utm_source=social';
  const urlB = 'https://boards.greenhouse.io/techcorp/jobs/50101?utm_medium=email';
  const urlC = 'https://boards.greenhouse.io/techcorp/jobs/50101/';

  assert.equal(GuardrailEngine.canonicalizeUrl(urlA), 'https://boards.greenhouse.io/techcorp/jobs/50101');
  assert.equal(GuardrailEngine.canonicalizeUrl(urlB), 'https://boards.greenhouse.io/techcorp/jobs/50101');
  assert.equal(GuardrailEngine.canonicalizeUrl(urlC), 'https://boards.greenhouse.io/techcorp/jobs/50101');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
