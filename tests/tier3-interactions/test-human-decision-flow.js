'use strict';
/**
 * Tier 3: Interaction Test — Full HTTP Human Decision Lifecycle
 * Tests the complete end-to-end decision-making workflow through the genuine
 * CommandCenterServer HTTP REST API:
 * 1. Discover vacancy -> Human Shortlist decision
 * 2. Unconfirmed claim -> Human Claim Confirmation
 * 3. Ready application package -> Guardrail validation on submission
 * 4. Rejection of unauthenticated, non-human, or missing-token submissions
 * 5. Successful human submission authorized with token
 * 6. Verification of ledger monotonicity and cryptographic hash chain integrity
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const { CommandCenterServer } = require('../../lib/command-center/server');
const { EventLedger } = require('../../lib/ledger/ledger');
const { replayLedger } = require('../../lib/ledger/reducer');

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

const suite = new TestSuite('Tier 3: Full HTTP Human Decision Lifecycle');

const TEST_TOKEN = 'decision-flow-token-9988';
let server;
let baseUrl;
let tempWorkspace;
let ledger;

suite.test('Initialize temporary workspace with ledger and seed candidate dossier', async assert => {
  tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-decision-flow-'));
  const crewDir = path.join(tempWorkspace, '.crew');
  fs.mkdirSync(crewDir, { recursive: true });

  ledger = new EventLedger({ workspaceDir: tempWorkspace });

  // Seed sample dossier
  const dossier = {
    candidate: { name: 'Alex Rivera', email: 'alex.rivera@example.org' },
    employers: [
      { id: 'emp_01', name: 'Alpha Solutions', startYear: 2020, endYear: 2023, title: 'Senior Software Engineer' },
      { id: 'emp_02', name: 'Beta Cloud', startYear: 2023, isCurrent: true, title: 'Lead Distributed Architect' }
    ],
    claims: [
      { id: 'C-01', employerId: 'emp_02', category: 'scale', text: 'Maintained 99.99% availability at 15,000 rps', status: 'CONFIRM', clarificationPrompt: 'Check SRE uptime report' }
    ]
  };
  fs.writeFileSync(path.join(tempWorkspace, 'dossier.json'), JSON.stringify(dossier, null, 2), 'utf8');

  // Seed discovered vacancy into ledger
  await ledger.appendEvent({
    event: 'JOB_DISCOVERED',
    actor: 'agent:recon',
    payload: {
      id: 'job_roshn_101',
      title: 'Principal Cloud Architect',
      company: 'ROSHN',
      location: 'Riyadh, Saudi Arabia',
      url: 'https://careers.roshn.sa/job/101',
      channel: 'workday'
    }
  });

  // Seed triage score >= 3.5 making it shortlisted
  await ledger.appendEvent({
    event: 'JOB_TRIAGED',
    actor: 'agent:recon',
    payload: {
      jobId: 'job_roshn_101',
      score: 4.8,
      status: 'shortlisted',
      rationale: 'High alignment with distributed cloud architecture experience'
    }
  });

  // Rebuild snapshot
  await replayLedger({ workspaceDir: tempWorkspace, rebuild: true });

  server = new CommandCenterServer({
    workspaceDir: tempWorkspace,
    port: 0,
    token: TEST_TOKEN
  });

  const info = await server.start();
  baseUrl = server.getBaseUrl();

  assert.ok(baseUrl.startsWith('http://127.0.0.1:'), 'Server must bind to loopback');
});

suite.test('Step 1: Human inspects Decision Queue via GET /api/decisions', async assert => {
  const res = await makeRequest(`${baseUrl}/api/decisions`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.equal(res.statusCode, 200);

  const data = JSON.parse(res.body);
  assert.equal(data.counts.unconfirmedClaims, 1, 'Should have 1 unconfirmed claim [C-01]');
  assert.equal(data.counts.shortlistedRoles, 1, 'Should have 1 shortlisted vacancy (ROSHN)');
  assert.equal(data.decisions.shortlistedRoles[0].company, 'ROSHN');
});

suite.test('Step 2: Human shortlists role for application via POST /api/decision', async assert => {
  const res = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    headers: { 'X-Session-Token': TEST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'shortlist',
      jobId: 'job_roshn_101',
      actor: 'human:web'
    })
  });
  assert.equal(res.statusCode, 200);

  const result = JSON.parse(res.body);
  assert.equal(result.status, 'recorded');
  assert.equal(result.eventType, 'JOB_SELECTED');

  // Verify snapshot updated
  const snapRes = await makeRequest(`${baseUrl}/api/snapshot`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  const snap = JSON.parse(snapRes.body);
  assert.equal(snap.jobs['job_roshn_101'].status, 'selected', 'Job status must transition to selected');
});

suite.test('Step 3: Candidate confirms unconfirmed claim [C-01] via POST /api/decision', async assert => {
  const res = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    headers: { 'X-Session-Token': TEST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'confirm_claim',
      claimId: 'C-01',
      evidence: 'Verified against Q3 SRE dashboard report',
      actor: 'human:candidate'
    })
  });
  assert.equal(res.statusCode, 200);

  // Check dossier file was updated on disk
  const rawDossier = fs.readFileSync(path.join(tempWorkspace, 'dossier.json'), 'utf8');
  const d = JSON.parse(rawDossier);
  assert.equal(d.claims[0].status, 'VERIFIED', 'Dossier claim status must be VERIFIED');
  assert.equal(d.claims[0].evidence, 'Verified against Q3 SRE dashboard report');

  // Decision queue should now reflect 0 unconfirmed claims
  const decRes = await makeRequest(`${baseUrl}/api/decisions`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  const decData = JSON.parse(decRes.body);
  assert.equal(decData.counts.unconfirmedClaims, 0, 'No more unconfirmed claims pending');
});

suite.test('Step 4: Package drafted & approved -> Guardrail rejects submission without token', async assert => {
  // Simulate scribe + inquisitor completing package to ready state
  await ledger.appendEvent({
    event: 'DRAFT_GENERATED',
    actor: 'agent:scribe',
    payload: { jobId: 'job_roshn_101', cvPath: 'cv.docx', coverLetterPath: 'cl.docx' }
  });
  await ledger.appendEvent({
    event: 'CLAIMS_VERIFIED',
    actor: 'agent:inquisitor',
    payload: { jobId: 'job_roshn_101', passed: true, violationsCount: 0 }
  });
  await ledger.appendEvent({
    event: 'BLIND_REVIEW_RECORDED',
    actor: 'agent:critic',
    payload: { jobId: 'job_roshn_101', verdict: 'APPROVE', score: 4.8 }
  });
  await replayLedger({ workspaceDir: tempWorkspace });

  // Attempt submission WITHOUT human token
  const badRes1 = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    headers: { 'X-Session-Token': TEST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'mark_submitted',
      jobId: 'job_roshn_101',
      actor: 'human:web'
      // missing token
    })
  });
  assert.equal(badRes1.statusCode, 400, 'Must return 400 when token missing');
  assert.ok(badRes1.body.includes('GUARDRAIL_VIOLATION'), 'Must cite guardrail violation');
});

suite.test('Step 5: Guardrail rejects submission by non-human automated actor', async assert => {
  const badRes2 = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    headers: { 'X-Session-Token': TEST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'mark_submitted',
      jobId: 'job_roshn_101',
      token: 'some-token-value',
      actor: 'agent:scribe' // Automated bot attempt
    })
  });
  assert.equal(badRes2.statusCode, 400, 'Automated agents must be rejected');
  assert.ok(badRes2.body.includes('GUARDRAIL_VIOLATION'), 'Must cite automated actor guardrail violation');
});

suite.test('Step 6: Human authorizes submission with valid token -> Records APPLICATION_SUBMITTED', async assert => {
  const goodRes = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    headers: { 'X-Session-Token': TEST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'mark_submitted',
      jobId: 'job_roshn_101',
      token: 'human-confirmed-submit-tok-2026',
      actor: 'human:web'
    })
  });
  assert.equal(goodRes.statusCode, 200);

  const goodData = JSON.parse(goodRes.body);
  assert.equal(goodData.status, 'recorded');
  assert.equal(goodData.eventType, 'APPLICATION_SUBMITTED');

  // Verify snapshot reflects submitted status
  const snapRes = await makeRequest(`${baseUrl}/api/snapshot`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  const snap = JSON.parse(snapRes.body);
  assert.equal(snap.jobs['job_roshn_101'].status, 'submitted', 'Job must be marked submitted');
});

suite.test('Step 7: Ledger integrity: Monotonic sequence numbers and continuous hash chain', async assert => {
  const events = ledger.readEvents();
  assert.ok(events.length >= 7, 'Should have at least 7 events in ledger');

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const expectedSeq = i + 1;
    const actualSeq = e.id !== undefined ? e.id : e.seq;
    assert.equal(actualSeq, expectedSeq, `Event #${i} sequence must be monotonic (${expectedSeq})`);
  }

  const integrity = ledger.verifyChainIntegrity();
  assert.equal(integrity.valid, true, `Hash chain must be cryptographically valid: ${integrity.reason}`);
  assert.equal(integrity.count, events.length, 'Integrity check must verify all events');
});

suite.test('Step 8: Server shutdown and clean temp workspace', async assert => {
  await server.stop();
  if (tempWorkspace && fs.existsSync(tempWorkspace)) {
    try { fs.rmSync(tempWorkspace, { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(true);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
