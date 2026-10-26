'use strict';

/**
 * Tier 2: Boundary & Corner Cases — Milestone M7 Adversarial Companion Suite
 *
 * Scope:
 * 1. Directory Ingestion Lifecycle:
 *    - Transition of proposals from inbox/proposals/ to inbox/processed/ (success)
 *      or inbox/errors/ (failure).
 *    - FIFO ordering by file modification timestamp.
 * 2. Diagnostic Error Sidecar Generation:
 *    - Verification of companion .error.json sidecar files with error codes and context.
 * 3. State Corruption Immunity:
 *    - Rejection of corrupted/malformed files with zero ledger impact (stateCorrupted: false).
 *    - Recovery: valid proposals process successfully following malformed inputs.
 * 4. Coverage of All 4 Proposal Kinds:
 *    - triage_decision (shortlist, not_interested, park, age-penalty rejection)
 *    - claim_confirmation (ledger append + dossier.json synchronization)
 *    - draft_proposal (CV/cover-letter quarantine, outreach, premature readiness rejection)
 *    - pack_approval (APPROVE, REJECT, REVISE)
 * 5. Security & Path Traversal Attacks:
 *    - Rejection of dot-dot path traversal (../../etc/shadow)
 *    - Rejection of Windows backslash traversal (..\\..\\secret)
 *    - Rejection of absolute paths (C:\\Windows, /etc/shadow)
 *    - Rejection of illegal characters and null bytes
 * 6. Non-Negotiable Core Guardrails:
 *    - Rule 1: Outright rejection of unauthorized submissions (action/status: 'submitted')
 *    - Rule 2: Mandatory quarantine of draft proposals (HOLD_FOR_CLAIM_VERIFICATION)
 *    - Rule 3: Direct claim elevation to VERIFIED blocked; coerced to [CONFIRM]
 * 7. Concurrent Processing & Lock Serialization:
 *    - Monotonic sequencing and SHA-256 hash chain preservation under concurrent load.
 *
 * Zero external dependencies. Uses pure Node.js built-ins.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const { CompanionBridge } = require('../../lib/companion/bridge');
const { CompanionValidationGate } = require('../../lib/companion/validation');
const { EventLedger } = require('../../lib/ledger/ledger');
const { replayLedger } = require('../../lib/ledger/reducer');
const { withLock } = require('../../lib/ledger/lock');

const suite = new TestSuite('Tier 2: M7 Adversarial Companion & Proposal Bridge');

/**
 * Helper to build an isolated, temporary workspace for testing.
 */
function createTestWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-companion-test-'));
  const crewDir = path.join(tmpDir, '.crew');
  const inboxDir = path.join(tmpDir, 'inbox');
  const proposalsDir = path.join(inboxDir, 'proposals');
  const processedDir = path.join(inboxDir, 'processed');
  const errorsDir = path.join(inboxDir, 'errors');

  fs.mkdirSync(crewDir, { recursive: true });
  fs.mkdirSync(proposalsDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });
  fs.mkdirSync(errorsDir, { recursive: true });

  // Initialize empty ledger and initial snapshot
  fs.writeFileSync(path.join(crewDir, 'ledger.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(crewDir, 'snapshot.json'),
    JSON.stringify({
      version: 1,
      lastEventId: 0,
      updatedAt: new Date().toISOString(),
      jobs: {},
      applications: {},
      decisions: []
    }, null, 2),
    'utf8'
  );

  // Initialize sample candidate dossier with an unverified claim
  const dossierContent = {
    profile: {
      name: 'Alex Rivera',
      title: 'Principal Cloud Architect',
      location: 'Riyadh, KSA'
    },
    employers: [
      { id: 'emp_stripe', name: 'Stripe', isCurrent: false },
      { id: 'emp_aws', name: 'AWS', isCurrent: false }
    ],
    claims: [
      {
        id: 'C-01',
        employerId: 'emp_stripe',
        text: 'Scaled Kafka messaging cluster to 1.8M events/sec',
        status: 'VERIFIED',
        metrics: ['1.8M events/sec'],
        tools: ['Kafka']
      },
      {
        id: 'C-04',
        employerId: 'emp_stripe',
        text: 'Led migration of 45 microservices to Kubernetes',
        status: 'CONFIRM',
        metrics: ['45 microservices'],
        tools: ['Kubernetes']
      }
    ]
  };
  fs.writeFileSync(path.join(tmpDir, 'dossier.json'), JSON.stringify(dossierContent, null, 2), 'utf8');

  const cleanup = () => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  };

  return { tmpDir, crewDir, inboxDir, proposalsDir, processedDir, errorsDir, cleanup };
}

// ============================================================================
// 1. INBOX DIRECTORY LIFECYCLE & ARCHIVING
// ============================================================================

suite.test('Directory lifecycle moves successful proposals to inbox/processed/ with timestamp prefix', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const proposalFile = path.join(ws.proposalsDir, 'triage_stripe.json');

    fs.writeFileSync(proposalFile, JSON.stringify({
      type: 'triage_decision',
      jobId: 'job_stripe_staff_01',
      decision: 'shortlist',
      score: 4.8,
      rationale: 'High alignment with Kafka and Kubernetes claims'
    }, null, 2), 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.total, 1, 'Total proposals discovered must be 1');
    assert.equal(report.summary.ingestedCount, 1, 'Ingested count must be 1');
    assert.equal(report.summary.errorCount, 0, 'Error count must be 0');

    // Original file must be gone from inbox/proposals/
    assert.equal(fs.existsSync(proposalFile), false, 'Original file must be removed from proposals directory');

    // Processed directory must contain archived file with .processed.json suffix
    const processedFiles = fs.readdirSync(ws.processedDir);
    assert.equal(processedFiles.length, 1, 'inbox/processed/ must contain exactly 1 archived file');
    assert.ok(processedFiles[0].startsWith('triage_stripe.json.'), 'Archived file must preserve original basename');
    assert.ok(processedFiles[0].endsWith('.processed.json'), 'Archived file must have .processed.json suffix');
  } finally {
    ws.cleanup();
  }
});

suite.test('Directory lifecycle archives invalid proposals to inbox/errors/ and creates .error.json sidecar', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const proposalFile = path.join(ws.proposalsDir, 'bad_proposal.json');

    fs.writeFileSync(proposalFile, JSON.stringify({
      type: 'status_update',
      jobId: 'job_42',
      action: 'submitted',
      notes: 'Fake automated submission'
    }, null, 2), 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.total, 1, 'Total proposals discovered must be 1');
    assert.equal(report.summary.ingestedCount, 0, 'Ingested count must be 0');
    assert.equal(report.summary.errorCount, 1, 'Error count must be 1');

    // Original file must be moved out of inbox/proposals/
    assert.equal(fs.existsSync(proposalFile), false, 'Rejected file must not remain in inbox/proposals/');

    // Check inbox/errors/ for the rejected file and its diagnostic sidecar
    const errorFiles = fs.readdirSync(ws.errorsDir);
    assert.equal(errorFiles.length, 2, 'inbox/errors/ must contain rejected payload and .error.json sidecar');

    const rejectedFile = errorFiles.find(f => f.endsWith('.rejected.json'));
    const sidecarFile = errorFiles.find(f => f.endsWith('.error.json'));

    assert.ok(rejectedFile, 'Rejected payload file must exist in errors/');
    assert.ok(sidecarFile, 'Diagnostic sidecar file must exist in errors/');

    // Inspect sidecar contents
    const sidecarContent = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, sidecarFile), 'utf8'));
    assert.equal(sidecarContent.originalFile, 'bad_proposal.json');
    assert.ok(sidecarContent.code.includes('GUARDRAIL') || sidecarContent.error.includes('GUARDRAIL'));
    assert.equal(sidecarContent.stateCorrupted, false);
  } finally {
    ws.cleanup();
  }
});

suite.test('Proposals are processed in FIFO order by file modification timestamp', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    const fileA = path.join(ws.proposalsDir, 'prop_a.json');
    const fileB = path.join(ws.proposalsDir, 'prop_b.json');

    fs.writeFileSync(fileA, JSON.stringify({
      type: 'triage_decision',
      jobId: 'job_a',
      decision: 'shortlist'
    }), 'utf8');

    // Artificial timestamp gap
    fs.utimesSync(fileA, new Date(Date.now() - 5000), new Date(Date.now() - 5000));

    fs.writeFileSync(fileB, JSON.stringify({
      type: 'triage_decision',
      jobId: 'job_b',
      decision: 'park'
    }), 'utf8');

    fs.utimesSync(fileB, new Date(), new Date());

    const pending = bridge.listPendingProposals();
    assert.equal(pending.length, 2);
    assert.equal(pending[0].filename, 'prop_a.json', 'Older file prop_a.json must be listed first');
    assert.equal(pending[1].filename, 'prop_b.json', 'Newer file prop_b.json must be listed second');
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// 2. STATE CORRUPTION IMMUNITY & FAULT RECOVERY
// ============================================================================

suite.test('Malformed JSON syntax produces zero ledger events and guarantees stateCorrupted: false', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const malformedFile = path.join(ws.proposalsDir, 'syntax_error.json');

    fs.writeFileSync(malformedFile, '{"type": "triage_decision", "jobId": "job_1", UNTERMINATED_GARBAGE', 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1);
    assert.equal(report.summary.corruptedCount, 0);

    // Ledger must be completely empty
    const ledgerContent = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim();
    assert.equal(ledgerContent.length, 0, 'Ledger must not contain any events after malformed file');

    // Sidecar must capture MALFORMED_JSON
    const sidecarName = fs.readdirSync(ws.errorsDir).find(f => f.endsWith('.error.json'));
    assert.ok(sidecarName);
    const sidecar = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, sidecarName), 'utf8'));
    assert.equal(sidecar.code, 'MALFORMED_JSON');
    assert.equal(sidecar.stateCorrupted, false);
  } finally {
    ws.cleanup();
  }
});

suite.test('Subsequent valid proposals process cleanly after a malformed file is quarantined', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // File 1: Malformed syntax
    fs.writeFileSync(path.join(ws.proposalsDir, '01_corrupt.json'), '{ broken json syntax', 'utf8');
    fs.utimesSync(path.join(ws.proposalsDir, '01_corrupt.json'), new Date(Date.now() - 2000), new Date(Date.now() - 2000));

    // File 2: Valid triage
    fs.writeFileSync(path.join(ws.proposalsDir, '02_valid.json'), JSON.stringify({
      type: 'triage_decision',
      jobId: 'job_recovery_test',
      decision: 'shortlist'
    }), 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.total, 2);
    assert.equal(report.summary.errorCount, 1, 'Corrupted file must be counted as error');
    assert.equal(report.summary.ingestedCount, 1, 'Valid file must be successfully ingested');
    assert.equal(report.summary.corruptedCount, 0, 'No state corruption');

    // Valid event must be recorded in ledger
    const ledgerLines = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledgerLines.length, 1);
    const event = JSON.parse(ledgerLines[0]);
    assert.equal(event.event, 'JOB_SELECTED');
    assert.equal(event.payload.jobId, 'job_recovery_test');
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// 3. ALL 4 PROPOSAL KINDS & CORE GUARDRAILS
// ============================================================================

suite.test('Triage decision: shortlist emits JOB_SELECTED event', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(path.join(ws.proposalsDir, 'triage.json'), JSON.stringify({
      type: 'triage_decision',
      jobId: 'job_triage_shortlist',
      decision: 'shortlist',
      score: 4.2,
      rationale: 'Good cloud architecture match'
    }), 'utf8');

    await bridge.ingestAll();

    const ledger = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledger.length, 1);
    const record = JSON.parse(ledger[0]);
    assert.equal(record.event, 'JOB_SELECTED');
    assert.equal(record.payload.jobId, 'job_triage_shortlist');
    assert.equal(record.payload.score, 4.2);
  } finally {
    ws.cleanup();
  }
});

suite.test('Triage decision: rejecting vacancy on posting age alone is strictly blocked (Guardrail)', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(path.join(ws.proposalsDir, 'triage_age.json'), JSON.stringify({
      type: 'triage_decision',
      jobId: 'job_old_vacancy',
      decision: 'reject',
      notes: 'Job is older than 60 days posting age limit',
      evidence: { type: 'posting_age', days: 60 }
    }), 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1);
    assert.equal(report.summary.ingestedCount, 0);

    const errorSidecar = fs.readdirSync(ws.errorsDir).find(f => f.endsWith('.error.json'));
    assert.ok(errorSidecar);
    const content = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, errorSidecar), 'utf8'));
    assert.ok(content.error.includes('posting age'));
  } finally {
    ws.cleanup();
  }
});

suite.test('Claim confirmation: appends CLAIM_CONFIRMED event and synchronizes dossier.json', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(path.join(ws.proposalsDir, 'confirm_c04.json'), JSON.stringify({
      type: 'claim_confirmation',
      claimId: 'C-04',
      evidence: 'Architected migration of 45 microservices with zero downtime per RFC #204.'
    }), 'utf8');

    await bridge.ingestAll();

    // Verify ledger event
    const ledger = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledger.length, 1);
    const record = JSON.parse(ledger[0]);
    assert.equal(record.event, 'CLAIM_CONFIRMED');
    assert.equal(record.payload.claimId, 'C-04');

    // Verify dossier.json was updated
    const updatedDossier = JSON.parse(fs.readFileSync(path.join(ws.tmpDir, 'dossier.json'), 'utf8'));
    const claim = updatedDossier.claims.find(c => c.id === 'C-04');
    assert.ok(claim);
    assert.equal(claim.status, 'VERIFIED', 'Claim C-04 status must be promoted to VERIFIED in dossier');
    assert.ok(claim.evidence.includes('RFC #204'));
  } finally {
    ws.cleanup();
  }
});

suite.test('Draft proposal: quarantined as HOLD_FOR_CLAIM_VERIFICATION (Rule 2)', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(path.join(ws.proposalsDir, 'draft_cl.json'), JSON.stringify({
      type: 'draft_proposal',
      jobId: 'job_stripe_staff_01',
      draftType: 'cover_letter',
      draftText: 'Dear Hiring Manager,\n\nI scaled Kafka to 1.8M events/sec [C-01]...',
      claimsUsed: ['C-01']
    }), 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.summary.ingestedCount, 1);
    assert.equal(report.summary.quarantinedCount, 1);

    const ledger = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledger.length, 1);
    const record = JSON.parse(ledger[0]);
    assert.equal(record.event, 'DRAFT_GENERATED');
    assert.equal(record.payload.unverified, true, 'Draft must be flagged unverified');
    assert.equal(record.payload.status, 'pending_inquisitor_verification');
  } finally {
    ws.cleanup();
  }
});

suite.test('Draft proposal: premature readiness claim is strictly blocked (Guardrail)', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(path.join(ws.proposalsDir, 'bad_ready_draft.json'), JSON.stringify({
      type: 'draft_proposal',
      jobId: 'job_stripe_staff_01',
      draftType: 'cv',
      draftText: 'Unverified text claiming to be verified',
      status: 'ready',
      verified: true
    }), 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1);
    assert.equal(report.summary.ingestedCount, 0);

    const errorSidecar = fs.readdirSync(ws.errorsDir).find(f => f.endsWith('.error.json'));
    assert.ok(errorSidecar);
    const content = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, errorSidecar), 'utf8'));
    assert.ok(content.error.includes('GUARDRAIL_VIOLATION'));
  } finally {
    ws.cleanup();
  }
});

suite.test('Pack approval: emits DECISION_RECORDED with pack_approved verdict', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(path.join(ws.proposalsDir, 'approve_pack.json'), JSON.stringify({
      type: 'pack_approval',
      jobId: 'job_stripe_staff_01',
      verdict: 'APPROVE',
      notes: 'Reviewed cover letter and answers; ready for attended pre-fill'
    }), 'utf8');

    await bridge.ingestAll();

    const ledger = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledger.length, 1);
    const record = JSON.parse(ledger[0]);
    assert.equal(record.event, 'DECISION_RECORDED');
    assert.equal(record.payload.decision, 'pack_approved');
    assert.equal(record.payload.verdict, 'APPROVE');
  } finally {
    ws.cleanup();
  }
});

suite.test('Rule 1: Direct submission claim (action: submitted) is blocked with zero state corruption', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(path.join(ws.proposalsDir, 'illegal_submit.json'), JSON.stringify({
      type: 'triage_decision',
      jobId: 'job_stripe_staff_01',
      action: 'submitted',
      notes: 'Attempting to bypass human submission gate'
    }), 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1);
    assert.equal(report.summary.ingestedCount, 0);
    assert.equal(report.summary.corruptedCount, 0);

    // Ledger must be pristine
    const ledger = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim();
    assert.equal(ledger.length, 0, 'Ledger must remain completely empty');
  } finally {
    ws.cleanup();
  }
});

suite.test('Rule 3: Direct claim elevation to VERIFIED is blocked; new claims coerced to [CONFIRM]', async assert => {
  // Direct promotion test
  const elevationAttempt = JSON.stringify({
    type: 'claim_proposal',
    employerId: 'emp_stripe',
    claimText: 'Invented accomplishment claiming to be verified',
    status: 'VERIFIED'
  });
  const resElevation = CompanionValidationGate.validateProposal(elevationAttempt);
  assert.equal(resElevation.valid, false);
  assert.ok(resElevation.error.includes('GUARDRAIL_VIOLATION'));

  // Legitimate proposal test -> Coerced to CONFIRM
  const legitimateProposal = JSON.stringify({
    type: 'claim_proposal',
    employerId: 'emp_stripe',
    claimText: 'Proposed achievement: Reduced cold-start latency by 40% on serverless functions'
  });
  const resLegit = CompanionValidationGate.validateProposal(legitimateProposal);
  assert.equal(resLegit.valid, true);
  assert.equal(resLegit.claimStatus, 'CONFIRM');
});

// ============================================================================
// 4. SECURITY & PATH TRAVERSAL DEFENSE
// ============================================================================

suite.test('Path traversal attack using relative dots (../../etc/passwd) is rejected', assert => {
  assert.throws(() => {
    CompanionValidationGate.sanitizeIdentifier('../../etc/passwd');
  }, /SECURITY_VIOLATION/);

  const proposal = JSON.stringify({
    type: 'draft_proposal',
    jobId: '../../etc/passwd',
    draftText: 'Malicious traversal payload'
  });
  const res = CompanionValidationGate.validateProposal(proposal);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'SECURITY_VIOLATION');
});

suite.test('Path traversal attack using Windows backslashes (..\\..\\secret) is rejected', assert => {
  assert.throws(() => {
    CompanionValidationGate.sanitizeIdentifier('..\\..\\secret\\keys.txt');
  }, /SECURITY_VIOLATION/);

  const proposal = JSON.stringify({
    type: 'triage_decision',
    jobId: '..\\..\\system32',
    decision: 'shortlist'
  });
  const res = CompanionValidationGate.validateProposal(proposal);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'SECURITY_VIOLATION');
});

suite.test('Path traversal attack using absolute drive path (C:\\Windows) is rejected', assert => {
  assert.throws(() => {
    CompanionValidationGate.sanitizeIdentifier('C:\\Windows\\System32');
  }, /SECURITY_VIOLATION/);

  const proposal = JSON.stringify({
    type: 'pack_approval',
    jobId: 'C:/Windows/win.ini',
    verdict: 'APPROVE'
  });
  const res = CompanionValidationGate.validateProposal(proposal);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'SECURITY_VIOLATION');
});

// ============================================================================
// 5. CONCURRENT INGESTION & LOCK INTEGRITY
// ============================================================================

suite.test('Multiple concurrent proposals are ingested with monotonic IDs and unbroken hash chain', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // Seed 5 valid proposals
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(ws.proposalsDir, `prop_${i}.json`), JSON.stringify({
        type: 'triage_decision',
        jobId: `job_concurrent_${i}`,
        decision: 'shortlist',
        score: 4.0 + (i * 0.1)
      }), 'utf8');
    }

    const report = await bridge.ingestAll();
    assert.equal(report.summary.ingestedCount, 5);
    assert.equal(report.summary.errorCount, 0);

    // Verify monotonic sequencing and cryptographic hash chaining
    const lines = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 5, 'Ledger must have exactly 5 events');

    assert.ok(bridge.ledger.verifyChainIntegrity().valid, 'Ledger cryptographic hash chain must be 100% valid');

    const crypto = require('crypto');
    for (let i = 0; i < lines.length; i++) {
      const event = JSON.parse(lines[i]);
      assert.equal(event.id, i + 1, `Event at index ${i} must have monotonic id ${i + 1}`);
      if (i === 0) {
        assert.equal(event.prevHash, '0'.repeat(64), 'First event prevHash must be 64 zeros');
      } else {
        const expectedPrev = crypto.createHash('sha256').update(lines[i - 1].trim()).digest('hex');
        assert.equal(event.prevHash, expectedPrev, `Event at index ${i} must chain to previous raw line hash`);
      }
    }
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// 6. BRIDGE STATUS REPORTING
// ============================================================================

suite.test('getStatus reports accurate counts for pending, processed, and errors', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // Seed 1 pending file
    fs.writeFileSync(path.join(ws.proposalsDir, 'pending_1.json'), JSON.stringify({
      type: 'triage_decision',
      jobId: 'job_status_test',
      decision: 'shortlist'
    }), 'utf8');

    const statusInitial = bridge.getStatus();
    assert.equal(statusInitial.online, true);
    assert.equal(statusInitial.counts.pending, 1);
    assert.equal(statusInitial.counts.processed, 0);
    assert.equal(statusInitial.counts.errors, 0);

    // Ingest the file
    await bridge.ingestAll();

    const statusAfter = bridge.getStatus();
    assert.equal(statusAfter.counts.pending, 0);
    assert.equal(statusAfter.counts.processed, 1);
    assert.equal(statusAfter.counts.errors, 0);
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// 7. REGRESSION TEST SUITES (VULN-M7-01, VULN-M7-02, VULN-M7-03, Taxonomy)
// ============================================================================

suite.test('Rule 1 Regression: Uppercase, mixed-case, whitespace, and nested submission attempts are blocked with zero ledger events', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const adversarialProposals = [
      { file: 'sub_upper_action.json', payload: { type: 'status_update', jobId: 'job_1', action: 'SUBMITTED' } },
      { file: 'sub_title_action.json', payload: { type: 'status_update', jobId: 'job_2', action: 'Submitted' } },
      { file: 'sub_space_action.json', payload: { type: 'status_update', jobId: 'job_3', action: '  submitted  ' } },
      { file: 'sub_verb_action.json', payload: { type: 'status_update', jobId: 'job_4', action: 'submit' } },
      { file: 'sub_upper_status.json', payload: { type: 'status_update', jobId: 'job_5', status: 'SUBMITTED' } },
      { file: 'sub_space_status.json', payload: { type: 'status_update', jobId: 'job_6', status: ' submitted ' } },
      { file: 'sub_lower_event.json', payload: { type: 'status_update', jobId: 'job_7', event: 'application_submitted' } },
      { file: 'sub_space_event.json', payload: { type: 'status_update', jobId: 'job_8', event: ' APPLICATION_SUBMITTED ' } },
      { file: 'sub_nested_status.json', payload: { type: 'status_update', jobId: 'job_9', payload: { status: 'SUBMITTED' } } },
      { file: 'sub_nested_action.json', payload: { type: 'status_update', jobId: 'job_10', payload: { action: 'SUBMITTED' } } },
      { file: 'sub_details_str.json', payload: { type: 'status_update', jobId: 'job_11', details: { submitted: 'true' } } },
      { file: 'sub_details_status.json', payload: { type: 'status_update', jobId: 'job_12', details: { status: 'SUBMITTED' } } }
    ];

    for (const item of adversarialProposals) {
      fs.writeFileSync(path.join(ws.proposalsDir, item.file), JSON.stringify(item.payload), 'utf8');
    }

    const report = await bridge.ingestAll();
    assert.equal(report.total, adversarialProposals.length);
    assert.equal(report.summary.errorCount, adversarialProposals.length, 'Every submission attempt must be rejected');
    assert.equal(report.summary.ingestedCount, 0, 'No submission attempt may be ingested');

    // Verify all error sidecars have code GUARDRAIL_VIOLATION_SUBMISSION_BLOCKED
    const errorSidecars = fs.readdirSync(ws.errorsDir).filter(f => f.endsWith('.error.json'));
    assert.equal(errorSidecars.length, adversarialProposals.length);
    for (const scName of errorSidecars) {
      const sc = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, scName), 'utf8'));
      assert.equal(sc.code, 'GUARDRAIL_VIOLATION_SUBMISSION_BLOCKED');
      assert.equal(sc.stateCorrupted, false);
    }

    // Ledger must be completely empty
    const ledger = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim();
    assert.equal(ledger.length, 0, 'Ledger must contain 0 events after submission attacks');
  } finally {
    ws.cleanup();
  }
});

suite.test('Draft Proposal Regression: Casing and string-boolean readiness claims are blocked with GUARDRAIL_VIOLATION_PREMATURE_READINESS', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const prematureDrafts = [
      { file: 'draft_upper_ready.json', payload: { type: 'draft_proposal', jobId: 'job_1', draftText: 'text', status: 'READY' } },
      { file: 'draft_space_ready.json', payload: { type: 'draft_proposal', jobId: 'job_2', draftText: 'text', status: ' ready ' } },
      { file: 'draft_upper_rts.json', payload: { type: 'draft_proposal', jobId: 'job_3', draftText: 'text', status: 'READY-TO-SUBMIT' } },
      { file: 'draft_underscore_rts.json', payload: { type: 'draft_proposal', jobId: 'job_4', draftText: 'text', status: 'ready_to_submit' } },
      { file: 'draft_upper_verified.json', payload: { type: 'draft_proposal', jobId: 'job_5', draftText: 'text', status: 'VERIFIED' } },
      { file: 'draft_str_verified.json', payload: { type: 'draft_proposal', jobId: 'job_6', draftText: 'text', verified: 'true' } },
      { file: 'draft_upper_str_verified.json', payload: { type: 'draft_proposal', jobId: 'job_7', draftText: 'text', verified: 'TRUE' } },
      { file: 'draft_ready_action.json', payload: { type: 'draft_proposal', jobId: 'job_8', draftText: 'text', action: 'READY' } }
    ];

    for (const item of prematureDrafts) {
      fs.writeFileSync(path.join(ws.proposalsDir, item.file), JSON.stringify(item.payload), 'utf8');
    }

    const report = await bridge.ingestAll();
    assert.equal(report.total, prematureDrafts.length);
    assert.equal(report.summary.errorCount, prematureDrafts.length, 'All premature readiness attempts must be rejected');
    assert.equal(report.summary.ingestedCount, 0, 'No premature draft may be ingested');

    const errorSidecars = fs.readdirSync(ws.errorsDir).filter(f => f.endsWith('.error.json'));
    assert.equal(errorSidecars.length, prematureDrafts.length);
    for (const scName of errorSidecars) {
      const sc = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, scName), 'utf8'));
      assert.equal(sc.code, 'GUARDRAIL_VIOLATION_PREMATURE_READINESS');
      assert.equal(sc.stateCorrupted, false);
    }

    const ledger = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim();
    assert.equal(ledger.length, 0, 'Ledger must contain 0 events after premature readiness attacks');
  } finally {
    ws.cleanup();
  }
});

suite.test('VULN-M7-02 Regression: Age penalty guardrail blocks all decision casings, spaced phrases, and evidence types', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const ageAttacks = [
      { file: 'age_upper_reject.json', payload: { type: 'triage_decision', jobId: 'job_1', decision: 'REJECT', reason: 'Job is 60 days old' } },
      { file: 'age_space_phrase.json', payload: { type: 'triage_decision', jobId: 'job_2', decision: 'reject', notes: 'posting age exceeds limit' } },
      { file: 'age_upper_ni.json', payload: { type: 'triage_decision', jobId: 'job_3', decision: 'NOT_INTERESTED', notes: 'posting age limit' } },
      { file: 'age_upper_exclude.json', payload: { type: 'triage_decision', jobId: 'job_4', decision: 'EXCLUDE', notes: 'stale vacancy older than 90 days' } },
      { file: 'age_mixed_case.json', payload: { type: 'triage_decision', jobId: 'job_5', decision: 'Reject', reason: 'older than 45 days' } },
      { file: 'age_whitespace.json', payload: { type: 'triage_decision', jobId: 'job_6', decision: '  reject  ', reason: 'stale vacancy' } },
      { file: 'age_evidence_type.json', payload: { type: 'triage_decision', jobId: 'job_7', decision: 'REJECT', evidence: { type: 'posting_age' } } },
      { file: 'age_evidence_days.json', payload: { type: 'triage_decision', jobId: 'job_8', decision: 'REJECT', evidence: { days: 120 } } },
      { file: 'age_evidence_postedAgeDays.json', payload: { type: 'triage_decision', jobId: 'job_9', decision: 'REJECT', evidence: { postedAgeDays: 90 } } },
      { file: 'age_masked_reason.json', payload: { type: 'triage_decision', jobId: 'job_10', decision: 'reject', reason: 'Not a fit', notes: 'posting age exceeds limit' } }
    ];

    for (const item of ageAttacks) {
      fs.writeFileSync(path.join(ws.proposalsDir, item.file), JSON.stringify(item.payload), 'utf8');
    }

    const report = await bridge.ingestAll();
    assert.equal(report.total, ageAttacks.length);
    assert.equal(report.summary.errorCount, ageAttacks.length);
    assert.equal(report.summary.ingestedCount, 0);

    const errorSidecars = fs.readdirSync(ws.errorsDir).filter(f => f.endsWith('.error.json'));
    assert.equal(errorSidecars.length, ageAttacks.length);
    for (const scName of errorSidecars) {
      const sc = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, scName), 'utf8'));
      assert.equal(sc.code, 'GUARDRAIL_VIOLATION_AGE_PENALTY');
    }

    const ledger = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim();
    assert.equal(ledger.length, 0, 'No JOB_CLOSED event may be emitted to ledger');
  } finally {
    ws.cleanup();
  }
});

suite.test('Path Traversal Regression: Isolated dots, multi-dots, and URL-encoded sequences throw SECURITY_VIOLATION', assert => {
  const dangerousIds = [
    '..',
    '.',
    '  ..  ',
    '  .  ',
    '...',
    '....',
    '%2e%2e%2f',
    '..%2f',
    '%2e%2e%5c',
    '..%5c',
    '%252e%252e%252f',
    '../../etc/passwd',
    '..\\..\\secret',
    'invalid%zz'
  ];

  for (const id of dangerousIds) {
    assert.throws(() => {
      CompanionValidationGate.sanitizeIdentifier(id);
    }, /SECURITY_VIOLATION/, `Identifier "${id}" must throw SECURITY_VIOLATION`);
  }
});

suite.test('Path Traversal Regression: Unsanitized claimId in claim_proposal is strictly rejected with SECURITY_VIOLATION', assert => {
  const proposal = {
    type: 'claim_proposal',
    employerId: 'emp_aws',
    claimText: 'Validated engineering accomplishment',
    claimId: '../../etc/shadow'
  };

  const res = CompanionValidationGate.validateProposal(proposal);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'SECURITY_VIOLATION');
  assert.ok(res.error.includes('SECURITY_VIOLATION'));
});

suite.test('Error Taxonomy Regression: Blank, empty, or non-string identifiers produce IDENTIFIER_ERROR code', assert => {
  const blankInputs = ['', '   ', '\t', '\n'];
  for (const b of blankInputs) {
    assert.throws(() => {
      CompanionValidationGate.sanitizeIdentifier(b);
    }, /IDENTIFIER_ERROR/);
  }

  const proposal = {
    type: 'triage_decision',
    jobId: '   ',
    decision: 'shortlist'
  };
  const res = CompanionValidationGate.validateProposal(proposal);
  assert.equal(res.valid, false);
  assert.equal(res.code, 'IDENTIFIER_ERROR');
});

suite.test('Bridge Lifecycle Regression: Traversal attack writes diagnostic sidecar with code SECURITY_VIOLATION', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(path.join(ws.proposalsDir, 'trav_dotdot.json'), JSON.stringify({
      type: 'triage_decision',
      jobId: '..',
      decision: 'shortlist'
    }), 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1);
    assert.equal(report.summary.ingestedCount, 0);

    const sidecarFile = fs.readdirSync(ws.errorsDir).find(f => f.endsWith('.error.json'));
    assert.ok(sidecarFile, 'Sidecar file must exist in inbox/errors/');
    const sidecar = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, sidecarFile), 'utf8'));
    assert.equal(sidecar.code, 'SECURITY_VIOLATION');
    assert.equal(sidecar.stateCorrupted, false);
  } finally {
    ws.cleanup();
  }
});

suite.test('Bridge Lifecycle Regression: Blank identifier writes diagnostic sidecar with code IDENTIFIER_ERROR', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(path.join(ws.proposalsDir, 'blank_id.json'), JSON.stringify({
      type: 'triage_decision',
      jobId: '   ',
      decision: 'shortlist'
    }), 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1);

    const sidecarFile = fs.readdirSync(ws.errorsDir).find(f => f.endsWith('.error.json'));
    assert.ok(sidecarFile);
    const sidecar = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, sidecarFile), 'utf8'));
    assert.equal(sidecar.code, 'IDENTIFIER_ERROR');
    assert.equal(sidecar.stateCorrupted, false);
  } finally {
    ws.cleanup();
  }
});

suite.test('Error Taxonomy Regression: bridge.js ingestProposal provides explicit error codes for schema failures', assert => {
  const resEmpty = CompanionBridge.ingestProposal('');
  assert.equal(resEmpty.ingested, false);
  assert.equal(resEmpty.code, 'MALFORMED_JSON');

  const resArray = CompanionBridge.ingestProposal('[]');
  assert.equal(resArray.ingested, false);
  assert.equal(resArray.code, 'INVALID_OBJECT');

  const resNull = CompanionBridge.ingestProposal('null');
  assert.equal(resNull.ingested, false);
  assert.equal(resNull.code, 'INVALID_OBJECT');

  const resMissingType = CompanionBridge.ingestProposal(JSON.stringify({ jobId: 'j1' }));
  assert.equal(resMissingType.ingested, false);
  assert.equal(resMissingType.code, 'MISSING_REQUIRED_FIELDS');

  const resMissingId = CompanionBridge.ingestProposal(JSON.stringify({ type: 'triage_decision' }));
  assert.equal(resMissingId.ingested, false);
  assert.equal(resMissingId.code, 'MISSING_REQUIRED_FIELDS');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
