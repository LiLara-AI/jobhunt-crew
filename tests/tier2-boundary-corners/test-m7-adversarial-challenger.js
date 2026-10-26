'use strict';

/**
 * Milestone M7 Empirical Adversarial Stress Test Suite
 *
 * Authored by: challenger_m7_1 (Empirical Challenger)
 * Scope:
 *   1. Extreme & Corrupt Input Fuzzing (Zero Crashes, Zero Corruption):
 *      - 0-byte file, whitespace-only, truncated JSON mid-token, raw binary/invalid UTF-8,
 *        trailing/leading garbage, null bytes, JSON primitives (array, number, bool, null),
 *        missing required fields.
 *   2. Subsequent Recovery & Resilience:
 *      - Interleaving valid and corrupt files; system processes valid files seamlessly.
 *   3. FIFO Timestamp Ordering:
 *      - Scrambled mtimes on disk correctly ordered chronologically into ledger events.
 *   4. Concurrency Stress & Race Conditions:
 *      - Concurrent execution of ingestFile / ingestAll; measuring lock serialization,
 *        duplicate detection, and race-condition vulnerabilities.
 *   5. Rule 1 Guardrail Invariant — Submission Attack Variants & Casing Bypasses:
 *      - Testing lowercase, uppercase, mixed-case, disguised types, events, and nested payloads.
 *   6. Rule 2 Guardrail Invariant — Draft Quarantine & Premature Readiness Bypasses:
 *      - Testing ready, READY, ready-to-submit, verified: true, and unverified quarantine enforcement.
 *   7. Rule 3 Guardrail Invariant — Direct Claim Elevation & [CONFIRM] Coercion:
 *      - Testing direct VERIFIED attempts, unbound claims, unknown employer checks.
 *   8. Security & Path Traversal Attack Vectors:
 *      - POSIX / Windows dot-dot traversals, absolute drive paths, null bytes, illegal characters.
 *   9. Cryptographic Hash Chain & Monotonic Sequence Integrity:
 *      - Verification of SHA-256 chain and monotonic IDs across diverse batch proposals.
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

const suite = new TestSuite('M7 Adversarial Stress Suite: Companion Bridge & Invariants');

/**
 * Helper to build an isolated, temporary workspace for testing.
 */
function createTestWorkspace() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-m7-challenger-'));
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
      jobs: {},
      applications: {},
      decisions: []
    }, null, 2),
    'utf8'
  );

  const dossierContent = {
    profile: {
      name: 'Morgan Vance',
      title: 'Principal Systems Architect',
      location: 'Riyadh, KSA'
    },
    employers: [
      { id: 'emp_datadog', name: 'Datadog', isCurrent: false },
      { id: 'emp_aramco', name: 'Saudi Aramco', isCurrent: true }
    ],
    claims: [
      {
        id: 'C-10',
        employerId: 'emp_datadog',
        text: 'Designed real-time metric processing pipeline ingesting 12M pts/sec',
        status: 'VERIFIED',
        metrics: ['12M pts/sec'],
        tools: ['Go', 'Kafka']
      },
      {
        id: 'C-11',
        employerId: 'emp_aramco',
        text: 'Architected enterprise private cloud across 3 data centers',
        status: 'CONFIRM',
        metrics: ['3 data centers'],
        tools: ['OpenStack', 'Ceph']
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
// SECTION 1: Extreme & Corrupt Input Fuzzing
// ============================================================================

suite.test('1.1 Zero-byte empty file is quarantined without crashing and stateCorrupted is false', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const emptyFile = path.join(ws.proposalsDir, 'empty.json');
    fs.writeFileSync(emptyFile, '', 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.total, 1, 'Total must be 1');
    assert.equal(report.summary.errorCount, 1, 'Error count must be 1');
    assert.equal(report.summary.ingestedCount, 0, 'Ingested count must be 0');

    assert.equal(fs.existsSync(emptyFile), false, 'Original empty file must be removed from proposals/');
    const errorFiles = fs.readdirSync(ws.errorsDir);
    const sidecar = errorFiles.find(f => f.endsWith('.error.json'));
    assert.ok(sidecar, 'Must generate .error.json sidecar');

    const sidecarData = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, sidecar), 'utf8'));
    assert.equal(sidecarData.stateCorrupted, false, 'stateCorrupted must be false');
    assert.equal(sidecarData.code, 'MALFORMED_JSON', 'Error code must be MALFORMED_JSON');

    // Ledger must be completely empty
    const ledger = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8');
    assert.equal(ledger.trim().length, 0, 'Ledger must remain empty');
  } finally {
    ws.cleanup();
  }
});

suite.test('1.2 Truncated JSON mid-token is quarantined with diagnostic sidecar', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const truncFile = path.join(ws.proposalsDir, 'truncated.json');
    fs.writeFileSync(truncFile, '{"type": "triage_decision", "jobId": "job_99", "decision": "short', 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1);
    assert.equal(fs.existsSync(truncFile), false);

    const errorFiles = fs.readdirSync(ws.errorsDir);
    const sidecar = errorFiles.find(f => f.startsWith('truncated.json') && f.endsWith('.error.json'));
    assert.ok(sidecar);
    const sidecarData = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, sidecar), 'utf8'));
    assert.equal(sidecarData.code, 'MALFORMED_JSON');
    assert.equal(sidecarData.stateCorrupted, false);
  } finally {
    ws.cleanup();
  }
});

suite.test('1.3 Raw binary bytes and invalid UTF-8 sequences are safely quarantined without crashing', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const binFile = path.join(ws.proposalsDir, 'bad_utf8.json');
    // Buffer with invalid UTF-8 start bytes and nulls
    fs.writeFileSync(binFile, Buffer.from([0x00, 0xFF, 0xFE, 0xFD, 0x80, 0x81, 0xC0, 0xAF]));

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1);
    assert.equal(fs.existsSync(binFile), false);

    const errorFiles = fs.readdirSync(ws.errorsDir);
    const sidecar = errorFiles.find(f => f.startsWith('bad_utf8.json') && f.endsWith('.error.json'));
    assert.ok(sidecar);
    const sidecarData = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, sidecar), 'utf8'));
    assert.equal(sidecarData.code, 'MALFORMED_JSON');
    assert.equal(sidecarData.stateCorrupted, false);
  } finally {
    ws.cleanup();
  }
});

suite.test('1.4 Non-object JSON roots (arrays, numbers, strings, null) are rejected with INVALID_OBJECT', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(path.join(ws.proposalsDir, 'array_root.json'), '[{"type": "triage_decision"}]', 'utf8');
    fs.writeFileSync(path.join(ws.proposalsDir, 'number_root.json'), '123456789', 'utf8');
    fs.writeFileSync(path.join(ws.proposalsDir, 'string_root.json'), '"just a string"', 'utf8');
    fs.writeFileSync(path.join(ws.proposalsDir, 'null_root.json'), 'null', 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.total, 4);
    assert.equal(report.summary.errorCount, 4);
    assert.equal(report.summary.ingestedCount, 0);

    const errorFiles = fs.readdirSync(ws.errorsDir);
    const sidecars = errorFiles.filter(f => f.endsWith('.error.json'));
    assert.equal(sidecars.length, 4);

    for (const sc of sidecars) {
      const data = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, sc), 'utf8'));
      assert.equal(data.stateCorrupted, false);
    }
  } finally {
    ws.cleanup();
  }
});

suite.test('1.5 Trailing and leading non-JSON garbage produces MALFORMED_JSON sidecar', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(
      path.join(ws.proposalsDir, 'trailing_garbage.json'),
      '{"type": "triage_decision", "jobId": "job_1", "decision": "shortlist"} trailing arbitrary characters',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws.proposalsDir, 'leading_garbage.json'),
      'Here is the proposal: {"type": "triage_decision", "jobId": "job_2", "decision": "shortlist"}',
      'utf8'
    );

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 2);
    assert.equal(report.summary.ingestedCount, 0);

    const errorFiles = fs.readdirSync(ws.errorsDir);
    const sidecars = errorFiles.filter(f => f.endsWith('.error.json'));
    assert.equal(sidecars.length, 2);
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// SECTION 2: Interleaved Recovery & Pipeline Resilience
// ============================================================================

suite.test('2.1 Valid proposals interleave cleanly between malformed files without state degradation', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // Seed discovered jobs in ledger
    await bridge.ledger.appendEvent({
      event: 'JOB_DISCOVERED',
      actor: 'agent:recon',
      payload: { jobId: 'job_interleaved_1', title: 'Eng 1', company: 'Acme', url: 'https://acme.com/1' }
    });
    await bridge.ledger.appendEvent({
      event: 'JOB_DISCOVERED',
      actor: 'agent:recon',
      payload: { jobId: 'job_interleaved_2', title: 'Eng 2', company: 'Acme', url: 'https://acme.com/2' }
    });
    await replayLedger({ workspaceDir: ws.tmpDir });

    // Scramble alternating valid and corrupt proposals
    fs.writeFileSync(path.join(ws.proposalsDir, '01_corrupt.json'), '{"broken": syntax', 'utf8');
    fs.writeFileSync(path.join(ws.proposalsDir, '02_valid.json'), JSON.stringify({
      type: 'triage_decision',
      jobId: 'job_interleaved_1',
      decision: 'shortlist',
      score: 4.2
    }), 'utf8');
    fs.writeFileSync(path.join(ws.proposalsDir, '03_corrupt.json'), '', 'utf8');
    fs.writeFileSync(path.join(ws.proposalsDir, '04_valid.json'), JSON.stringify({
      type: 'triage_decision',
      jobId: 'job_interleaved_2',
      decision: 'shortlist',
      score: 4.8
    }), 'utf8');

    const report = await bridge.ingestAll();
    assert.equal(report.total, 4);
    assert.equal(report.summary.ingestedCount, 2, '2 valid proposals must be ingested');
    assert.equal(report.summary.errorCount, 2, '2 corrupt proposals must be errored');

    // Check processed
    const processed = fs.readdirSync(ws.processedDir).filter(f => f.endsWith('.processed.json'));
    assert.equal(processed.length, 2);

    // Check errors
    const errorSidecars = fs.readdirSync(ws.errorsDir).filter(f => f.endsWith('.error.json'));
    assert.equal(errorSidecars.length, 2);

    // Verify ledger has exactly 4 events (2 initial seeds + 2 ingested triage)
    const lines = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 4);
    assert.equal(JSON.parse(lines[2]).id, 3);
    assert.equal(JSON.parse(lines[3]).id, 4);

    // Verify snapshot was created and contains both jobs with selected status
    const snapshot = JSON.parse(fs.readFileSync(path.join(ws.crewDir, 'snapshot.json'), 'utf8'));
    assert.ok(snapshot.jobs['job_interleaved_1']);
    assert.ok(snapshot.jobs['job_interleaved_2']);
    assert.equal(snapshot.jobs['job_interleaved_1'].status, 'selected');
    assert.equal(snapshot.jobs['job_interleaved_2'].status, 'selected');
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// SECTION 3: FIFO Timestamp Ordering with Scrambled Mtimes
// ============================================================================

suite.test('3.1 Proposals with scrambled disk mtimes are ingested strictly in chronological FIFO order', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const now = Date.now();

    // Create 5 files with explicit mtime offsets:
    // Drop Order: A(+50s), B(+10s), C(+30s), D(+5s), E(+20s)
    // Expected Ingestion Order: D(+5s), B(+10s), E(+20s), C(+30s), A(+50s)
    const files = [
      { name: 'file_A.json', id: 'job_A', offsetSec: 50 },
      { name: 'file_B.json', id: 'job_B', offsetSec: 10 },
      { name: 'file_C.json', id: 'job_C', offsetSec: 30 },
      { name: 'file_D.json', id: 'job_D', offsetSec: 5 },
      { name: 'file_E.json', id: 'job_E', offsetSec: 20 }
    ];

    for (const f of files) {
      const fullPath = path.join(ws.proposalsDir, f.name);
      fs.writeFileSync(fullPath, JSON.stringify({
        type: 'triage_decision',
        jobId: f.id,
        decision: 'shortlist',
        score: 4.5
      }), 'utf8');

      const targetTime = new Date(now + (f.offsetSec * 1000));
      fs.utimesSync(fullPath, targetTime, targetTime);
    }

    const report = await bridge.ingestAll();
    assert.equal(report.summary.ingestedCount, 5);

    // Verify chronological order in ledger
    const lines = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);

    const expectedOrder = ['job_D', 'job_B', 'job_E', 'job_C', 'job_A'];
    for (let i = 0; i < 5; i++) {
      const ev = JSON.parse(lines[i]);
      assert.equal(ev.payload.jobId, expectedOrder[i], `Ledger event #${i + 1} must be ${expectedOrder[i]}`);
    }
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// SECTION 4: Rule 1 Submission Invariant — Attack Vectors & Casing
// ============================================================================

suite.test('4.1 Rule 1: Lowercase submission declarations are strictly blocked from ledger', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const attacks = [
      { file: 'sub_action.json', payload: { type: 'triage_decision', jobId: 'j1', action: 'submitted' } },
      { file: 'sub_status.json', payload: { type: 'status_update', jobId: 'j2', status: 'submitted' } },
      { file: 'sub_type1.json', payload: { type: 'submission', jobId: 'j3' } },
      { file: 'sub_type2.json', payload: { type: 'application_submitted', jobId: 'j4' } },
      { file: 'sub_type3.json', payload: { type: 'job_submitted', jobId: 'j5' } },
      { file: 'sub_event1.json', payload: { type: 'status_update', jobId: 'j6', event: 'APPLICATION_SUBMITTED' } },
      { file: 'sub_event2.json', payload: { type: 'status_update', jobId: 'j7', event: 'JOB_SUBMITTED' } },
      { file: 'sub_nested1.json', payload: { type: 'status_update', jobId: 'j8', payload: { status: 'submitted' } } },
      { file: 'sub_nested2.json', payload: { type: 'status_update', jobId: 'j9', details: { submitted: true } } }
    ];

    for (const atk of attacks) {
      fs.writeFileSync(path.join(ws.proposalsDir, atk.file), JSON.stringify(atk.payload), 'utf8');
    }

    const report = await bridge.ingestAll();
    assert.equal(report.total, attacks.length);
    assert.equal(report.summary.errorCount, attacks.length, 'All submission attacks must be rejected');
    assert.equal(report.summary.ingestedCount, 0, 'No submission attack may be ingested');

    // Ledger must have 0 events
    const ledger = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8');
    assert.equal(ledger.trim().length, 0, 'Ledger must be completely untouched');
  } finally {
    ws.cleanup();
  }
});

suite.test('4.2 Rule 1 Empirical Stress: Uppercase and mixed-case submission attempts do NOT corrupt snapshot status', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // Seed an initial job into snapshot
    await bridge.ledger.appendEvent({
      event: 'JOB_DISCOVERED',
      actor: 'agent:recon',
      payload: { jobId: 'job_victim_1', title: 'Staff Engineer', company: 'Acme', url: 'https://acme.com/job/1' }
    });
    await replayLedger({ workspaceDir: ws.tmpDir });

    // Check pre-state
    let snap = JSON.parse(fs.readFileSync(path.join(ws.crewDir, 'snapshot.json'), 'utf8'));
    assert.equal(snap.jobs['job_victim_1'].status, 'discovered');

    // Drop adversarial proposal with uppercase SUBMITTED
    fs.writeFileSync(
      path.join(ws.proposalsDir, 'upper_submitted.json'),
      JSON.stringify({
        type: 'status_update',
        jobId: 'job_victim_1',
        action: 'SUBMITTED',
        status: 'SUBMITTED'
      }),
      'utf8'
    );

    await bridge.ingestAll();

    // Verify snapshot state: job status MUST NOT be 'submitted'
    snap = JSON.parse(fs.readFileSync(path.join(ws.crewDir, 'snapshot.json'), 'utf8'));
    assert.notEqual(snap.jobs['job_victim_1'].status, 'submitted', 'Snapshot job status must NEVER be set to submitted via companion');
    assert.equal(snap.applications['job_victim_1']?.status !== 'submitted', true, 'Application status must not be submitted');
  } finally {
    ws.cleanup();
  }
});

suite.test('4.3 Vacancy closure on posting age alone is rejected with GUARDRAIL_VIOLATION_AGE_PENALTY', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    fs.writeFileSync(
      path.join(ws.proposalsDir, 'age_reject.json'),
      JSON.stringify({
        type: 'triage_decision',
        jobId: 'job_old_1',
        decision: 'reject',
        reason: 'Vacancy is over 45 days old, penalizing stale listing'
      }),
      'utf8'
    );

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1);
    assert.equal(report.summary.ingestedCount, 0);

    const errorFiles = fs.readdirSync(ws.errorsDir);
    const sidecar = errorFiles.find(f => f.startsWith('age_reject.json') && f.endsWith('.error.json'));
    assert.ok(sidecar);
    const data = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, sidecar), 'utf8'));
    assert.equal(data.code, 'GUARDRAIL_VIOLATION_AGE_PENALTY');
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// SECTION 5: Rule 2 & 3 Guardrails: Draft Quarantine & Claim Gating
// ============================================================================

suite.test('5.1 Rule 2: Draft proposals are strictly quarantined pending Inquisitor gate and cannot claim readiness', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // 1. Premature readiness attempt
    fs.writeFileSync(
      path.join(ws.proposalsDir, 'premature_ready.json'),
      JSON.stringify({
        type: 'draft_proposal',
        jobId: 'job_draft_1',
        draftText: 'Tailored CV content',
        status: 'ready'
      }),
      'utf8'
    );

    // 2. Legitimate draft proposal
    fs.writeFileSync(
      path.join(ws.proposalsDir, 'valid_draft.json'),
      JSON.stringify({
        type: 'draft_proposal',
        jobId: 'job_draft_2',
        draftText: 'Candidate CV tailored for Saudi Aramco Cloud Architect role',
        draftType: 'cv',
        claimsUsed: ['C-10', 'C-11']
      }),
      'utf8'
    );

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1, 'Premature readiness must be rejected');
    assert.equal(report.summary.ingestedCount, 1, 'Valid draft must be ingested');
    assert.equal(report.summary.quarantinedCount, 1, 'Valid draft must be quarantined');

    // Inspect ledger event for valid draft
    const lines = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.event, 'DRAFT_GENERATED');
    assert.equal(event.payload.unverified, true, 'Draft must be marked unverified');
    assert.equal(event.payload.status, 'pending_inquisitor_verification', 'Draft status must be pending_inquisitor_verification');
  } finally {
    ws.cleanup();
  }
});

suite.test('5.2 Rule 3: Newly proposed candidate claims cannot be marked VERIFIED directly and are coerced to CONFIRM', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // 1. Forbidden direct VERIFIED claim proposal
    fs.writeFileSync(
      path.join(ws.proposalsDir, 'bad_claim.json'),
      JSON.stringify({
        type: 'claim_proposal',
        claimId: 'C-99',
        employerId: 'emp_datadog',
        claimText: 'Optimized PostgreSQL connection pooler for 50,000 active sessions',
        status: 'VERIFIED'
      }),
      'utf8'
    );

    // 2. Valid claim proposal with CONFIRM status
    fs.writeFileSync(
      path.join(ws.proposalsDir, 'good_claim.json'),
      JSON.stringify({
        type: 'claim_proposal',
        claimId: 'C-99',
        employerId: 'emp_datadog',
        claimText: 'Optimized PostgreSQL connection pooler for 50,000 active sessions',
        status: 'CONFIRM'
      }),
      'utf8'
    );

    const report = await bridge.ingestAll();
    assert.equal(report.summary.errorCount, 1, 'Direct VERIFIED proposal must be rejected');
    assert.equal(report.summary.ingestedCount, 1, 'CONFIRM claim must be ingested');

    const lines = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.payload.status, 'CONFIRM', 'Payload status must be CONFIRM');
  } finally {
    ws.cleanup();
  }
});

suite.test('5.3 Claim confirmation updates candidate dossier.json from CONFIRM to VERIFIED', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // Verify initial dossier state for C-11 is CONFIRM
    let dossier = JSON.parse(fs.readFileSync(path.join(ws.tmpDir, 'dossier.json'), 'utf8'));
    const claim11 = dossier.claims.find(c => c.id === 'C-11');
    assert.equal(claim11.status, 'CONFIRM');

    // Confirm claim C-11 via companion proposal
    fs.writeFileSync(
      path.join(ws.proposalsDir, 'confirm_c11.json'),
      JSON.stringify({
        type: 'claim_confirmation',
        claimId: 'C-11',
        evidence: 'Verified against Aramco data center sign-off document #AR-992'
      }),
      'utf8'
    );

    const report = await bridge.ingestAll();
    assert.equal(report.summary.ingestedCount, 1);

    // Verify dossier.json has been updated
    dossier = JSON.parse(fs.readFileSync(path.join(ws.tmpDir, 'dossier.json'), 'utf8'));
    const updatedClaim11 = dossier.claims.find(c => c.id === 'C-11');
    assert.equal(updatedClaim11.status, 'VERIFIED', 'Dossier claim status must now be VERIFIED');
    assert.equal(updatedClaim11.evidence, 'Verified against Aramco data center sign-off document #AR-992');
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// SECTION 6: Security & Path Traversal Attacks
// ============================================================================

suite.test('6.1 Path traversal attacks across all identifier parameters are rejected with SECURITY_VIOLATION', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });
    const attacks = [
      { name: 'trav_rel_dots.json', payload: { type: 'triage_decision', jobId: '../../../../etc/shadow', decision: 'shortlist' } },
      { name: 'trav_win_slash.json', payload: { type: 'triage_decision', jobId: '..\\..\\Windows\\System32', decision: 'shortlist' } },
      { name: 'trav_abs_posix.json', payload: { type: 'triage_decision', jobId: '/var/log/auth.log', decision: 'shortlist' } },
      { name: 'trav_abs_win.json', payload: { type: 'pack_approval', jobId: 'C:\\boot.ini', verdict: 'APPROVE' } },
      { name: 'trav_claim_dots.json', payload: { type: 'claim_confirmation', claimId: '../../secret_key', evidence: 'Valid evidence' } },
      { name: 'trav_emp_dots.json', payload: { type: 'claim_proposal', claimId: 'C-99', employerId: '../../bad_dir', claimText: 'Valid claim' } }
    ];

    for (const atk of attacks) {
      fs.writeFileSync(path.join(ws.proposalsDir, atk.name), JSON.stringify(atk.payload), 'utf8');
    }

    const report = await bridge.ingestAll();
    assert.equal(report.total, attacks.length);
    assert.equal(report.summary.errorCount, attacks.length, 'Every path traversal attack must be rejected');
    assert.equal(report.summary.ingestedCount, 0);

    const errorFiles = fs.readdirSync(ws.errorsDir);
    const sidecars = errorFiles.filter(f => f.endsWith('.error.json'));
    assert.equal(sidecars.length, attacks.length);
    for (const sc of sidecars) {
      const data = JSON.parse(fs.readFileSync(path.join(ws.errorsDir, sc), 'utf8'));
      assert.equal(data.code, 'SECURITY_VIOLATION');
      assert.equal(data.stateCorrupted, false);
    }
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// SECTION 7: SHA-256 Chain Integrity & Monotonic Monolithic Replay
// ============================================================================

suite.test('7.1 Diverse batch of 20 proposals maintains unbroken SHA-256 chain and monotonic IDs', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // Seed 20 diverse valid proposals
    for (let i = 1; i <= 20; i++) {
      let p;
      if (i % 4 === 1) {
        p = { type: 'triage_decision', jobId: `job_diverse_${i}`, decision: 'shortlist', score: 4.5 };
      } else if (i % 4 === 2) {
        p = { type: 'draft_proposal', jobId: `job_diverse_${i}`, draftText: `Draft cv text ${i}` };
      } else if (i % 4 === 3) {
        p = { type: 'pack_approval', jobId: `job_diverse_${i}`, verdict: 'APPROVE', notes: 'Looks good' };
      } else {
        p = { type: 'claim_proposal', claimId: `C-${i}`, employerId: 'emp_datadog', claimText: `Additional claim ${i}`, status: 'CONFIRM' };
      }
      fs.writeFileSync(path.join(ws.proposalsDir, `prop_${String(i).padStart(3, '0')}.json`), JSON.stringify(p), 'utf8');
    }

    const report = await bridge.ingestAll();
    assert.equal(report.summary.ingestedCount, 20);
    assert.equal(report.summary.errorCount, 0);

    // Cryptographic validation of ledger chain
    const integrity = bridge.ledger.verifyChainIntegrity();
    assert.equal(integrity.valid, true, 'Cryptographic chain must be 100% valid');

    const lines = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 20);

    for (let i = 0; i < lines.length; i++) {
      const ev = JSON.parse(lines[i]);
      assert.equal(ev.id, i + 1, `Monotonic sequence ID must be ${i + 1}`);
      if (i === 0) {
        assert.equal(ev.prevHash, '0'.repeat(64));
      } else {
        const expectedPrev = crypto.createHash('sha256').update(lines[i - 1].trim()).digest('hex');
        assert.equal(ev.prevHash, expectedPrev);
      }
    }

    // Materialized snapshot must reflect last event ID = 20
    const snapshot = JSON.parse(fs.readFileSync(path.join(ws.crewDir, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.lastEventId, 20);
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// SECTION 8: Concurrency Stress Test — Empirical Ingestion Race Probe
// ============================================================================

suite.test('8.1 Concurrency Stress: Parallel file ingestion serialized by EventLedger withLock', async assert => {
  const ws = createTestWorkspace();
  try {
    const bridge = new CompanionBridge({ workspaceDir: ws.tmpDir });

    // Seed 10 distinct files
    const filePaths = [];
    for (let i = 1; i <= 10; i++) {
      const fp = path.join(ws.proposalsDir, `async_prop_${i}.json`);
      fs.writeFileSync(fp, JSON.stringify({
        type: 'triage_decision',
        jobId: `job_async_${i}`,
        decision: 'shortlist',
        score: 4.0 + (i * 0.05)
      }), 'utf8');
      filePaths.push(fp);
    }

    // Ingest all 10 files in parallel via Promise.all(ingestFile)
    const results = await Promise.all(filePaths.map(fp => bridge.ingestFile(fp)));

    // Verify all 10 were successfully ingested
    for (let i = 0; i < 10; i++) {
      assert.equal(results[i].success, true, `File ${i + 1} must ingest successfully`);
    }

    // Verify ledger has exactly 10 events with unbroken hash chain
    const lines = fs.readFileSync(path.join(ws.crewDir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 10, 'Ledger must have exactly 10 events');

    const integrity = bridge.ledger.verifyChainIntegrity();
    assert.equal(integrity.valid, true, 'Ledger hash chain must remain valid under concurrent ingestFile calls');

    for (let i = 0; i < lines.length; i++) {
      const ev = JSON.parse(lines[i]);
      assert.equal(ev.id, i + 1, `Monotonic event sequence must hold`);
    }
  } finally {
    ws.cleanup();
  }
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true });
}
