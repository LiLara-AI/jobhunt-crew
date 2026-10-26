'use strict';

/**
 * Milestone M7 Iteration 5 Adversarial Age Invariant & False-Positive Stress Suite
 *
 * Authored by: challenger_m7_iter5_2 (Adversarial Age Invariant & False-Positive Challenger)
 * Scope:
 *   1. POSITIVE CONTROLS (Age Evasion Attempts):
 *      - All natural, colloquial, disguised, and symbolic posting age phrases MUST BE BLOCKED
 *      - Tested against CompanionValidationGate.validateProposal (code: GUARDRAIL_VIOLATION_AGE_PENALTY)
 *      - Tested against GuardrailEngine.validateClosure (throws GUARDRAIL_VIOLATION)
 *   2. NEGATIVE CONTROLS (Legitimate Rejection & Closure Reasons):
 *      - Seniority & experience durations (e.g. 10+ years, 5 years) MUST BE ALLOWED
 *      - Notice periods (>60 days, 60 days, 90 days) MUST BE ALLOWED
 *      - Probation periods (over 90 days, 180 days) MUST BE ALLOWED
 *      - Compensation & salary figures (45,000 SAR, 30,000 SAR) MUST BE ALLOWED
 *      - Legitimate closure proofs (filled 2 days ago, passed 3 days ago, closed on 2026-10-20) MUST BE ALLOWED
 *      - Contract, leave, and allowance durations MUST BE ALLOWED
 *   3. BOUNDARY & LINGUISTIC STRESS:
 *      - Punctuation, symbols (>=, \u2265, >), case variations, mixed notes/rationale fields
 *      - Catastrophic backtracking / ReDoS safety stress check
 */

const { TestSuite } = require('../helpers/test-harness');
const { CompanionValidationGate } = require('../../lib/companion/validation');
const { GuardrailEngine } = require('../../lib/guardrails/engine');

const suite = new TestSuite('M7 Iteration 5 Adversarial Age Invariant & False-Positive Stress Suite');

// ============================================================================
// 1. POSITIVE CONTROLS: AGE EVASION ATTEMPTS MUST BE BLOCKED
// ============================================================================

suite.test('1.1 Positive Controls: Natural posting age phrases in CompanionValidationGate', async (assert) => {
  const agePhrases = [
    // Verbatim phrases from DISPATCH.md
    'posted 120 days ago',
    'opened 4 months ago',
    'over 60 days',
    'vacancy age 100 days',
    'listed 90 days ago',
    'published 60 days ago',
    'created 90 days ago',
    'open for > 60 days',
    'active for 4 months',
    'live for 120 days',
    'posted > 60 days',
    'opened a few weeks ago',
    'listing age: 100 days',

    // Additional natural & disguised variations
    'advertised 60 days ago',
    'open for over 90 days',
    'live for 3 months',
    'up for 60 days',
    'running for 4 months',
    'posting_age > 30',
    'requisition_age: 45 days',
    'too old',
    'stale vacancy',
    'older than 60 days',
    'posted 2 weeks ago',
    'opened several months ago',
    'created a few weeks ago',
    'listing age exceeds 30 days',
    'job age > 60 days',
    'posted for over 60 days',
    'active for > 60 days',
    'published > 30 days ago',
    '>= 90 days old',
    '\u2265 60 days old',
    'more than 90 days',
    'over 120 days',
    'published 3 months ago',
    'created 6 months ago',
    'advertised 2 months ago',
    'open for ten days',
    'posted couple of weeks ago'
  ];

  for (const phrase of agePhrases) {
    const proposal = {
      type: 'triage_decision',
      jobId: 'job_test_01',
      decision: 'reject',
      reason: phrase
    };

    const res = CompanionValidationGate.validateProposal(proposal);
    assert.equal(
      res.valid,
      false,
      `Positive control failed: phrase "${phrase}" was NOT blocked! Result: ${JSON.stringify(res)}`
    );
    assert.equal(
      res.code,
      'GUARDRAIL_VIOLATION_AGE_PENALTY',
      `Expected code GUARDRAIL_VIOLATION_AGE_PENALTY for "${phrase}", got ${res.code}`
    );
    assert.equal(res.ruleViolated, 'AGE_PENALTY_INVARIANT');
  }
});

suite.test('1.2 Positive Controls: Age penalty across decision aliases (exclude, not_interested) and note fields', async (assert) => {
  const testCases = [
    { decision: 'exclude', field: 'rationale', phrase: 'posted 90 days ago' },
    { decision: 'not_interested', field: 'notes', phrase: 'open for > 60 days' },
    { decision: 'REJECT', field: 'reason', phrase: 'listing age 120 days' },
    { decision: 'EXCLUDE', field: 'notes', phrase: 'vacancy age: 45 days' },
    { decision: 'not_interested', field: 'reason', phrase: 'active for 3 months' }
  ];

  for (const tc of testCases) {
    const proposal = {
      type: 'triage_decision',
      jobId: 'job_test_02',
      decision: tc.decision,
      [tc.field]: tc.phrase
    };

    const res = CompanionValidationGate.validateProposal(proposal);
    assert.equal(
      res.valid,
      false,
      `Expected age evasion via ${tc.decision}.${tc.field} "${tc.phrase}" to be blocked`
    );
    assert.equal(res.code, 'GUARDRAIL_VIOLATION_AGE_PENALTY');
  }
});

suite.test('1.3 Positive Controls: GuardrailEngine.validateClosure blocks age penalty indicators and proof text', async (assert) => {
  const ageProofPhrases = [
    'posted 120 days ago',
    'opened 4 months ago',
    'over 60 days',
    'vacancy age 100 days',
    'listed 90 days ago',
    'published 60 days ago',
    'created 90 days ago',
    'open for > 60 days',
    'active for 4 months',
    'live for 120 days',
    'requisition is 90 days old',
    'listing age exceeds 60 days'
  ];

  // Test age proof in closure validation
  for (const phrase of ageProofPhrases) {
    let threw = false;
    let errMsg = '';
    try {
      GuardrailEngine.validateClosure({
        type: 'explicit_closure_notice',
        proof: phrase,
        reason: 'closing requisition'
      });
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }

    assert.ok(
      threw,
      `GuardrailEngine.validateClosure should have thrown for proof: "${phrase}"`
    );
    assert.ok(
      errMsg.includes('Open vacancies cannot be closed or penalized due to posting age'),
      `Expected age penalty error for proof "${phrase}", got: ${errMsg}`
    );
  }

  // Test explicit age evidence types
  const ageEvidenceTypes = [
    'posting_age',
    'vacancy_age',
    'job_age',
    'requisition_age',
    'listing_age',
    'too_old',
    'age_limit',
    'stale',
    'days_old'
  ];

  for (const evType of ageEvidenceTypes) {
    let threw = false;
    let errMsg = '';
    try {
      GuardrailEngine.validateClosure({
        type: evType,
        proof: 'Evidence screenshot'
      });
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }

    assert.ok(threw, `GuardrailEngine should throw for evidence type: "${evType}"`);
    assert.ok(
      errMsg.includes('Open vacancies cannot be closed or penalized due to posting age'),
      `Expected age penalty error for type "${evType}", got: ${errMsg}`
    );
  }

  // Test days / postedAgeDays numeric properties
  for (const daysProp of [{ days: 90 }, { postedAgeDays: 120 }]) {
    let threw = false;
    try {
      GuardrailEngine.validateClosure({
        type: 'explicit_closure_notice',
        proof: 'Legitimate looking notice',
        ...daysProp
      });
    } catch (err) {
      threw = true;
    }
    assert.ok(threw, `GuardrailEngine should throw when evidence has ${JSON.stringify(daysProp)}`);
  }
});

// ============================================================================
// 2. NEGATIVE CONTROLS: LEGITIMATE REASONS MUST BE ALLOWED (0 FALSE POSITIVES)
// ============================================================================

suite.test('2.1 Negative Controls: Seniority & Experience rejection reasons allowed', async (assert) => {
  const seniorityReasons = [
    'Role requires 10+ years embedded firmware C++',
    'Candidate has 5 years experience in React',
    'Requires 3-5 years of product management experience',
    'Candidate lacks 7 years required leadership experience',
    'Position demands 8+ years distributed systems experience',
    'Only 2 years experience with Kubernetes, role mandates 5+ years',
    'Candidate has over 15 years experience, role is junior level'
  ];

  for (const reason of seniorityReasons) {
    const proposal = {
      type: 'triage_decision',
      jobId: 'job_legit_01',
      decision: 'reject',
      reason
    };

    const res = CompanionValidationGate.validateProposal(proposal);
    assert.equal(
      res.valid,
      true,
      `FALSE POSITIVE: Seniority reason "${reason}" was incorrectly blocked! Error: ${res.error}`
    );
    assert.equal(res.action, 'INGESTED_AS_PROPOSAL');
  }
});

suite.test('2.2 Negative Controls: Notice Period rejection reasons allowed', async (assert) => {
  const noticeReasons = [
    'Candidate notice period is over 60 days',
    'Notice period is 60 days',
    'Notice period of 90 days exceeds employer maximum of 30 days',
    'Candidate notice period is > 60 days',
    'Notice period: 90 days',
    'Notice window over 60 days is unacceptable to hiring manager',
    'Notice period is over 90 days',
    'Contractual notice period is 60 days and employer needs immediate start'
  ];

  for (const reason of noticeReasons) {
    const proposal = {
      type: 'triage_decision',
      jobId: 'job_legit_02',
      decision: 'exclude',
      reason
    };

    const res = CompanionValidationGate.validateProposal(proposal);
    assert.equal(
      res.valid,
      true,
      `FALSE POSITIVE: Notice period reason "${reason}" was incorrectly blocked! Error: ${res.error}`
    );
    assert.equal(res.action, 'INGESTED_AS_PROPOSAL');
  }
});

suite.test('2.3 Negative Controls: Probation Period rejection reasons allowed', async (assert) => {
  const probationReasons = [
    'Probation duration over 90 days',
    'Probation period is 180 days under Saudi labor law',
    'Probation window over 60 days is non-negotiable',
    'Probation duration is over 90 days',
    'Employer requires 90 days probation period before benefits kick in'
  ];

  for (const reason of probationReasons) {
    const proposal = {
      type: 'triage_decision',
      jobId: 'job_legit_03',
      decision: 'not_interested',
      reason
    };

    const res = CompanionValidationGate.validateProposal(proposal);
    assert.equal(
      res.valid,
      true,
      `FALSE POSITIVE: Probation period reason "${reason}" was incorrectly blocked! Error: ${res.error}`
    );
    assert.equal(res.action, 'INGESTED_AS_PROPOSAL');
  }
});

suite.test('2.4 Negative Controls: Compensation & Salary rejection reasons allowed', async (assert) => {
  const compReasons = [
    'Salary below candidate floor of 45,000 SAR',
    'Listed salary of 30,000 SAR is below minimum',
    'Compensation package 25,000 SAR below target',
    'Budget is 35,000 SAR per month, candidate floor is 40,000 SAR',
    'Base salary 20,000 SAR does not meet candidate expectations of 30,000 SAR'
  ];

  for (const reason of compReasons) {
    const proposal = {
      type: 'triage_decision',
      jobId: 'job_legit_04',
      decision: 'reject',
      reason
    };

    const res = CompanionValidationGate.validateProposal(proposal);
    assert.equal(
      res.valid,
      true,
      `FALSE POSITIVE: Compensation reason "${reason}" was incorrectly blocked! Error: ${res.error}`
    );
    assert.equal(res.action, 'INGESTED_AS_PROPOSAL');
  }
});

suite.test('2.5 Negative Controls: Valid Closure Proofs allowed in CompanionValidationGate and GuardrailEngine', async (assert) => {
  const validClosureProofs = [
    { type: 'explicit_closure_notice', proof: 'Position was filled 2 days ago' },
    { type: 'passed_deadline', proof: 'Deadline passed 3 days ago' },
    { type: 'explicit_closure_notice', proof: 'Job closed on 2026-10-20' },
    { type: 'explicit_closure_notice', proof: 'Employer confirmed role was filled 5 days ago' },
    { type: 'explicit_closure_notice', proof: 'Application window closed 1 day ago' },
    { type: 'passed_deadline', proof: 'Posting expired 4 days ago per careers portal' },
    { type: 'passed_deadline', proof: 'Application deadline passed 2 weeks ago' },
    { type: 'direct_rejection_email', proof: 'Candidate was interviewed 10 days ago and rejected' },
    { type: 'direct_rejection_email', proof: 'Applied 30 days ago with no response and status changed to rejected' },
    { type: 'explicit_closure_notice', proof: 'Requisition canceled 3 days ago' },
    { type: 'explicit_closure_notice', proof: 'Recruiter stated role was cancelled 2 days ago' }
  ];

  // Test in GuardrailEngine.validateClosure
  for (const item of validClosureProofs) {
    let threw = false;
    let errMsg = '';
    try {
      const valid = GuardrailEngine.validateClosure({
        type: item.type,
        proof: item.proof,
        reason: 'Valid closure proof'
      });
      assert.equal(valid, true);
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }

    assert.equal(
      threw,
      false,
      `FALSE POSITIVE in GuardrailEngine: Valid closure proof "${item.proof}" threw: ${errMsg}`
    );
  }

  // Test closure reasons in CompanionValidationGate
  for (const item of validClosureProofs) {
    const proposal = {
      type: 'triage_decision',
      jobId: 'job_legit_05',
      decision: 'exclude',
      reason: item.proof
    };

    const res = CompanionValidationGate.validateProposal(proposal);
    assert.equal(
      res.valid,
      true,
      `FALSE POSITIVE in CompanionValidationGate: Valid closure reason "${item.proof}" blocked! Error: ${res.error}`
    );
  }
});

suite.test('2.6 Negative Controls: Domain, Location, Contract and Leave reasons allowed', async (assert) => {
  const domainReasons = [
    'Requires relocation to Singapore, candidate restricted to KSA / Remote',
    'Company glassdoor ratings indicate toxic culture and high turnover',
    'Requires active security clearance which candidate does not possess',
    'Requires fluency in Japanese',
    'Contract duration is 6 months',
    'Contract period is 1 year',
    'Housing allowance is 25% of base',
    'Candidate vacation leave is 30 days',
    'Annual leave of 30 days per Saudi Labor Law',
    'Training period of 60 days'
  ];

  for (const reason of domainReasons) {
    const proposal = {
      type: 'triage_decision',
      jobId: 'job_legit_06',
      decision: 'reject',
      reason
    };

    const res = CompanionValidationGate.validateProposal(proposal);
    assert.equal(
      res.valid,
      true,
      `FALSE POSITIVE: Domain/contract reason "${reason}" was incorrectly blocked! Error: ${res.error}`
    );
  }
});

// ============================================================================
// 3. ADVERSARIAL STRESS & PERFORMANCE
// ============================================================================

suite.test('3.1 ReDoS / Catastrophic Backtracking Stress Check', async (assert) => {
  // Test large payload to ensure regex evaluates in linear time without stalling
  const longPrefix = 'posted '.repeat(100);
  const longSuffix = ' days ago'.repeat(100);
  const pathologicalString = longPrefix + '60' + longSuffix;

  const start = Date.now();
  const proposal = {
    type: 'triage_decision',
    jobId: 'job_stress_01',
    decision: 'reject',
    reason: pathologicalString
  };
  const res = CompanionValidationGate.validateProposal(proposal);
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 200, `Regex evaluation took ${elapsed}ms, exceeding 200ms limit! Possible ReDoS!`);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'GUARDRAIL_VIOLATION_AGE_PENALTY');
});

suite.test('3.2 Combined Multi-Field Aggregation Stress', async (assert) => {
  // When reason is clean but notes contains disguised age phrase
  const stealthProposal = {
    type: 'triage_decision',
    jobId: 'job_stealth_01',
    decision: 'exclude',
    reason: 'Role requires 5 years React experience',
    rationale: 'Candidate compensation matches requirements',
    notes: 'However vacancy age 120 days means role may be abandoned'
  };

  const res = CompanionValidationGate.validateProposal(stealthProposal);
  assert.equal(
    res.valid,
    false,
    `Multi-field aggregation failed: age phrase in notes was not detected!`
  );
  assert.equal(res.code, 'GUARDRAIL_VIOLATION_AGE_PENALTY');
});

async function runStress() {
  const summary = await suite.run({ verbose: true });
  console.log(`\nStress Results: ${summary.passed}/${summary.total} passed, ${summary.failed} failed.`);
  if (summary.failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runStress().catch(err => {
    console.error('Fatal stress suite failure:', err);
    process.exit(1);
  });
}

suite.suite = suite;
module.exports = suite;

