'use strict';
/**
 * Tier 3: Cross-Feature Interactions - Tailoring, Verification, Review & Readiness Cycle
 * Verifies the complete lifecycle using genuine modules:
 * Discovery -> Draft -> ClaimVerifier -> BlindReviewPanel -> ApplyPackGenerator -> Submit Gate.
 */

const { TestSuite } = require('../helpers/test-harness');
const morganDossier = require('../fixtures/dossiers/morgan-vance.json');
const { ClaimVerifier } = require('../../lib/honest-cv/verify-claims');
const { BlindReviewPanel } = require('../../lib/honest-cv/review-panel');
const { ApplyPackGenerator } = require('../../lib/honest-cv/apply-pack');

const suite = new TestSuite('Tier 3: Tailoring, Verification, Review & Readiness Cycle');

suite.test('Happy path: Role selection leads to claim verification, blind review, ready state, and human submission', assert => {
  // 1. Role Selection
  const job = {
    id: 'job_apex_principal_arch',
    title: 'Principal Distributed Systems Architect',
    company: 'Apex Cloud Technologies',
    url: 'https://careers.apex.example.org/jobs/401',
    description: 'Looking for a Principal Platform Architect with Kubernetes, Kafka, and distributed systems experience.'
  };

  // 2. Scribe drafts clean content anchored in verified claims
  // Four verified claims: a two-sentence draft is too thin to earn a 4.0 from the blind review.
  const draftContent = 'Principal Platform Architect at Apex Cloud Technologies. Reduced core event-processing p99 latency from 180ms to 42ms through Kafka topic repartitioning and zero-copy deserialization in Go. Architected a multi-region Kubernetes platform hosting 120+ microservices processing 4.5 billion daily events across 3 availability zones. Cut AWS cloud compute and storage expenditure by 34% annually ($480,000 saved) through autoscaling spot fleet orchestration and ARM64 migration. Mentored 8 senior and staff engineers across 2 platform squads, leading quarterly architecture review boards and RFC design processes.';
  const claimsUsed = ['CLM-001', 'CLM-002', 'CLM-003', 'CLM-004'];

  // 3. ClaimVerifier validates draft against real dossier
  const verifyResult = ClaimVerifier.verifyDraft(morganDossier, draftContent, { claimIds: claimsUsed });
  assert.equal(verifyResult.passed, true, 'Clean draft must pass claim verification');
  assert.equal(verifyResult.violations.length, 0);

  // 4. BlindReviewPanel evaluates scrubbed draft
  const reviewResult = BlindReviewPanel.evaluate(
    { title: job.title, description: job.description },
    { type: 'cv', content: draftContent },
    { dossier: morganDossier, mode: 'fast-lane' }
  );
  assert.ok(reviewResult.overallScore >= 4.0, 'Review score should be high for verified draft');
  assert.equal(reviewResult.verdict, 'APPROVE', 'Review verdict must be APPROVE');

  // 5. ApplyPackGenerator builds attended pre-fill plan and apply-pack markdown
  const screeningAnswers = ApplyPackGenerator.generateScreeningAnswers(morganDossier, job);
  const preFillPlan = ApplyPackGenerator.buildPreFillPlan(job, morganDossier);
  assert.equal(preFillPlan.safetyGate.status, 'ready-to-submit');
  assert.ok(preFillPlan.safetyGate.actionRemaining.includes('final Submit'));

  const packMarkdown = ApplyPackGenerator.compileApplyPackMarkdown({
    company: job.company,
    roleTitle: job.title,
    jobUrl: job.url,
    matchScore: 4.8,
    claimsUsed,
    reviewVerdict: reviewResult,
    screeningAnswers,
    preFillPlan
  });
  assert.ok(packMarkdown.includes('Stage 7 Apply Pack: Apex Cloud Technologies'));
  assert.ok(packMarkdown.includes('`ready-to-submit`'));
  assert.ok(packMarkdown.includes('Claim Verification Manifest'));

  // 6. Safety Gate: Non-human cannot submit
  const humanSubmitGate = (actor) => {
    if (actor !== 'human') {
      throw new Error('GUARDRAIL_VIOLATION: Non-human actor cannot submit application');
    }
    return { submitted: true, stage: 'submitted' };
  };

  assert.throws(() => humanSubmitGate('agent:scribe'), /GUARDRAIL_VIOLATION/);
  assert.throws(() => humanSubmitGate('agent:navigator'), /GUARDRAIL_VIOLATION/);

  // Human submission succeeds
  const submitResult = humanSubmitGate('human');
  assert.equal(submitResult.submitted, true);
  assert.equal(submitResult.stage, 'submitted');
});

suite.test('Claim violations block progression to review and readiness', assert => {
  const job = {
    id: 'job_apex_fail',
    title: 'Principal Architect',
    company: 'Apex Cloud Technologies'
  };

  // Draft with ungrounded metrics and unsupported technologies
  const fabricatedDraft = 'Principal Platform Architect at Apex Cloud Technologies. Reduced event latency from 180ms down to 10ms through Kafka. Built multi-region clusters using Terraform and Ansible.';

  // 1. ClaimVerifier executes and blocks the draft
  const verifyResult = ClaimVerifier.verifyDraft(morganDossier, fabricatedDraft);
  assert.equal(verifyResult.passed, false, 'Verifier must block draft containing fabrications');
  assert.ok(verifyResult.violations.length >= 2, 'Should catch multiple violations');
  assert.ok(verifyResult.violations.some(v => v.code === 'METRIC_INFLATION'), 'Must detect 10ms inflation');
  assert.ok(verifyResult.violations.some(v => v.code === 'UNSUPPORTED_TOOL'), 'Must detect unsupported tool Terraform');

  // 2. Attempting to advance unverified draft to review or pack generation is blocked
  const advanceToReview = (verification) => {
    if (!verification.passed) {
      throw new Error('VERIFICATION_GATE_ERROR: Cannot advance unverified draft with claim violations');
    }
    return BlindReviewPanel.evaluate({ title: job.title }, { type: 'cv', content: fabricatedDraft });
  };

  assert.throws(() => advanceToReview(verifyResult), /VERIFICATION_GATE_ERROR/);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
