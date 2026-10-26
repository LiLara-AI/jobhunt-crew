'use strict';

/**
 * Milestone M7 Iteration 4 Adversarial Security & Invariant Deep Probe
 *
 * Authored by: challenger_m7_iter4_2 (Empirical Challenger)
 * Scope:
 *   1. Path Traversal & Identifier Boundary Matrix:
 *      - Dot variations (., .., ..., ...., a..b, etc.)
 *      - Multi-layer URL encodings (%2e%2e%2f, %252e%252e%252f)
 *      - Slashes and backslashes (POSIX, Windows, mixed)
 *      - Null bytes and ASCII control characters (\x00, \x1f, %00)
 *      - Windows Alternate Data Streams (ADS) and reserved device names
 *      - Non-string, blank, whitespace identifiers
 *   2. Proposal Validation Gate Adversarial Inputs:
 *      - Unknown proposal types and action types
 *      - Missing required fields across all 4 proposal kinds
 *      - Non-string identifiers (numbers, objects, arrays, booleans)
 *      - Casing variations for Rule 1: SUBMITTED, Submitted, sUbMiTtEd, SUBMISSION, etc.
 *      - Casing variations for verdicts (APPROVE, approve, REJECT, reject) and decisions
 *      - Premature readiness casing: READY, ready-to-submit, APPROVED, verified: "TRUE"
 *      - Age penalty bypass attempts: posting_age, age limit, stale vacancy, 120 days old
 *      - Legitimate vacancy rejection preservation (salary, relocation, tech stack)
 *   3. Malformed, Corrupt & Boundary Files:
 *      - 0-byte empty file, whitespace-only, truncated JSON, raw binary, 1MB huge payload
 *      - Non-object JSON roots (arrays, numbers, strings, null, booleans)
 *   4. Sidecar Diagnostics & State Integrity:
 *      - Diagnostic .error.json sidecar schema validation
 *      - Ledger append immunity (zero events emitted on error)
 *      - Hash chain unbroken and sequential IDs preserved after errors
 *      - Snapshot uncorrupted and resilient to corrupt proposals
 *
 * Zero external dependencies. Uses Node.js built-ins.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { TestSuite } = require('../helpers/test-harness');
const { CompanionBridge } = require('../../lib/companion/bridge');
const { CompanionValidationGate } = require('../../lib/companion/validation');
const { EventLedger } = require('../../lib/ledger/ledger');
const { replayLedger } = require('../../lib/ledger/reducer');

const suite = new TestSuite('M7 Iteration 4 Adversarial Deep Probe: Security & Invariant Matrix');

/**
 * Helper to build an isolated, temporary workspace for testing.
 */
function createIsolatedWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-m7-iter4-probe-'));
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
        'job_cloud_01': {
          id: 'job_cloud_01',
          title: 'Staff Infrastructure Architect',
          company: 'Cloud Corp',
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
      name: 'Dr. Morgan Vance',
      title: 'Principal Systems Architect',
      location: 'Riyadh, KSA'
    },
    employers: [
      { id: 'emp_aws', name: 'Amazon Web Services', isCurrent: false },
      { id: 'emp_stc', name: 'STC Cloud', isCurrent: true }
    ],
    claims: [
      {
        id: 'C-01',
        employerId: 'emp_aws',
        text: 'Designed multi-region failover architecture for 14 enterprise services',
        status: 'VERIFIED',
        metrics: ['14 enterprise services'],
        tools: ['AWS', 'Terraform']
      }
    ]
  };

  fs.writeFileSync(path.join(tmpDir, 'dossier.json'), JSON.stringify(dossierContent, null, 2), 'utf8');

  return { tmpDir, crewDir, inboxDir, proposalsDir, processedDir, errorsDir, dossierContent };
}

// ============================================================================
// SUITE 1: PATH TRAVERSAL & IDENTIFIER ADVERSARIAL MATRIX
// ============================================================================

suite.test('1.1 sanitizeIdentifier blocks relative dot-dot and dot sequences', async (assert) => {
  const dotAttacks = [
    '.',
    '..',
    '...',
    '....',
    '.....',
    '..\\..\\secret',
    '../../etc/passwd',
    'subdir/../file',
    'subdir\\..\\file',
    'a..b',
    '..test',
    'test..'
  ];

  for (const attack of dotAttacks) {
    let threw = false;
    let errCode = '';
    try {
      CompanionValidationGate.sanitizeIdentifier(attack);
    } catch (e) {
      threw = true;
      errCode = e.message;
    }
    assert.ok(threw, `Expected attack "${attack}" to throw Error`);
    assert.ok(
      errCode.startsWith('SECURITY_VIOLATION') || errCode.startsWith('IDENTIFIER_ERROR'),
      `Expected SECURITY_VIOLATION or IDENTIFIER_ERROR for "${attack}", got: ${errCode}`
    );
  }
});

suite.test('1.2 sanitizeIdentifier blocks multi-layer percent-encoded traversals', async (assert) => {
  const encodedAttacks = [
    '%2e%2e%2f',
    '%2e%2e/',
    '..%2f',
    '%2e%2e%5c',
    '..%5c',
    '%252e%252e%252f',       // double encoded
    '%25252e%25252e%25252f', // triple encoded
    '%2e%2e%2fetc%2fpasswd',
    '..%252f..%252f',
    '%2e.%2f',
    '.%2e/'
  ];

  for (const attack of encodedAttacks) {
    let threw = false;
    let errMsg = '';
    try {
      CompanionValidationGate.sanitizeIdentifier(attack);
    } catch (e) {
      threw = true;
      errMsg = e.message;
    }
    assert.ok(threw, `Expected encoded attack "${attack}" to throw Error`);
    assert.ok(errMsg.startsWith('SECURITY_VIOLATION'), `Expected SECURITY_VIOLATION for "${attack}", got: ${errMsg}`);
  }
});

suite.test('1.3 sanitizeIdentifier blocks null bytes, control chars, and NTFS ADS', async (assert) => {
  const charAttacks = [
    'job\x00id',
    'job\x1fid',
    'job\x0aid',
    'job\x0did',
    'job%00id',
    'job:stream',
    'file.json::$DATA',
    'job<1>',
    'job>1',
    'job|pipe',
    'job?query',
    'job*wildcard',
    'job"quote'
  ];

  for (const attack of charAttacks) {
    let threw = false;
    let errMsg = '';
    try {
      CompanionValidationGate.sanitizeIdentifier(attack);
    } catch (e) {
      threw = true;
      errMsg = e.message;
    }
    assert.ok(threw, `Expected illegal char attack "${attack}" to throw Error`);
    assert.ok(errMsg.startsWith('SECURITY_VIOLATION'), `Expected SECURITY_VIOLATION for "${attack}", got: ${errMsg}`);
  }
});

suite.test('1.4 sanitizeIdentifier rejects non-string and blank inputs with IDENTIFIER_ERROR', async (assert) => {
  const invalidInputs = [
    '',
    '   ',
    '\t\n\r',
    null,
    undefined,
    12345,
    true,
    false,
    {},
    []
  ];

  for (const input of invalidInputs) {
    let threw = false;
    let errMsg = '';
    try {
      CompanionValidationGate.sanitizeIdentifier(input);
    } catch (e) {
      threw = true;
      errMsg = e.message;
    }
    assert.ok(threw, `Expected invalid input "${JSON.stringify(input)}" to throw Error`);
    assert.ok(errMsg.startsWith('IDENTIFIER_ERROR'), `Expected IDENTIFIER_ERROR for "${JSON.stringify(input)}", got: ${errMsg}`);
  }
});

suite.test('1.5 sanitizeIdentifier allows valid alphanumeric, hyphens, and underscores', async (assert) => {
  const validIds = [
    'job_cloud_01',
    'C-01',
    'emp_aws',
    'job-2026-saudi-telecom-09',
    'a1b2c3d4e5f6',
    'Claim_99_Final'
  ];

  for (const validId of validIds) {
    const res = CompanionValidationGate.sanitizeIdentifier(validId);
    assert.equal(res, validId, `Expected valid identifier "${validId}" to pass unaltered`);
  }
});

suite.test('1.6 ingestFile path traversal attack against files outside proposalsDir', async (assert) => {
  const { tmpDir, proposalsDir, dossierContent } = createIsolatedWorkspace();
  const bridge = new CompanionBridge({ workspaceDir: tmpDir });

  // Create an arbitrary file outside proposalsDir (e.g. dossier.json in workspace root)
  const outsideFile = path.join(tmpDir, 'dossier.json');
  assert.ok(fs.existsSync(outsideFile), 'Outside file dossier.json must exist initially');

  // Attempt to call ingestFile with relative traversal targeting dossier.json
  const traversalPath = path.join(proposalsDir, '..', '..', 'dossier.json');
  
  // Call ingestFile
  const res = await bridge.ingestFile(traversalPath);

  // Check if dossier.json was removed/quarantined from outside proposalsDir
  const existsAfter = fs.existsSync(outsideFile);
  
  // An invariant-safe implementation must NOT allow ingestFile to move or delete outside files.
  // If existsAfter is false, the file was hijacked and moved out of its directory!
  assert.ok(existsAfter, `VULNERABILITY: ingestFile removed outside file "${outsideFile}". Result: ${JSON.stringify(res)}`);
});

// ============================================================================
// SUITE 2: PROPOSAL VALIDATION GATE ADVERSARIAL MATRIX
// ============================================================================

suite.test('2.1 Unknown action types and missing required fields are rejected', async (assert) => {
  // Missing type
  const resNoType = CompanionValidationGate.validateProposal({ jobId: 'job_01' });
  assert.equal(resNoType.valid, false);
  assert.equal(resNoType.code, 'MISSING_REQUIRED_FIELDS');

  // Non-string type
  const resNumType = CompanionValidationGate.validateProposal({ type: 999, jobId: 'job_01' });
  assert.equal(resNumType.valid, false);
  assert.equal(resNumType.code, 'MISSING_REQUIRED_FIELDS');

  // Unknown type
  const resUnknownType = CompanionValidationGate.validateProposal({ type: 'admin_database_wipe', jobId: 'job_01' });
  assert.equal(resUnknownType.valid, false);
  assert.equal(resUnknownType.code, 'UNKNOWN_PROPOSAL_TYPE');

  // Missing jobId in draft_proposal
  const resDraftNoJob = CompanionValidationGate.validateProposal({ type: 'draft_proposal', draftText: 'CV content' });
  assert.equal(resDraftNoJob.valid, false);
  assert.equal(resDraftNoJob.code, 'MISSING_REQUIRED_FIELDS');

  // Missing claimId in claim_confirmation
  const resConfirmNoClaim = CompanionValidationGate.validateProposal({ type: 'claim_confirmation', evidence: 'Proof' });
  assert.equal(resConfirmNoClaim.valid, false);
  assert.equal(resConfirmNoClaim.code, 'MISSING_REQUIRED_FIELDS');

  // Missing jobId in triage_decision
  const resTriageNoJob = CompanionValidationGate.validateProposal({ type: 'triage_decision', decision: 'shortlist' });
  assert.equal(resTriageNoJob.valid, false);
  assert.equal(resTriageNoJob.code, 'MISSING_REQUIRED_FIELDS');

  // Missing jobId in pack_approval
  const resPackNoJob = CompanionValidationGate.validateProposal({ type: 'pack_approval', verdict: 'APPROVE' });
  assert.equal(resPackNoJob.valid, false);
  assert.equal(resPackNoJob.code, 'MISSING_REQUIRED_FIELDS');
});

suite.test('2.2 Non-string identifiers produce clean schema rejections', async (assert) => {
  const nonStringIds = [
    12345,
    true,
    false,
    null,
    { id: 'job_nested' },
    ['job_array']
  ];

  for (const badId of nonStringIds) {
    const res = CompanionValidationGate.validateProposal({
      type: 'triage_decision',
      jobId: badId,
      decision: 'shortlist'
    });
    assert.equal(res.valid, false);
    assert.ok(
      res.code === 'MISSING_REQUIRED_FIELDS' || res.code === 'IDENTIFIER_ERROR',
      `Expected MISSING_REQUIRED_FIELDS or IDENTIFIER_ERROR for badId: ${JSON.stringify(badId)}, got ${res.code}`
    );
  }
});

suite.test('2.3 Rule 1 Submission Invariant: Extensive Casing & Location Matrix', async (assert) => {
  const submissionVariations = [
    // Top-level action casing
    { type: 'status_update', jobId: 'job_01', action: 'SUBMITTED' },
    { type: 'status_update', jobId: 'job_01', action: 'Submitted' },
    { type: 'status_update', jobId: 'job_01', action: 'sUbMiTtEd' },
    { type: 'status_update', jobId: 'job_01', action: 'SUBMIT' },
    { type: 'status_update', jobId: 'job_01', action: 'Submitting' },
    { type: 'status_update', jobId: 'job_01', action: 'APPLICATION_SUBMITTED' },
    { type: 'status_update', jobId: 'job_01', action: 'job_submitted' },
    { type: 'status_update', jobId: 'job_01', action: 'SUBMISSION' },
    { type: 'status_update', jobId: 'job_01', action: '   submitted   ' },

    // Top-level status casing
    { type: 'status_update', jobId: 'job_01', status: 'SUBMITTED' },
    { type: 'status_update', jobId: 'job_01', status: 'Submitted' },
    { type: 'status_update', jobId: 'job_01', status: 'SUBMISSION' },

    // Top-level type
    { type: 'submitted', jobId: 'job_01' },
    { type: 'SUBMITTED', jobId: 'job_01' },
    { type: 'submission', jobId: 'job_01' },

    // Top-level event
    { type: 'status_update', jobId: 'job_01', event: 'SUBMITTED' },
    { type: 'status_update', jobId: 'job_01', event: 'application_submitted' },

    // Nested payload variations
    { type: 'status_update', jobId: 'job_01', payload: { action: 'SUBMITTED' } },
    { type: 'status_update', jobId: 'job_01', payload: { status: 'Submitted' } },
    { type: 'status_update', jobId: 'job_01', payload: { event: 'SUBMISSION' } },

    // Nested details variations
    { type: 'status_update', jobId: 'job_01', details: { submitted: true } },
    { type: 'status_update', jobId: 'job_01', details: { submitted: 'TRUE' } },
    { type: 'status_update', jobId: 'job_01', details: { submitted: 'true' } },
    { type: 'status_update', jobId: 'job_01', details: { status: 'SUBMITTED' } },
    { type: 'status_update', jobId: 'job_01', details: { action: 'SUBMIT' } }
  ];

  for (const variant of submissionVariations) {
    const res = CompanionValidationGate.validateProposal(variant);
    assert.equal(res.valid, false, `Submission variation should be invalid: ${JSON.stringify(variant)}`);
    assert.equal(res.code, 'GUARDRAIL_VIOLATION_SUBMISSION_BLOCKED');
    assert.equal(res.ruleViolated, 'RULE_1_STRICT_HUMAN_SUBMISSION');
    assert.equal(res.stateCorrupted, false);
  }
});

suite.test('2.4 Rule 2 Draft Proposal: Premature Readiness & Format Matrix', async (assert) => {
  const readinessAttempts = [
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', status: 'READY' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', status: 'ready-to-submit' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', status: 'READY_TO_SUBMIT' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', status: 'VERIFIED' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', status: 'APPROVED' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', status: 'approved' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', action: 'ready' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', action: 'APPROVED' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', verified: true },
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', verified: 'TRUE' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: 'CV', verified: 'true' }
  ];

  for (const variant of readinessAttempts) {
    const res = CompanionValidationGate.validateProposal(variant);
    assert.equal(res.valid, false, `Premature readiness attempt should be blocked: ${JSON.stringify(variant)}`);
    assert.equal(res.code, 'GUARDRAIL_VIOLATION_PREMATURE_READINESS');
    assert.equal(res.ruleViolated, 'RULE_2_DRAFT_QUARANTINE');
  }

  // Missing or empty draft text
  const emptyDrafts = [
    { type: 'draft_proposal', jobId: 'job_01' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: '' },
    { type: 'draft_proposal', jobId: 'job_01', draftText: '   \n\t  ' }
  ];

  for (const emptyD of emptyDrafts) {
    const res = CompanionValidationGate.validateProposal(emptyD);
    assert.equal(res.valid, false);
    assert.equal(res.code, 'EMPTY_DRAFT_TEXT');
  }

  // Legitimate draft proposal -> must be quarantined with HOLD_FOR_CLAIM_VERIFICATION
  const legitDraft = {
    type: 'draft_proposal',
    jobId: 'job_01',
    draftText: 'Architected distributed event engine with 99.99% availability at AWS.',
    claimsUsed: ['C-01']
  };
  const resLegit = CompanionValidationGate.validateProposal(legitDraft);
  assert.equal(resLegit.valid, true);
  assert.equal(resLegit.action, 'HOLD_FOR_CLAIM_VERIFICATION');
  assert.equal(resLegit.quarantine, true);
  assert.equal(resLegit.status, 'pending_inquisitor_verification');
});

suite.test('2.5 Rule 3 Claim Gating: VERIFIED elevation blocked and CONFIRM coerced', async (assert) => {
  const { dossierContent } = createIsolatedWorkspace();

  // Direct elevation to VERIFIED in claim_proposal
  const elevationClaim = {
    type: 'claim_proposal',
    employerId: 'emp_aws',
    claimText: 'Led team of 15 engineers',
    status: 'VERIFIED'
  };
  const resElevation = CompanionValidationGate.validateProposal(elevationClaim, { dossier: dossierContent });
  assert.equal(resElevation.valid, false);
  assert.equal(resElevation.code, 'GUARDRAIL_VIOLATION_CLAIM_ELEVATION');
  assert.equal(resElevation.ruleViolated, 'RULE_3_CLAIM_GATING');

  // Direct elevation to verified in candidate_fact_proposal
  const elevationFact = {
    type: 'candidate_fact_proposal',
    employerId: 'emp_aws',
    claimText: 'Contributed to open source SDK',
    status: 'verified'
  };
  const resFactElev = CompanionValidationGate.validateProposal(elevationFact, { dossier: dossierContent });
  assert.equal(resFactElev.valid, false);
  assert.equal(resFactElev.code, 'GUARDRAIL_VIOLATION_CLAIM_ELEVATION');

  // Unknown employer when dossier is supplied
  const unknownEmp = {
    type: 'claim_proposal',
    employerId: 'emp_unknown_fake',
    claimText: 'Some achievement at unknown employer'
  };
  const resUnknownEmp = CompanionValidationGate.validateProposal(unknownEmp, { dossier: dossierContent });
  assert.equal(resUnknownEmp.valid, false);
  assert.equal(resUnknownEmp.code, 'UNKNOWN_EMPLOYER');

  // Valid claim proposal -> coerced to CONFIRM
  const validClaim = {
    type: 'claim_proposal',
    employerId: 'emp_aws',
    claimText: 'Spearheaded cloud migration program saving $2.4M annually'
  };
  const resValid = CompanionValidationGate.validateProposal(validClaim, { dossier: dossierContent });
  assert.equal(resValid.valid, true);
  assert.equal(resValid.action, 'INGESTED_FOR_CONFIRMATION');
  assert.equal(resValid.claimStatus, 'CONFIRM');
  assert.equal(resValid.status, 'CONFIRM');
});

suite.test('2.6 Rule 4 Age Penalty Evasions vs Legitimate Rejections Matrix', async (assert) => {
  const agePenaltyAttempts = [
    // Direct and capitalized phrases
    { type: 'triage_decision', jobId: 'job_01', decision: 'reject', reason: 'posting age exceeds 60 days' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'REJECT', reason: 'Posting_Age > 45' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'exclude', rationale: 'This vacancy is stale' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'not_interested', notes: 'Older than 90 days' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'reject', reason: 'Requisition is 120 days old' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'exclude', reason: 'posting_age limit reached' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'reject', reason: 'age limit exceeded' },

    // Evidence object fields
    { type: 'triage_decision', jobId: 'job_01', decision: 'reject', reason: 'Expired', evidence: { type: 'posting_age' } },
    { type: 'triage_decision', jobId: 'job_01', decision: 'exclude', reason: 'Old', evidence: { type: 'posting age' } },
    { type: 'triage_decision', jobId: 'job_01', decision: 'reject', reason: 'Too old', evidence: { days: 90 } },
    { type: 'triage_decision', jobId: 'job_01', decision: 'not_interested', reason: 'Stale', evidence: { postedAgeDays: 120 } }
  ];

  for (const attempt of agePenaltyAttempts) {
    const res = CompanionValidationGate.validateProposal(attempt);
    assert.equal(res.valid, false, `Age penalty attempt should be blocked: ${JSON.stringify(attempt)}`);
    assert.equal(res.code, 'GUARDRAIL_VIOLATION_AGE_PENALTY');
    assert.equal(res.ruleViolated, 'AGE_PENALTY_INVARIANT');
  }

  // Legitimate rejections MUST NOT be blocked
  const legitimateRejections = [
    { type: 'triage_decision', jobId: 'job_01', decision: 'reject', reason: 'Salary below candidate floor of 45,000 SAR' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'exclude', reason: 'Requires relocation to Singapore, candidate restricted to KSA / Remote' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'not_interested', reason: 'Role requires 10+ years embedded firmware C++, candidate is distributed cloud architect' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'reject', reason: 'Company glassdoor ratings indicate toxic culture and high turnover' }
  ];

  for (const legit of legitimateRejections) {
    const res = CompanionValidationGate.validateProposal(legit);
    assert.equal(res.valid, true, `Legitimate rejection should be valid: ${JSON.stringify(legit)}`);
    assert.equal(res.action, 'INGESTED_AS_PROPOSAL');
  }
});

suite.test('2.6b Age Penalty Evasions: Disguised age phrases ("posted 120 days ago", "vacancy age") must be blocked', async (assert) => {
  const disguisedAgeAttempts = [
    { type: 'triage_decision', jobId: 'job_01', decision: 'reject', reason: 'posted 120 days ago' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'reject', reason: 'opened 4 months ago' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'exclude', reason: 'over 60 days' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'not_interested', reason: 'vacancy age 100 days' },
    { type: 'triage_decision', jobId: 'job_01', decision: 'reject', reason: 'listed 90 days ago' }
  ];

  for (const attempt of disguisedAgeAttempts) {
    const res = CompanionValidationGate.validateProposal(attempt);
    assert.equal(
      res.valid,
      false,
      `VULNERABILITY: Disguised age penalty attempt "${attempt.reason}" was accepted as valid!`
    );
    assert.equal(res.code, 'GUARDRAIL_VIOLATION_AGE_PENALTY');
  }
});

suite.test('2.7 Pack Approval and Triage Decision casing normalizations', async (assert) => {
  // Lowercase approval verdict normalizes to uppercase
  const resApprove = CompanionValidationGate.validateProposal({
    type: 'pack_approval',
    jobId: 'job_01',
    verdict: 'approve'
  });
  assert.equal(resApprove.valid, true);
  assert.equal(resApprove.verdict, 'APPROVE');

  // Lowercase reject verdict normalizes to uppercase
  const resReject = CompanionValidationGate.validateProposal({
    type: 'pack_approval',
    jobId: 'job_01',
    verdict: 'reject'
  });
  assert.equal(resReject.valid, true);
  assert.equal(resReject.verdict, 'REJECT');

  // Invalid verdict fails cleanly
  const resBadVerdict = CompanionValidationGate.validateProposal({
    type: 'pack_approval',
    jobId: 'job_01',
    verdict: 'INSTANT_HIRE'
  });
  assert.equal(resBadVerdict.valid, false);
  assert.equal(resBadVerdict.code, 'INVALID_PACK_VERDICT');

  // Uppercase triage decision normalizes to lowercase
  const resShortlist = CompanionValidationGate.validateProposal({
    type: 'triage_decision',
    jobId: 'job_01',
    decision: 'SHORTLIST'
  });
  assert.equal(resShortlist.valid, true);
  assert.equal(resShortlist.decision, 'shortlist');

  // Invalid triage decision fails cleanly
  const resBadTriage = CompanionValidationGate.validateProposal({
    type: 'triage_decision',
    jobId: 'job_01',
    decision: 'DELETE_JOB'
  });
  assert.equal(resBadTriage.valid, false);
  assert.equal(resBadTriage.code, 'INVALID_TRIAGE_DECISION');
});

// ============================================================================
// SUITE 3: MALFORMED FILES, FUZZING & SIDECAR INTEGRITY
// ============================================================================

suite.test('3.1 Malformed, empty, and huge files produce correct error sidecars without ledger corruption', async (assert) => {
  const { tmpDir, proposalsDir, errorsDir, crewDir } = createIsolatedWorkspace();
  const bridge = new CompanionBridge({ workspaceDir: tmpDir });

  // 1. Zero-byte empty file
  const fEmpty = path.join(proposalsDir, 'attack-01-empty.json');
  fs.writeFileSync(fEmpty, '', 'utf8');

  // 2. Truncated JSON
  const fTrunc = path.join(proposalsDir, 'attack-02-truncated.json');
  fs.writeFileSync(fTrunc, '{"type": "triage_decision", "jobId": "job_01"', 'utf8');

  // 3. Raw binary bytes
  const fBinary = path.join(proposalsDir, 'attack-03-binary.json');
  fs.writeFileSync(fBinary, Buffer.from([0x00, 0xFF, 0xFE, 0xFD, 0x01, 0x02]));

  // 4. Non-object JSON roots
  const fArray = path.join(proposalsDir, 'attack-04-array.json');
  fs.writeFileSync(fArray, JSON.stringify([1, 2, 3]), 'utf8');

  const fString = path.join(proposalsDir, 'attack-05-string.json');
  fs.writeFileSync(fString, JSON.stringify('malicious root string'), 'utf8');

  // 5. Huge 1MB JSON file with invalid submission action
  const fHuge = path.join(proposalsDir, 'attack-06-huge.json');
  const hugeData = {
    type: 'status_update',
    jobId: 'job_01',
    action: 'SUBMITTED',
    garbage: 'X'.repeat(1024 * 1024)
  };
  fs.writeFileSync(fHuge, JSON.stringify(hugeData), 'utf8');

  // Ingest all through bridge
  const sweep = await bridge.ingestAll();

  assert.equal(sweep.summary.ingestedCount, 0, 'No corrupt proposals should be ingested');
  assert.equal(sweep.summary.errorCount, 6, 'All 6 attack files should be quarantined as errors');

  // Verify errors directory contains quarantined files and sidecars
  const errorFiles = fs.readdirSync(errorsDir);
  const sidecars = errorFiles.filter(f => f.endsWith('.error.json'));
  assert.equal(sidecars.length, 6, 'Exactly 6 .error.json sidecars should be created');

  // Verify sidecar schema for each
  for (const sc of sidecars) {
    const scContent = JSON.parse(fs.readFileSync(path.join(errorsDir, sc), 'utf8'));
    assert.ok(scContent.timestamp, 'Sidecar must have timestamp');
    assert.ok(scContent.originalFile, 'Sidecar must identify originalFile');
    assert.ok(scContent.code, 'Sidecar must specify failure code');
    assert.ok(scContent.error, 'Sidecar must specify error message');
    assert.equal(scContent.stateCorrupted, false, 'stateCorrupted must be false');
  }

  // Verify ledger remains 0 bytes
  const ledgerContent = fs.readFileSync(path.join(crewDir, 'ledger.jsonl'), 'utf8');
  assert.equal(ledgerContent.trim(), '', 'Ledger must be completely empty after error handling');

  // Verify snapshot remains completely uncorrupted
  const snapshot = JSON.parse(fs.readFileSync(path.join(crewDir, 'snapshot.json'), 'utf8'));
  assert.equal(snapshot.lastEventId, 0);
  assert.equal(snapshot.jobs['job_cloud_01'].status, 'shortlisted');
});

suite.test('3.2 Interleaved lifecycle: Attacks and valid proposals maintain unbroken SHA-256 chain', async (assert) => {
  const { tmpDir, proposalsDir, processedDir, errorsDir, crewDir } = createIsolatedWorkspace();
  const bridge = new CompanionBridge({ workspaceDir: tmpDir });

  // 1. Valid proposal 1: shortlist
  fs.writeFileSync(path.join(proposalsDir, '10-valid-triage.json'), JSON.stringify({
    type: 'triage_decision',
    jobId: 'job_cloud_01',
    decision: 'shortlist',
    score: 4.5
  }), 'utf8');

  // 2. Attack: Path traversal in jobId
  fs.writeFileSync(path.join(proposalsDir, '20-attack-traversal.json'), JSON.stringify({
    type: 'triage_decision',
    jobId: '../../etc/shadow',
    decision: 'shortlist'
  }), 'utf8');

  // 3. Valid proposal 2: draft proposal (quarantined)
  fs.writeFileSync(path.join(proposalsDir, '30-valid-draft.json'), JSON.stringify({
    type: 'draft_proposal',
    jobId: 'job_cloud_01',
    draftText: 'Lead systems architect with deep cloud resilience expertise at AWS.',
    claimsUsed: ['C-01']
  }), 'utf8');

  // 4. Attack: Submission invariant violation
  fs.writeFileSync(path.join(proposalsDir, '40-attack-submission.json'), JSON.stringify({
    type: 'status_update',
    jobId: 'job_cloud_01',
    action: 'SUBMITTED'
  }), 'utf8');

  // 5. Valid proposal 3: pack approval
  fs.writeFileSync(path.join(proposalsDir, '50-valid-approval.json'), JSON.stringify({
    type: 'pack_approval',
    jobId: 'job_cloud_01',
    verdict: 'APPROVE',
    notes: 'Candidate confirmed application materials'
  }), 'utf8');

  // 6. Attack: Age penalty violation
  fs.writeFileSync(path.join(proposalsDir, '60-attack-age.json'), JSON.stringify({
    type: 'triage_decision',
    jobId: 'job_cloud_01',
    decision: 'reject',
    reason: 'posting age over 90 days'
  }), 'utf8');

  const sweep = await bridge.ingestAll();

  assert.equal(sweep.summary.ingestedCount, 3, 'Exactly 3 valid proposals ingested');
  assert.equal(sweep.summary.quarantinedCount, 1, 'Draft proposal correctly quarantined');
  assert.equal(sweep.summary.errorCount, 3, 'Exactly 3 attack proposals quarantined as errors');

  // Check processed directory
  const processedFiles = fs.readdirSync(processedDir);
  assert.equal(processedFiles.length, 3);

  // Check errors directory
  const sidecars = fs.readdirSync(errorsDir).filter(f => f.endsWith('.error.json'));
  assert.equal(sidecars.length, 3);

  // Read ledger events and verify cryptographic chain and monotonic sequencing
  const ledgerLines = fs.readFileSync(path.join(crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
  assert.equal(ledgerLines.length, 3, 'Ledger should contain exactly 3 events');

  let expectedPrevHash = '0'.repeat(64);
  for (let i = 0; i < ledgerLines.length; i++) {
    const evt = JSON.parse(ledgerLines[i]);
    assert.equal(evt.id, i + 1, `Event ${i} must have monotonic id ${i + 1}`);
    assert.equal(evt.prevHash, expectedPrevHash, `Event ${i} must link to expected previous hash`);
    expectedPrevHash = crypto.createHash('sha256').update(ledgerLines[i].trim()).digest('hex');
  }

  // Replay ledger and verify snapshot matches reducer projection
  const replay = await replayLedger({ workspaceDir: tmpDir });
  assert.equal(replay.lastEventId, 3);
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

suite.suite = suite;
module.exports = suite;
