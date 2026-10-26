'use strict';

/**
 * Milestone M7 Iteration 3 Adversarial Security & Invariant Deep Probe
 *
 * Authored by: challenger_m7_iter3_2 (Empirical Challenger 2)
 *
 * Objective:
 * Empirically probe jobhunt-crew/lib/companion/bridge.js, validation.js,
 * and verify-claims.js against:
 * 1. Security Invariant Rule 1: Human-only submit invariant.
 * 2. Security Invariant Rule 2: Draft quarantine and anti-readiness invariant.
 * 3. Security Invariant Rule 4: Zero age penalty invariant.
 * 4. Path traversal defenses across identifiers, claimId, and employerId.
 * 5. Claim verification precision: discrete non-scale metrics (patents, awards, papers)
 *    to ensure downscoping is strictly blocked, contrasting with allowed scale metrics.
 *
 * Zero external dependencies: pure Node.js built-ins.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const { CompanionBridge } = require('../../lib/companion/bridge');
const { CompanionValidationGate } = require('../../lib/companion/validation');
const { ClaimVerifier, extractEntities } = require('../../lib/honest-cv/verify-claims');
const { EventLedger } = require('../../lib/ledger/ledger');
const { replayLedger } = require('../../lib/ledger/reducer');

const suite = new TestSuite('Challenger 2 M7 Adversarial Security & Invariants Deep Probe');

function createIsolatedWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-challenger2-probe-'));
  const crewDir = path.join(tmpDir, '.crew');
  const inboxDir = path.join(tmpDir, 'inbox');
  const proposalsDir = path.join(inboxDir, 'proposals');
  const processedDir = path.join(inboxDir, 'processed');
  const errorsDir = path.join(inboxDir, 'errors');

  fs.mkdirSync(crewDir, { recursive: true });
  fs.mkdirSync(proposalsDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });
  fs.mkdirSync(errorsDir, { recursive: true });

  fs.writeFileSync(path.join(crewDir, 'ledger.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(crewDir, 'snapshot.json'),
    JSON.stringify({
      version: 1,
      lastEventId: 0,
      updatedAt: new Date().toISOString(),
      jobs: {
        'job_aws_01': {
          id: 'job_aws_01',
          title: 'Principal Distributed Systems Engineer',
          company: 'AWS',
          status: 'shortlisted'
        }
      },
      applications: {},
      decisions: []
    }, null, 2),
    'utf8'
  );

  const dossierContent = {
    profile: {
      name: 'Dr. Evelyn Vance',
      title: 'Principal Systems Architect',
      location: 'Riyadh, KSA'
    },
    patents: [
      { id: 'pat_01', title: 'Distributed Consensus Protocol', year: 2020 }
    ],
    awards: [
      { id: 'awd_01', name: 'Excellence in Cloud Infrastructure Resilience', year: 2022 }
    ],
    employers: [
      { id: 'emp_stripe', name: 'Stripe', startYear: 2018, endYear: 2021, isCurrent: false },
      { id: 'emp_google', name: 'Google', startYear: 2021, endYear: 2024, isCurrent: true }
    ],
    claims: [
      {
        id: 'C-01',
        employerId: 'emp_stripe',
        text: 'Granted 5 patents on distributed consensus protocols and lock-free data structures at Stripe.',
        status: 'VERIFIED',
        metrics: ['5 patents'],
        tools: ['Go']
      },
      {
        id: 'C-02',
        employerId: 'emp_google',
        text: 'Received 3 industry awards for excellence in cloud infrastructure resilience at Google.',
        status: 'VERIFIED',
        metrics: ['3 industry awards'],
        tools: ['Kubernetes']
      },
      {
        id: 'C-03',
        employerId: 'emp_google',
        text: 'Published 4 papers on Byzantine fault tolerance in multi-region clusters at Google.',
        status: 'VERIFIED',
        metrics: ['4 papers'],
        tools: ['Spanner']
      },
      {
        id: 'C-04',
        employerId: 'emp_stripe',
        text: 'Operated 10 Kubernetes clusters and 25 microservices handling production traffic at Stripe.',
        status: 'VERIFIED',
        metrics: ['10 clusters', '25 microservices'],
        tools: ['Kubernetes', 'Istio']
      },
      {
        id: 'C-05',
        employerId: 'emp_google',
        text: 'Managed $2.5 million AWS cloud infrastructure budget and led 1 systems engineer at Google.',
        status: 'VERIFIED',
        metrics: ['$2.5 million budget', '1 systems engineer'],
        tools: ['AWS']
      }
    ]
  };

  fs.writeFileSync(path.join(tmpDir, 'dossier.json'), JSON.stringify(dossierContent, null, 2), 'utf8');

  return { tmpDir, proposalsDir, processedDir, errorsDir, crewDir, dossierContent };
}

// ============================================================================
// SECTION 1: RULE 1 HUMAN-ONLY SUBMIT INVARIANT PROBES
// ============================================================================

suite.test('Rule 1: Direct action/status/event submission declarations are blocked', async (assert) => {
  const attackVariants = [
    { type: 'status_update', jobId: 'job_aws_01', action: 'submitted' },
    { type: 'status_update', jobId: 'job_aws_01', status: 'submitted' },
    { type: 'status_update', jobId: 'job_aws_01', event: 'submitted' },
    { type: 'status_update', jobId: 'job_aws_01', action: 'SUBMIT' },
    { type: 'status_update', jobId: 'job_aws_01', status: 'SUBMITTING' },
    { type: 'status_update', jobId: 'job_aws_01', action: 'application_submitted' },
    { type: 'status_update', jobId: 'job_aws_01', status: 'job_submitted' },
    { type: 'status_update', jobId: 'job_aws_01', event: 'application_submitted' },
    { type: 'submitted', jobId: 'job_aws_01' },
    { type: 'submission', jobId: 'job_aws_01' },
    { type: 'SUBMISSION', jobId: 'job_aws_01' }
  ];

  for (const variant of attackVariants) {
    const verdict = CompanionValidationGate.validateProposal(variant);
    assert.ok(!verdict.valid, `Expected variant ${JSON.stringify(variant)} to be rejected`);
    assert.ok(!verdict.ingested, `Expected variant ${JSON.stringify(variant)} not to be ingested`);
    assert.equal(verdict.code, 'GUARDRAIL_VIOLATION_SUBMISSION_BLOCKED');
    assert.equal(verdict.ruleViolated, 'RULE_1_STRICT_HUMAN_SUBMISSION');
    assert.equal(verdict.stateCorrupted, false);
  }
});

suite.test('Rule 1: Nested payload and details submission declarations are blocked', async (assert) => {
  const attackVariants = [
    { type: 'status_update', jobId: 'job_aws_01', payload: { action: 'submitted' } },
    { type: 'status_update', jobId: 'job_aws_01', payload: { status: 'submitted' } },
    { type: 'status_update', jobId: 'job_aws_01', payload: { event: 'submitted' } },
    { type: 'status_update', jobId: 'job_aws_01', details: { submitted: true } },
    { type: 'status_update', jobId: 'job_aws_01', details: { submitted: 'true' } },
    { type: 'status_update', jobId: 'job_aws_01', details: { status: 'submitted' } },
    { type: 'status_update', jobId: 'job_aws_01', details: { action: 'submit' } },
    { type: 'triage_decision', jobId: 'job_aws_01', details: { submitted: true }, decision: 'shortlist' },
    { type: 'draft_proposal', jobId: 'job_aws_01', details: { submitted: 'TRUE' }, draftText: 'CV content' }
  ];

  for (const variant of attackVariants) {
    const verdict = CompanionValidationGate.validateProposal(variant);
    assert.ok(!verdict.valid, `Expected variant ${JSON.stringify(variant)} to be rejected`);
    assert.equal(verdict.code, 'GUARDRAIL_VIOLATION_SUBMISSION_BLOCKED');
  }
});

suite.test('Rule 1: CompanionBridge rejects submission proposals and generates error sidecars with 0 ledger writes', async (assert) => {
  const { tmpDir, proposalsDir, errorsDir, crewDir } = createIsolatedWorkspace();
  const bridge = new CompanionBridge({ workspaceDir: tmpDir });

  const attackFile = path.join(proposalsDir, 'attack-submit.json');
  fs.writeFileSync(attackFile, JSON.stringify({
    type: 'status_update',
    jobId: 'job_aws_01',
    action: 'submitted',
    actor: 'gemini_companion'
  }), 'utf8');

  const res = await bridge.ingestFile(attackFile);
  assert.equal(res.success, false);
  assert.equal(res.code, 'GUARDRAIL_VIOLATION_SUBMISSION_BLOCKED');
  assert.equal(res.stateCorrupted, false);

  // Check ledger remained empty
  const ledgerContent = fs.readFileSync(path.join(crewDir, 'ledger.jsonl'), 'utf8').trim();
  assert.equal(ledgerContent, '', 'Ledger must have 0 events');

  // Check errors directory contains quarantined file and sidecar
  const errorFiles = fs.readdirSync(errorsDir);
  const sidecars = errorFiles.filter(f => f.endsWith('.error.json'));
  assert.equal(sidecars.length, 1);
  const sidecar = JSON.parse(fs.readFileSync(path.join(errorsDir, sidecars[0]), 'utf8'));
  assert.equal(sidecar.code, 'GUARDRAIL_VIOLATION_SUBMISSION_BLOCKED');
  assert.equal(sidecar.stateCorrupted, false);
});

// ============================================================================
// SECTION 2: RULE 2 DRAFT QUARANTINE & ANTI-READINESS INVARIANT PROBES
// ============================================================================

suite.test('Rule 2: Valid companion draft is strictly quarantined with HOLD_FOR_CLAIM_VERIFICATION', async (assert) => {
  const { tmpDir, proposalsDir, processedDir, crewDir } = createIsolatedWorkspace();
  const bridge = new CompanionBridge({ workspaceDir: tmpDir });

  const draftFile = path.join(proposalsDir, 'draft-proposal-01.json');
  fs.writeFileSync(draftFile, JSON.stringify({
    type: 'draft_proposal',
    jobId: 'job_aws_01',
    draftType: 'cv',
    draftText: 'Granted 5 patents on distributed consensus protocols at Stripe.',
    claimsUsed: ['C-01']
  }), 'utf8');

  const res = await bridge.ingestFile(draftFile);
  assert.equal(res.success, true);
  assert.equal(res.action, 'HOLD_FOR_CLAIM_VERIFICATION');
  assert.equal(res.stateCorrupted, false);

  // Proposal moved to processed
  assert.ok(!fs.existsSync(draftFile));
  const processedFiles = fs.readdirSync(processedDir);
  assert.equal(processedFiles.length, 1);

  // Check event written to ledger has unverified: true
  const ledgerLines = fs.readFileSync(path.join(crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(ledgerLines.length, 1);
  const evt = JSON.parse(ledgerLines[0]);
  assert.equal(evt.event, 'DRAFT_GENERATED');
  assert.equal(evt.payload.unverified, true);
  assert.equal(evt.payload.status, 'pending_inquisitor_verification');
});

suite.test('Rule 2: Premature readiness declarations are rejected with GUARDRAIL_VIOLATION_PREMATURE_READINESS', async (assert) => {
  const readinessVariants = [
    { type: 'draft_proposal', jobId: 'job_aws_01', draftText: 'Some CV text', status: 'ready' },
    { type: 'draft_proposal', jobId: 'job_aws_01', draftText: 'Some CV text', status: 'READY' },
    { type: 'draft_proposal', jobId: 'job_aws_01', draftText: 'Some CV text', status: 'ready-to-submit' },
    { type: 'draft_proposal', jobId: 'job_aws_01', draftText: 'Some CV text', status: 'ready_to_submit' },
    { type: 'draft_proposal', jobId: 'job_aws_01', draftText: 'Some CV text', status: 'verified' },
    { type: 'draft_proposal', jobId: 'job_aws_01', draftText: 'Some CV text', status: 'approved' },
    { type: 'draft_proposal', jobId: 'job_aws_01', draftText: 'Some CV text', action: 'ready' },
    { type: 'draft_proposal', jobId: 'job_aws_01', draftText: 'Some CV text', action: 'approved' },
    { type: 'draft_proposal', jobId: 'job_aws_01', draftText: 'Some CV text', verified: true },
    { type: 'draft_proposal', jobId: 'job_aws_01', draftText: 'Some CV text', verified: 'true' }
  ];

  for (const variant of readinessVariants) {
    const verdict = CompanionValidationGate.validateProposal(variant);
    assert.ok(!verdict.valid, `Expected premature readiness to fail: ${JSON.stringify(variant)}`);
    assert.equal(verdict.code, 'GUARDRAIL_VIOLATION_PREMATURE_READINESS');
    assert.equal(verdict.ruleViolated, 'RULE_2_DRAFT_QUARANTINE');
  }
});

// ============================================================================
// SECTION 3: RULE 4 ZERO AGE PENALTY INVARIANT PROBES
// ============================================================================

suite.test('Rule 4: Vacancy closure or rejection based on posting age is strictly blocked', async (assert) => {
  const agePenaltyAttacks = [
    { type: 'triage_decision', jobId: 'job_aws_01', decision: 'not_interested', reason: 'Posting is 120 days old' },
    { type: 'triage_decision', jobId: 'job_aws_01', decision: 'reject', rationale: 'Older than 60 days, stale job' },
    { type: 'triage_decision', jobId: 'job_aws_01', decision: 'exclude', notes: 'Exceeded posting age limit' },
    { type: 'triage_decision', jobId: 'job_aws_01', decision: 'not_interested', evidence: { type: 'posting_age', days: 90 } },
    { type: 'triage_decision', jobId: 'job_aws_01', decision: 'reject', evidence: { type: 'posting age' } },
    { type: 'triage_decision', jobId: 'job_aws_01', decision: 'exclude', evidence: { postedAgeDays: 45 } },
    { type: 'triage_decision', jobId: 'job_aws_01', decision: 'not_interested', reason: 'Salary mismatch', notes: 'Also 90 days old' }
  ];

  for (const attack of agePenaltyAttacks) {
    const verdict = CompanionValidationGate.validateProposal(attack);
    assert.ok(!verdict.valid, `Expected age penalty attack to fail: ${JSON.stringify(attack)}`);
    assert.equal(verdict.code, 'GUARDRAIL_VIOLATION_AGE_PENALTY');
    assert.equal(verdict.ruleViolated, 'AGE_PENALTY_INVARIANT');
  }
});

suite.test('Rule 4: Legitimate vacancy closure (non-age reasons) is permitted', async (assert) => {
  const legitimate = {
    type: 'triage_decision',
    jobId: 'job_aws_01',
    decision: 'not_interested',
    reason: 'Candidate does not possess required Scala background',
    evidence: {
      type: 'explicit_closure_notice',
      proof: 'Candidate declined role due to technology mismatch'
    }
  };

  const verdict = CompanionValidationGate.validateProposal(legitimate);
  assert.ok(verdict.valid);
  assert.ok(verdict.ingested);
  assert.equal(verdict.decision, 'not_interested');
});

// ============================================================================
// SECTION 4: PATH TRAVERSAL DEFENSES ACROSS ALL IDENTIFIER VECTORS
// ============================================================================

suite.test('Security: Path traversal defenses block attacks across jobId, claimId, and employerId', async (assert) => {
  const attackPayloads = [
    '../../etc/passwd',
    '..\\..\\Windows\\System32\\calc.exe',
    '../../../shadow',
    'C:\\boot.ini',
    '/etc/shadow',
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '%252e%252e%252fsecret',
    '.',
    '..',
    '....',
    'job\x00id',
    'job<evil>id',
    'job:stream',
    'job|pipe',
    'job?wild',
    'job*glob'
  ];

  for (const payload of attackPayloads) {
    // 1. Attack in jobId (triage_decision)
    const triageAttack = { type: 'triage_decision', jobId: payload, decision: 'shortlist' };
    const triageRes = CompanionValidationGate.validateProposal(triageAttack);
    assert.ok(!triageRes.valid, `Expected jobId "${payload}" to be rejected`);
    assert.equal(triageRes.code, 'SECURITY_VIOLATION');

    // 2. Attack in draft_proposal jobId
    const draftAttack = { type: 'draft_proposal', jobId: payload, draftText: 'CV text' };
    const draftRes = CompanionValidationGate.validateProposal(draftAttack);
    assert.ok(!draftRes.valid, `Expected draft jobId "${payload}" to be rejected`);
    assert.equal(draftRes.code, 'SECURITY_VIOLATION');

    // 3. Attack in claim_confirmation claimId
    const claimConfirmAttack = { type: 'claim_confirmation', claimId: payload, evidence: 'valid proof' };
    const confirmRes = CompanionValidationGate.validateProposal(claimConfirmAttack);
    assert.ok(!confirmRes.valid, `Expected claimId "${payload}" to be rejected`);
    assert.equal(confirmRes.code, 'SECURITY_VIOLATION');

    // 4. Attack in claim_confirmation with brackets [../../secret]
    const bracketAttack = { type: 'claim_confirmation', claimId: `[${payload}]`, evidence: 'valid proof' };
    const bracketRes = CompanionValidationGate.validateProposal(bracketAttack);
    assert.ok(!bracketRes.valid, `Expected bracket claimId "[${payload}]" to be rejected`);
    assert.equal(bracketRes.code, 'SECURITY_VIOLATION');

    // 5. Attack in claim_proposal employerId
    const employerAttack = {
      type: 'claim_proposal',
      claimText: 'Some achievement',
      employerId: payload
    };
    const empRes = CompanionValidationGate.validateProposal(employerAttack);
    assert.ok(!empRes.valid, `Expected employerId "${payload}" to be rejected`);
    assert.equal(empRes.code, 'SECURITY_VIOLATION');
  }
});

suite.test('Security: Unknown employerId in claim_proposal is blocked when dossier is provided', async (assert) => {
  const { dossierContent } = createIsolatedWorkspace();

  const unknownEmpProposal = {
    type: 'claim_proposal',
    claimText: 'Engineered high-throughput queuing system',
    employerId: 'emp_unknown_evil_corp'
  };

  const verdict = CompanionValidationGate.validateProposal(unknownEmpProposal, { dossier: dossierContent });
  assert.ok(!verdict.valid);
  assert.equal(verdict.code, 'UNKNOWN_EMPLOYER');
});

// ============================================================================
// SECTION 5: CLAIM VERIFICATION PRECISION — DISCRETE NON-SCALE METRICS
// ============================================================================

suite.test('Claim Verification: Discrete accomplishments (patents, awards, papers) block downscoping', async (assert) => {
  const { dossierContent } = createIsolatedWorkspace();

  // Test Case 1: Patents (Verified: 5 patents at Stripe)
  // Clean match (5 patents) -> MUST PASS
  const cleanPatents = 'Granted 5 patents on distributed consensus protocols and lock-free data structures at Stripe.';
  const resCleanPatents = ClaimVerifier.verifyDraft(dossierContent, cleanPatents, { claimIds: ['C-01'] });
  assert.ok(resCleanPatents.passed, `Clean patents draft must pass verification: ${JSON.stringify(resCleanPatents.violations)}`);

  // Downscoped (3 patents) -> MUST FAIL (patents are discrete, NOT scale units!)
  const downscopedPatents = 'Granted 3 patents on distributed consensus protocols and lock-free data structures at Stripe.';
  const resDownPatents = ClaimVerifier.verifyDraft(dossierContent, downscopedPatents, { claimIds: ['C-01'] });
  assert.ok(!resDownPatents.passed, 'Downscoped patents (3 vs verified 5) must be rejected');
  const patentViolations = resDownPatents.violations.map(v => v.code);
  assert.ok(patentViolations.includes('METRIC_INFLATION') || patentViolations.includes('SCOPE_INFLATION'),
    `Expected METRIC_INFLATION or SCOPE_INFLATION but got ${patentViolations.join(', ')}`);

  // Inflated (7 patents) -> MUST FAIL
  const inflatedPatents = 'Granted 7 patents on distributed consensus protocols and lock-free data structures at Stripe.';
  const resInfPatents = ClaimVerifier.verifyDraft(dossierContent, inflatedPatents, { claimIds: ['C-01'] });
  assert.ok(!resInfPatents.passed, 'Inflated patents (7 vs verified 5) must be rejected');

  // Test Case 2: Awards (Verified: 3 industry awards at Google)
  // Clean match (3 awards) -> MUST PASS
  const cleanAwards = 'Received 3 industry awards for excellence in cloud infrastructure resilience at Google.';
  const resCleanAwards = ClaimVerifier.verifyDraft(dossierContent, cleanAwards, { claimIds: ['C-02'] });
  assert.ok(resCleanAwards.passed, `Clean awards draft must pass: ${JSON.stringify(resCleanAwards.violations)}`);

  // Downscoped (1 award) -> MUST FAIL (awards are discrete!)
  const downscopedAwards = 'Received 1 industry award for excellence in cloud infrastructure resilience at Google.';
  const resDownAwards = ClaimVerifier.verifyDraft(dossierContent, downscopedAwards, { claimIds: ['C-02'] });
  assert.ok(!resDownAwards.passed, 'Downscoped awards (1 vs verified 3) must be rejected');

  // Inflated (4 awards) -> MUST FAIL
  const inflatedAwards = 'Received 4 industry awards for excellence in cloud infrastructure resilience at Google.';
  const resInfAwards = ClaimVerifier.verifyDraft(dossierContent, inflatedAwards, { claimIds: ['C-02'] });
  assert.ok(!resInfAwards.passed, 'Inflated awards (4 vs verified 3) must be rejected');

  // Test Case 3: Research Papers (Verified: 4 papers at Google)
  // Clean match (4 papers) -> MUST PASS
  const cleanPapers = 'Published 4 papers on Byzantine fault tolerance in multi-region clusters at Google.';
  const resCleanPapers = ClaimVerifier.verifyDraft(dossierContent, cleanPapers, { claimIds: ['C-03'] });
  assert.ok(resCleanPapers.passed, `Clean papers draft must pass: ${JSON.stringify(resCleanPapers.violations)}`);

  // Downscoped (2 papers) -> MUST FAIL (papers are discrete!)
  const downscopedPapers = 'Published 2 papers on Byzantine fault tolerance in multi-region clusters at Google.';
  const resDownPapers = ClaimVerifier.verifyDraft(dossierContent, downscopedPapers, { claimIds: ['C-03'] });
  assert.ok(!resDownPapers.passed, 'Downscoped papers (2 vs verified 4) must be rejected');

  // Inflated (5 papers) -> MUST FAIL
  const inflatedPapers = 'Published 5 papers on Byzantine fault tolerance in multi-region clusters at Google.';
  const resInfPapers = ClaimVerifier.verifyDraft(dossierContent, inflatedPapers, { claimIds: ['C-03'] });
  assert.ok(!resInfPapers.passed, 'Inflated papers (5 vs verified 4) must be rejected');
});

suite.test('Claim Verification: Contrast with true scale metrics (clusters, services) which allow downscoping', async (assert) => {
  const { dossierContent } = createIsolatedWorkspace();

  // Baseline C-04: 'Operated 10 Kubernetes clusters and 25 microservices handling production traffic at Stripe.'
  // Downscoped scale metrics (5 clusters and 12 microservices) -> MUST PASS!
  const downscopedScale = 'Operated 5 Kubernetes clusters and 12 microservices handling production traffic at Stripe.';
  const resDownScale = ClaimVerifier.verifyDraft(dossierContent, downscopedScale, { claimIds: ['C-04'] });
  assert.ok(resDownScale.passed, `Downscoped scale metrics should be permitted: ${JSON.stringify(resDownScale.violations)}`);

  // Inflated scale metrics (15 clusters) -> MUST FAIL!
  const inflatedScale = 'Operated 15 Kubernetes clusters handling production traffic at Stripe.';
  const resInfScale = ClaimVerifier.verifyDraft(dossierContent, inflatedScale, { claimIds: ['C-04'] });
  assert.ok(!resInfScale.passed, 'Inflated scale metrics (15 vs 10 clusters) must be rejected');
});

suite.test('Claim Verification: Currency masking prevents decimal bleed and preserves singular headcounts', async (assert) => {
  const { dossierContent } = createIsolatedWorkspace();

  // Baseline C-05: 'Managed $2.5 million AWS cloud infrastructure budget and led 1 systems engineer at Google.'
  const cleanBudgetAndHeadcount = 'Managed $2.5 million AWS cloud infrastructure budget and led 1 systems engineer at Google.';
  const res = ClaimVerifier.verifyDraft(dossierContent, cleanBudgetAndHeadcount, { claimIds: ['C-05'] });
  assert.ok(res.passed, `Currency $2.5M and 1 systems engineer must verify cleanly: ${JSON.stringify(res.violations)}`);

  // Verify entity extraction on the phrase
  const extracted = extractEntities(cleanBudgetAndHeadcount);
  assert.equal(extracted.currencies.length, 1);
  assert.equal(extracted.currencies[0].amount, 2500000);
  assert.equal(extracted.headcounts.length, 1);
  assert.equal(extracted.headcounts[0].count, 1);
  assert.equal(extracted.headcounts[0].unit, 'systems engineer');

  // Ensure no spurious non-headcount count of '5 million' or truncated 'systems' was extracted
  const spuriousCounts = extracted.counts.filter(c => !c.isHeadcount || c.unit === 'systems' || c.unit.includes('million'));
  assert.equal(spuriousCounts.length, 0, `Spurious count extraction detected: ${JSON.stringify(spuriousCounts)}`);
});

suite.test('Claim Verification: Repetition phrases ("Ran benchmark 5 times") do not extract spurious count entities', async (assert) => {
  const repetitionText = 'Ran the performance benchmark 5 times across test environments to validate latency.';
  const extracted = extractEntities(repetitionText);
  // 'times' is in NON_COUNT_NOUNS so it must not be extracted as a count metric
  const timeCounts = extracted.counts.filter(c => c.unit === 'time' || c.unit === 'times' || c.baseUnit === 'time');
  assert.equal(timeCounts.length, 0, `Spurious "time" count extracted: ${JSON.stringify(timeCounts)}`);
});

suite.test('Security: Windows Alternate Data Streams (ADS) and mixed slash sequences are rejected', async (assert) => {
  const adsPayloads = [
    'job_aws_01:evil::$DATA',
    'job/../../secret',
    'job\\..\\..\\secret',
    '..\\../etc/passwd',
    'C:/Windows/System32'
  ];

  for (const payload of adsPayloads) {
    const verdict = CompanionValidationGate.validateProposal({
      type: 'triage_decision',
      jobId: payload,
      decision: 'shortlist'
    });
    assert.ok(!verdict.valid, `Expected ADS/mixed-slash payload "${payload}" to be rejected`);
    assert.equal(verdict.code, 'SECURITY_VIOLATION');
  }
});

suite.test('Rule 3: Candidate fact proposals enforce CONFIRM status and block VERIFIED promotion', async (assert) => {
  const { dossierContent } = createIsolatedWorkspace();

  // Attempting to directly submit a fact as VERIFIED -> MUST FAIL
  const verifiedAttempt = {
    type: 'candidate_fact_proposal',
    claimText: 'Contributed to Apache Kafka open source project',
    employerId: 'emp_stripe',
    status: 'VERIFIED'
  };
  const resVer = CompanionValidationGate.validateProposal(verifiedAttempt, { dossier: dossierContent });
  assert.ok(!resVer.valid);
  assert.equal(resVer.code, 'GUARDRAIL_VIOLATION_CLAIM_ELEVATION');
  assert.equal(resVer.ruleViolated, 'RULE_3_CLAIM_GATING');

  // Valid fact proposal -> Ingested as CONFIRM
  const validFact = {
    type: 'candidate_fact_proposal',
    claimText: 'Contributed to Apache Kafka open source project',
    employerId: 'emp_stripe'
  };
  const resValid = CompanionValidationGate.validateProposal(validFact, { dossier: dossierContent });
  assert.ok(resValid.valid);
  assert.ok(resValid.ingested);
  assert.equal(resValid.status, 'CONFIRM');
});

suite.test('Lifecycle: Ingestion of all 4 proposal kinds interleaved with attacks preserves ledger integrity', async (assert) => {
  const { tmpDir, proposalsDir, processedDir, errorsDir, crewDir, dossierContent } = createIsolatedWorkspace();
  const bridge = new CompanionBridge({ workspaceDir: tmpDir });

  // 1. Valid triage decision
  fs.writeFileSync(path.join(proposalsDir, '01-triage.json'), JSON.stringify({
    type: 'triage_decision',
    jobId: 'job_aws_01',
    decision: 'shortlist',
    score: 4.8
  }), 'utf8');

  // 2. Attack: Rule 1 submission attempt
  fs.writeFileSync(path.join(proposalsDir, '02-attack-submit.json'), JSON.stringify({
    type: 'status_update',
    jobId: 'job_aws_01',
    action: 'submitted'
  }), 'utf8');

  // 3. Valid draft proposal (quarantined)
  fs.writeFileSync(path.join(proposalsDir, '03-draft.json'), JSON.stringify({
    type: 'draft_proposal',
    jobId: 'job_aws_01',
    draftText: 'Operated 5 Kubernetes clusters at Stripe.',
    claimsUsed: ['C-04']
  }), 'utf8');

  // 4. Attack: Path traversal in employerId
  fs.writeFileSync(path.join(proposalsDir, '04-attack-traversal.json'), JSON.stringify({
    type: 'claim_proposal',
    claimText: 'Some claim',
    employerId: '../../etc/passwd'
  }), 'utf8');

  // 5. Valid pack approval
  fs.writeFileSync(path.join(proposalsDir, '05-approval.json'), JSON.stringify({
    type: 'pack_approval',
    jobId: 'job_aws_01',
    verdict: 'APPROVE',
    notes: 'Reviewed and confirmed by human candidate'
  }), 'utf8');

  const sweep = await bridge.ingestAll();
  assert.equal(sweep.summary.ingestedCount, 3);
  assert.equal(sweep.summary.quarantinedCount, 1); // 03-draft is quarantined
  assert.equal(sweep.summary.errorCount, 2); // 02-attack and 04-attack

  // Verify processed directory
  const processedFiles = fs.readdirSync(processedDir);
  assert.equal(processedFiles.length, 3);

  // Verify errors directory
  const errorSidecars = fs.readdirSync(errorsDir).filter(f => f.endsWith('.error.json'));
  assert.equal(errorSidecars.length, 2);

  // Verify ledger has exactly 3 events with valid hash chain
  const ledgerLines = fs.readFileSync(path.join(crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(ledgerLines.length, 3);

  let expectedPrevHash = '0'.repeat(64);
  for (let i = 0; i < ledgerLines.length; i++) {
    const evt = JSON.parse(ledgerLines[i]);
    assert.equal(evt.id, i + 1);
    assert.equal(evt.prevHash, expectedPrevHash);
    // In EventLedger, the next event's prevHash is sha256(currentLine)
    const crypto = require('crypto');
    expectedPrevHash = crypto.createHash('sha256').update(ledgerLines[i].trim()).digest('hex');
  }
});

// Run all test cases in the probe suite
async function runProbe() {
  const results = await suite.run({ verbose: true });
  console.log(`\nProbe Results: ${results.passed}/${results.total} passed, ${results.failed} failed.`);
  if (results.failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runProbe().catch(err => {
    console.error('Fatal probe failure:', err);
    process.exit(1);
  });
}

module.exports = { suite };
