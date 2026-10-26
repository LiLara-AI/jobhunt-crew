/**
 * Challenger M2 Iteration 3 Live Empirical Adversarial Probes
 * Tests the 4 required orchestrator adversarial probes plus edge cases.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { EventLedger } = require('../../lib/ledger/ledger');
const { reduceEvents } = require('../../lib/ledger/reducer');
const { GuardrailEngine } = require('../../lib/guardrails/engine');
const { checkDuplicateRequisition } = require('../../lib/guardrails/dedup');

const TEST_DIR = path.join(__dirname, '..', '..', '.test-challenger-live-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

async function runLiveProbes() {
  console.log('======================================================================');
  console.log('CHALLENGER M2 ITERATION 3 — EMPIRICAL ADVERSARIAL PROBES');
  console.log('======================================================================\n');

  let passed = 0;
  let total = 0;

  function record(name, fn) {
    total++;
    try {
      fn();
      console.log(`  ✓ [PROBE ${total}] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✖ [PROBE ${total}] ${name}: ${err.message}`);
      throw err;
    }
  }

  async function recordAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✓ [PROBE ${total}] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✖ [PROBE ${total}] ${name}: ${err.message}`);
      throw err;
    }
  }

  const ledgerFile = path.join(TEST_DIR, 'ledger.jsonl');
  const lockFile = path.join(TEST_DIR, 'ledger.lock');
  const ledger = new EventLedger({ ledgerPath: ledgerFile, lockPath: lockFile });

  // -------------------------------------------------------------------------
  // ADVERSARIAL PROBE 1: Planted Violations in claimVerification.violations
  // -------------------------------------------------------------------------
  console.log('>>> ADVERSARIAL PROBE GROUP 1: Planted Violations in Readiness Gate');

  await recordAsync('EventLedger.appendEvent blocks PACKAGE_MARKED_READY with planted violations array', async () => {
    let thrown = null;
    try {
      await ledger.appendEvent({
        event: 'PACKAGE_MARKED_READY',
        actor: 'agent:inquisitor',
        payload: {
          jobId: 'job_adv_1',
          claimVerification: {
            passed: true, // Adversary claims passed: true!
            violations: ['Fabricated metric: 500% revenue growth']
          },
          reviewPanel: {
            verdict: 'APPROVE',
            reviewer: 'critic'
          }
        }
      });
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== null, 'EventLedger must throw when violations are present');
    assert(thrown.message.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${thrown.message}`);
    assert(thrown.message.includes('unresolved claim violations'), `Expected unresolved claim violations message, got: ${thrown.message}`);
  });

  await recordAsync('EventLedger.appendEvent blocks PACKAGE_MARKED_READY with empty/whitespace violations', async () => {
    let thrown = null;
    try {
      await ledger.appendEvent({
        event: 'PACKAGE_MARKED_READY',
        actor: 'agent:inquisitor',
        payload: {
          jobId: 'job_adv_1_b',
          claimVerification: {
            passed: true,
            violations: ['']
          },
          reviewPanel: { verdict: 'APPROVE' }
        }
      });
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== null, 'EventLedger must throw on non-empty violations array even with empty string');
    assert(thrown.message.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${thrown.message}`);
  });

  record('GuardrailEngine.validateApplicationReadiness blocks package with planted violations', () => {
    let thrown = null;
    try {
      GuardrailEngine.validateApplicationReadiness({
        claimVerification: {
          passed: true,
          violations: ['Unverified claim C-99']
        },
        reviewPanel: { verdict: 'APPROVE' }
      });
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== null, 'GuardrailEngine must throw when violations exist');
    assert(thrown.message.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${thrown.message}`);
  });

  record('CLI crew ledger append blocks PACKAGE_MARKED_READY with planted violations', () => {
    const crewBin = path.join(__dirname, '..', '..', 'bin', 'crew.js');
    const rawPayload = JSON.stringify({
      jobId: 'job_cli_viol',
      claimVerification: { passed: true, violations: ['Fabricated claim C-999'] },
      reviewPanel: { verdict: 'APPROVE' }
    });
    const escapedPayload = rawPayload.replace(/"/g, '\\"');
    let failed = false;
    let output = '';
    try {
      output = execSync(
        `node "${crewBin}" ledger append --event PACKAGE_MARKED_READY --payload "${escapedPayload}" --workspace "${TEST_DIR}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
    } catch (err) {
      failed = true;
      output = (err.stdout || '') + (err.stderr || '') + err.message;
    }
    assert(failed, `CLI ledger append should fail, but output: ${output}`);
    assert(output.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION in CLI output, got: ${output}`);
  });

  await recordAsync('MCP Server rejects crew_record_event PACKAGE_MARKED_READY with planted violations', async () => {
    const { McpServer } = require('../../lib/mcp/server');
    const server = new McpServer({ workspace: TEST_DIR });
    let thrown = null;
    try {
      await server.appendLedgerEvent('PACKAGE_MARKED_READY', {
        jobId: 'job_mcp_viol',
        claimVerification: { passed: true, violations: ['Planted fake claim C-999'] },
        reviewPanel: { verdict: 'APPROVE' }
      }, 'agent:scribe');
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== null, 'MCP Server must throw when violations are present');
    assert(thrown.message.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${thrown.message}`);
    assert(thrown.message.includes('unresolved claim violations'), `Expected unresolved claim violations, got: ${thrown.message}`);
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL PROBE 2: Requisition Deduplication Across Mirror URLs
  // -------------------------------------------------------------------------
  console.log('\n>>> ADVERSARIAL PROBE GROUP 2: Duplicate Requisitions Across Mirror URLs');

  record('CLI crew job add collapses duplicate company + requisitionId across different mirror URLs', () => {
    const crewBin = path.join(__dirname, '..', '..', 'bin', 'crew.js');
    const ws = path.join(TEST_DIR, 'ws-dedup');
    fs.mkdirSync(ws, { recursive: true });

    // Initialize workspace
    execSync(`node "${crewBin}" init --workspace "${ws}"`, { stdio: 'pipe' });

    // Job 1 via primary Workday board
    const out1 = execSync(
      `node "${crewBin}" job add --company "Orion Corp" --title "Senior Solutions Architect" --url "https://orion.wd3.myworkdayjobs.com/en-US/Careers/job/Riyadh/SSA_REQ-9999" --location "Riyadh, KSA" --requisition-id "REQ-9999" --workspace "${ws}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    assert(out1.includes('Job added successfully') || out1.includes('JOB_DISCOVERED'), `Failed to add job 1: ${out1}`);

    // Inspect snapshot to confirm requisitionId was persisted
    const snap1 = JSON.parse(fs.readFileSync(path.join(ws, '.crew', 'snapshot.json'), 'utf8'));
    const jobEntries1 = Object.values(snap1.jobs || {});
    assert.strictEqual(jobEntries1.length, 1, 'Should have exactly 1 job initially');
    assert.strictEqual(jobEntries1[0].requisitionId, 'REQ-9999', 'Requisition ID must be preserved in snapshot');

    // Job 2 via secondary aggregator / mirror link with different domain and query tracking
    const out2 = execSync(
      `node "${crewBin}" job add --company "Orion Corp" --title "Lead Solutions Architect" --url "https://bayt.com/en/saudi-arabia/jobs/orion-solutions-req9999?ref=aggregator&utm_medium=email" --location "Riyadh, KSA" --requisitionId "REQ-9999" --workspace "${ws}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    assert(out2.includes('Duplicate requisition') || out2.includes('already exists') || out2.includes('Skipped duplicate'), `Expected duplicate warning for Job 2, got: ${out2}`);

    // Job 3 via third mirror with --requisition-id
    const out3 = execSync(
      `node "${crewBin}" job add --company "Orion Corp" --title "Solutions Architect III" --url "https://gulf-talent.example.com/jobs/orion-ssa-9999" --location "Riyadh, KSA" --requisition-id "REQ-9999" --workspace "${ws}"`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    assert(out3.includes('Duplicate requisition') || out3.includes('already exists') || out3.includes('Skipped duplicate'), `Expected duplicate warning for Job 3, got: ${out3}`);

    // Verify snapshot still has only 1 job
    const snap2 = JSON.parse(fs.readFileSync(path.join(ws, '.crew', 'snapshot.json'), 'utf8'));
    const jobEntries2 = Object.values(snap2.jobs || {});
    assert.strictEqual(jobEntries2.length, 1, `Snapshot should collapse duplicate into 1 job, found ${jobEntries2.length}`);
  });

  record('checkDuplicateRequisition detects duplicate requisition across case and location variants', () => {
    const existingJobs = [
      {
        id: 'job_001',
        company: 'Saudi Telecom Company',
        title: 'Cloud Security Lead',
        requisitionId: 'STC-SEC-404',
        canonicalUrl: 'https://stc.com.sa/careers/404',
        status: 'discovered'
      }
    ];

    let thrown = null;
    try {
      checkDuplicateRequisition(existingJobs, {
        company: 'saudi telecom company',
        title: 'Lead Cloud Security',
        requisitionId: 'stc-sec-404',
        url: 'https://linkedin.com/jobs/view/999888777?trackingId=abc'
      });
    } catch (err) {
      thrown = err;
    }

    assert(thrown !== null, 'checkDuplicateRequisition must throw DUPLICATE_REQUISITION');
    assert(thrown.code === 'DUPLICATE_REQUISITION' || thrown.message.includes('DUPLICATE_REQUISITION'), `Expected DUPLICATE_REQUISITION code, got: ${thrown.message}`);
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL PROBE 3: Direct EventLedger.appendEvent Submission Gate Probes
  // -------------------------------------------------------------------------
  console.log('\n>>> ADVERSARIAL PROBE GROUP 3: Direct EventLedger Submission Gate');

  await recordAsync('EventLedger.appendEvent blocks human submission when token is undefined', async () => {
    let thrown = null;
    try {
      await ledger.appendEvent({
        event: 'APPLICATION_SUBMITTED',
        actor: 'human:candidate',
        payload: {
          jobId: 'job_sub_no_token'
          // token is omitted!
        }
      });
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== null, 'EventLedger must throw when token is missing');
    assert(thrown.message.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${thrown.message}`);
    assert(thrown.message.includes('authorization token'), `Expected authorization token requirement, got: ${thrown.message}`);
  });

  await recordAsync('EventLedger.appendEvent blocks human submission when token is empty string', async () => {
    let thrown = null;
    try {
      await ledger.appendEvent({
        event: 'APPLICATION_SUBMITTED',
        actor: 'human',
        payload: {
          jobId: 'job_sub_empty_token',
          token: ''
        }
      });
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== null, 'EventLedger must throw when token is empty');
    assert(thrown.message.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${thrown.message}`);
  });

  await recordAsync('EventLedger.appendEvent blocks human submission when token is whitespace', async () => {
    let thrown = null;
    try {
      await ledger.appendEvent({
        event: 'JOB_SUBMITTED',
        actor: 'human:alice',
        payload: {
          jobId: 'job_sub_ws_token',
          token: '   \t\n  '
        }
      });
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== null, 'EventLedger must throw when token is whitespace');
    assert(thrown.message.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${thrown.message}`);
  });

  await recordAsync('EventLedger.appendEvent blocks non-human actor even with a valid token provided', async () => {
    let thrown = null;
    try {
      await ledger.appendEvent({
        event: 'APPLICATION_SUBMITTED',
        actor: 'agent:scribe',
        payload: {
          jobId: 'job_sub_agent',
          token: 'VALID-AUTHENTICATED-TOKEN-999'
        }
      });
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== null, 'EventLedger must throw when actor is automated agent');
    assert(thrown.message.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${thrown.message}`);
    assert(thrown.message.includes('strictly restricted to human users'), `Expected human restriction, got: ${thrown.message}`);
  });

  await recordAsync('EventLedger.appendEvent blocks payload with status="submitted" from agent', async () => {
    let thrown = null;
    try {
      await ledger.appendEvent({
        event: 'APPLICATION_UPDATED',
        actor: 'agent:recon',
        payload: {
          jobId: 'job_sub_sneaky',
          status: 'submitted',
          token: 'TOKEN'
        }
      });
    } catch (err) {
      thrown = err;
    }
    assert(thrown !== null, 'EventLedger must throw when status="submitted" is passed by non-human');
    assert(thrown.message.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${thrown.message}`);
  });

  // -------------------------------------------------------------------------
  // ADVERSARIAL PROBE 4: Vacancy Closure Without Evidence or Age Penalty
  // -------------------------------------------------------------------------
  console.log('\n>>> ADVERSARIAL PROBE GROUP 4: Vacancy Closure Guards');

  record('CLI crew job close blocks age-based closure attempts', () => {
    const crewBin = path.join(__dirname, '..', '..', 'bin', 'crew.js');
    let failed = false;
    let output = '';
    try {
      output = execSync(
        `node "${crewBin}" job close --id "job_age" --reason "Old vacancy" --evidence "posting_age" --proof "Posted 90 days ago" --workspace "${TEST_DIR}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
    } catch (err) {
      failed = true;
      output = (err.stdout || '') + (err.stderr || '') + err.message;
    }
    assert(failed, `CLI job close with posting_age should fail, but got: ${output}`);
    assert(output.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${output}`);
    assert(output.includes('posting age') || output.includes('cannot close'), `Expected posting age violation message, got: ${output}`);
  });

  record('CLI crew job close blocks closure without proof', () => {
    const crewBin = path.join(__dirname, '..', '..', 'bin', 'crew.js');
    let failed = false;
    let output = '';
    try {
      output = execSync(
        `node "${crewBin}" job close --id "job_noprf" --reason "HTTP 404 Not Found" --evidence "http_404" --workspace "${TEST_DIR}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
    } catch (err) {
      failed = true;
      output = (err.stdout || '') + (err.stderr || '') + err.message;
    }
    assert(failed, `CLI job close without --proof should fail, but got: ${output}`);
    assert(output.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${output}`);
  });

  // Clean up
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n======================================================================');
  console.log(`CHALLENGER LIVE PROBES SUMMARY: ${passed}/${total} checks passed (0 failed)`);
  console.log('======================================================================\n');
}

runLiveProbes().catch(err => {
  console.error('\nFATAL PROBE FAILURE:', err);
  process.exit(1);
});
