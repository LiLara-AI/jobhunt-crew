'use strict';
/**
 * Tier 1: Feature Coverage - Candidate-Isolated Blind Review Panel
 * Verifies that the Critic agent's context and review inputs strictly omit the candidate profile,
 * contact details, and internal claim IDs.
 */

const { TestSuite } = require('../helpers/test-harness');

const { BlindReviewContextBuilder, CandidateScrubber, BlindReviewPanel } = require('../../lib/honest-cv/review-panel');

const suite = new TestSuite('Tier 1: Candidate-Isolated Blind Review Panel');

suite.test('Review panel payload strictly isolates draft text from candidate profile', assert => {
  const dossier = {
    candidate: {
      name: 'Dr. Morgan Vance',
      email: 'morgan.vance@example.org',
      phone: '+966 50 000 0000',
      salaryFloor: { minimumBase: 45000 }
    },
    claims: [{ id: 'CLM-001' }, { id: 'CLM-002' }]
  };

  const jd = {
    title: 'Principal Platform Architect',
    company: 'Apex Cloud Technologies',
    requirementsText: 'Experience in distributed systems, Go, Kafka, and Kubernetes.'
  };

  const cleanDraft = {
    type: 'cv',
    content: 'Principal Platform Architect with deep expertise in Go and Kafka. Scaled multi-region Kubernetes clusters handling billions of events daily.'
  };

  const payload = BlindReviewContextBuilder.buildReviewPayload(jd, cleanDraft, { mode: 'fast_lane' });
  const audit = BlindReviewContextBuilder.auditIsolation(payload, dossier);

  assert.equal(audit.isolated, true, `Leaked items: ${audit.leaks.join(', ')}`);
  assert.equal(payload.mode, 'fast_lane');
});

suite.test('Audit catches intentional candidate profile leaks in reviewer context', assert => {
  const dossier = {
    candidate: {
      name: 'Dr. Morgan Vance',
      email: 'morgan.vance@example.org',
      phone: '+966 50 000 0000',
      salaryFloor: { minimumBase: 45000 }
    },
    claims: [{ id: 'CLM-001' }]
  };

  const jd = { title: 'Architect', company: 'Apex', requirementsText: 'Kafka' };
  const leakyDraft = {
    type: 'cv',
    content: 'Contact: Dr. Morgan Vance at morgan.vance@example.org. Verified by [CLM-001]. Minimum base 45000.'
  };

  const payload = BlindReviewContextBuilder.buildReviewPayload(jd, leakyDraft);
  const audit = BlindReviewContextBuilder.auditIsolation(payload, dossier);

  assert.equal(audit.isolated, false);
  assert.greaterThan(audit.leaks.length, 2);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
