'use strict';

/**
 * Challenger M2 Iteration 4 Verification Suite
 * Adversarially tests:
 * 1. CLI flag normalization: --requisition-id and --requisitionId
 * 2. Mirror URL duplicate collapsing in snapshot.json
 * 3. PACKAGE_MARKED_READY bypasses with planted violations
 * 4. APPLICATION_SUBMITTED bypasses with empty, whitespace, and agent tokens
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { EventLedger } = require('../../lib/ledger/ledger');
const { GuardrailEngine } = require('../../lib/guardrails/engine');
const { checkDuplicateRequisition } = require('../../lib/guardrails/dedup');

const TEST_DIR = path.join(__dirname, '..', '..', '.test-challenger-m2-iter4-' + Date.now());
fs.mkdirSync(TEST_DIR, { recursive: true });

const crewBin = path.join(__dirname, '..', '..', 'bin', 'crew.js');

async function runChallengerVerification() {
  console.log('======================================================================');
  console.log('CHALLENGER M2 ITERATION 4 — EMPIRICAL VERIFICATION HARNESS');
  console.log('======================================================================\n');

  let passed = 0;
  let total = 0;

  function check(name, fn) {
    total++;
    try {
      fn();
      console.log(`  ✓ [TEST ${total}] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✖ [TEST ${total}] ${name}: ${err.message}`);
      throw err;
    }
  }

  async function checkAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✓ [TEST ${total}] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✖ [TEST ${total}] ${name}: ${err.message}`);
      throw err;
    }
  }

  try {
    // =========================================================================
    // SECTION 1: CLI Flag Normalization & Mirror URL Deduplication
    // =========================================================================
    console.log('>>> SECTION 1: CLI Flag Normalization & Mirror URL Deduplication');

    const wsFlagTest = path.join(TEST_DIR, 'ws-flags');
    fs.mkdirSync(wsFlagTest, { recursive: true });
    execSync(`node "${crewBin}" init --workspace "${wsFlagTest}"`, { stdio: 'pipe' });

    let addedJobId = null;

    check('Adding job with kebab-case --requisition-id sets snapshot.jobs[jobId].requisitionId correctly', () => {
      const out = execSync(
        `node "${crewBin}" job add --company "Acme Corp" --title "Platform Engineer" --url "https://careers.acme.com/jobs/pe-101?utm_source=linkedin" --location "Riyadh" --requisition-id "TEST-REQ-123" --workspace "${wsFlagTest}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      assert(out.includes('Job added successfully') || out.includes('JOB_DISCOVERED'), `Unexpected CLI output: ${out}`);

      const snapPath = path.join(wsFlagTest, '.crew', 'snapshot.json');
      assert(fs.existsSync(snapPath), 'snapshot.json must exist');
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));

      const jobEntries = Object.values(snap.jobs || {});
      assert.strictEqual(jobEntries.length, 1, `Expected exactly 1 job in snapshot, found ${jobEntries.length}`);

      const job = jobEntries[0];
      addedJobId = job.id;
      assert(addedJobId, 'Job ID must be generated');
      assert.strictEqual(job.requisitionId, 'TEST-REQ-123', `Expected requisitionId "TEST-REQ-123", got "${job.requisitionId}"`);
      assert.strictEqual(job.company, 'Acme Corp');
      assert.strictEqual(job.title, 'Platform Engineer');
      assert.strictEqual(job.url, 'https://careers.acme.com/jobs/pe-101'); // UTM stripped
    });

    check('Adding second job with camelCase --requisitionId on mirror URL collapses cleanly into existing job entry', () => {
      const out = execSync(
        `node "${crewBin}" job add --company "Acme Corp" --title "Senior Platform Engineer" --url "https://bayt.com/jobs/acme-pe-101?ref=aggregator" --location "Riyadh" --requisitionId "TEST-REQ-123" --workspace "${wsFlagTest}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      assert(out.includes('Duplicate requisition') || out.includes('already exists') || out.includes('Skipped duplicate'), `Expected duplicate notice, got: ${out}`);

      const snap = JSON.parse(fs.readFileSync(path.join(wsFlagTest, '.crew', 'snapshot.json'), 'utf8'));
      const jobEntries = Object.values(snap.jobs || {});
      assert.strictEqual(jobEntries.length, 1, `Expected snapshot to collapse into 1 job entry, found ${jobEntries.length}`);

      const job = jobEntries[0];
      assert.strictEqual(job.id, addedJobId, 'Job ID must match original job');
      assert.strictEqual(job.requisitionId, 'TEST-REQ-123', 'Requisition ID must remain TEST-REQ-123');
    });

    check('Adding third job with kebab-case --requisition-id on another mirror URL also collapses cleanly', () => {
      const out = execSync(
        `node "${crewBin}" job add --company "Acme Corp" --title "Lead Platform Engineer" --url "https://gulftalent.com/jobs/acme-infra-101?utm_medium=feed" --location "Riyadh" --requisition-id "TEST-REQ-123" --workspace "${wsFlagTest}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      );
      assert(out.includes('Duplicate requisition') || out.includes('already exists') || out.includes('Skipped duplicate'), `Expected duplicate notice, got: ${out}`);

      const snap = JSON.parse(fs.readFileSync(path.join(wsFlagTest, '.crew', 'snapshot.json'), 'utf8'));
      const jobEntries = Object.values(snap.jobs || {});
      assert.strictEqual(jobEntries.length, 1, `Snapshot must remain at exactly 1 job, found ${jobEntries.length}`);
    });

    // =========================================================================
    // SECTION 2: PACKAGE_MARKED_READY Guardrail Bypass Attempts
    // =========================================================================
    console.log('\n>>> SECTION 2: PACKAGE_MARKED_READY Guardrail Bypass Attempts');

    const wsGuardTest = path.join(TEST_DIR, 'ws-guards');
    fs.mkdirSync(wsGuardTest, { recursive: true });
    execSync(`node "${crewBin}" init --workspace "${wsGuardTest}"`, { stdio: 'pipe' });

    const ledgerFile = path.join(wsGuardTest, '.crew', 'ledger.jsonl');
    const lockFile = path.join(wsGuardTest, '.crew', 'ledger.lock');
    const ledger = new EventLedger({ ledgerPath: ledgerFile, lockPath: lockFile });

    await checkAsync('EventLedger.appendEvent rejects PACKAGE_MARKED_READY with planted violations array', async () => {
      let thrown = null;
      try {
        await ledger.appendEvent({
          event: 'PACKAGE_MARKED_READY',
          actor: 'agent:inquisitor',
          payload: {
            jobId: 'job_bypass_1',
            claimVerification: {
              passed: true, // adversary claims passed: true
              violations: ['Unverified metric: 10x throughput improvement']
            },
            reviewPanel: { verdict: 'APPROVE', reviewer: 'critic' }
          }
        });
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== null, 'Expected appendEvent to throw on planted violations');
      assert(thrown.message.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION, got: ${thrown.message}`);
      assert(thrown.message.includes('unresolved claim violations'), `Expected violations message, got: ${thrown.message}`);
    });

    await checkAsync('EventLedger.appendEvent rejects PACKAGE_MARKED_READY with empty string planted in violations', async () => {
      let thrown = null;
      try {
        await ledger.appendEvent({
          event: 'PACKAGE_MARKED_READY',
          actor: 'agent:inquisitor',
          payload: {
            jobId: 'job_bypass_2',
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
      assert(thrown !== null, 'Expected appendEvent to throw on non-empty violations array');
      assert(thrown.message.includes('GUARDRAIL_VIOLATION'));
    });

    await checkAsync('EventLedger.appendEvent rejects PACKAGE_MARKED_READY when claimVerification is missing or passed: false', async () => {
      let thrownMissing = null;
      try {
        await ledger.appendEvent({
          event: 'PACKAGE_MARKED_READY',
          actor: 'agent:inquisitor',
          payload: {
            jobId: 'job_bypass_3',
            reviewPanel: { verdict: 'APPROVE' }
          }
        });
      } catch (err) {
        thrownMissing = err;
      }
      assert(thrownMissing !== null && thrownMissing.message.includes('GUARDRAIL_VIOLATION'));

      let thrownFailed = null;
      try {
        await ledger.appendEvent({
          event: 'PACKAGE_MARKED_READY',
          actor: 'agent:inquisitor',
          payload: {
            jobId: 'job_bypass_4',
            claimVerification: { passed: false, violations: [] },
            reviewPanel: { verdict: 'APPROVE' }
          }
        });
      } catch (err) {
        thrownFailed = err;
      }
      assert(thrownFailed !== null && thrownFailed.message.includes('GUARDRAIL_VIOLATION'));
    });

    await checkAsync('EventLedger.appendEvent rejects PACKAGE_MARKED_READY when reviewPanel is not APPROVE', async () => {
      let thrown = null;
      try {
        await ledger.appendEvent({
          event: 'PACKAGE_MARKED_READY',
          actor: 'agent:inquisitor',
          payload: {
            jobId: 'job_bypass_5',
            claimVerification: { passed: true, violations: [] },
            reviewPanel: { verdict: 'REQUEST_CHANGES' }
          }
        });
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== null, 'Expected appendEvent to throw on non-APPROVE reviewPanel');
      assert(thrown.message.includes('GUARDRAIL_VIOLATION'));
      assert(thrown.message.includes('review panel approval'));
    });

    check('CLI crew ledger append rejects PACKAGE_MARKED_READY with planted violations', () => {
      const payload = JSON.stringify({
        jobId: 'job_cli_viol',
        claimVerification: { passed: true, violations: ['Planted fake claim C-999'] },
        reviewPanel: { verdict: 'APPROVE' }
      }).replace(/"/g, '\\"');

      let failed = false;
      let output = '';
      try {
        output = execSync(
          `node "${crewBin}" ledger append --event PACKAGE_MARKED_READY --payload "${payload}" --workspace "${wsGuardTest}"`,
          { encoding: 'utf8', stdio: 'pipe' }
        );
      } catch (err) {
        failed = true;
        output = (err.stdout || '') + (err.stderr || '') + err.message;
      }
      assert(failed, `CLI append should fail on planted violations, output: ${output}`);
      assert(output.includes('GUARDRAIL_VIOLATION'), `Expected GUARDRAIL_VIOLATION in CLI output, got: ${output}`);
    });

    check('GuardrailEngine.validateApplicationReadiness throws on planted violations', () => {
      assert.throws(
        () => {
          GuardrailEngine.validateApplicationReadiness({
            claimVerification: { passed: true, violations: ['Fabricated skill'] },
            reviewPanel: { verdict: 'APPROVE' }
          });
        },
        /GUARDRAIL_VIOLATION.*unresolved claim violations/
      );
    });

    // =========================================================================
    // SECTION 3: APPLICATION_SUBMITTED Guardrail Bypass Attempts
    // =========================================================================
    console.log('\n>>> SECTION 3: APPLICATION_SUBMITTED Guardrail Bypass Attempts');

    await checkAsync('EventLedger.appendEvent rejects human APPLICATION_SUBMITTED when token is empty string', async () => {
      let thrown = null;
      try {
        await ledger.appendEvent({
          event: 'APPLICATION_SUBMITTED',
          actor: 'human:alice',
          payload: { jobId: 'job_sub_1', token: '' }
        });
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== null, 'Expected throw on empty token');
      assert(thrown.message.includes('GUARDRAIL_VIOLATION'));
      assert(thrown.message.includes('non-empty authorization token'));
    });

    await checkAsync('EventLedger.appendEvent rejects human APPLICATION_SUBMITTED when token is whitespace-only', async () => {
      let thrown = null;
      try {
        await ledger.appendEvent({
          event: 'APPLICATION_SUBMITTED',
          actor: 'human:alice',
          payload: { jobId: 'job_sub_2', token: '    \t   ' }
        });
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== null, 'Expected throw on whitespace token');
      assert(thrown.message.includes('GUARDRAIL_VIOLATION'));
      assert(thrown.message.includes('non-empty authorization token'));
    });

    await checkAsync('EventLedger.appendEvent rejects human APPLICATION_SUBMITTED when token is missing/undefined', async () => {
      let thrown = null;
      try {
        await ledger.appendEvent({
          event: 'APPLICATION_SUBMITTED',
          actor: 'human:alice',
          payload: { jobId: 'job_sub_3' }
        });
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== null, 'Expected throw on missing token');
      assert(thrown.message.includes('GUARDRAIL_VIOLATION'));
    });

    await checkAsync('EventLedger.appendEvent rejects automated agent actor even with valid token', async () => {
      let thrown = null;
      try {
        await ledger.appendEvent({
          event: 'APPLICATION_SUBMITTED',
          actor: 'agent:scribe',
          payload: { jobId: 'job_sub_4', token: 'valid-human-token-xyz-123' }
        });
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== null, 'Expected throw on automated agent submission');
      assert(thrown.message.includes('GUARDRAIL_VIOLATION'));
      assert(thrown.message.includes('strictly restricted to human users'));
    });

    await checkAsync('EventLedger.appendEvent rejects stealth status="submitted" payload from agent actor', async () => {
      let thrown = null;
      try {
        await ledger.appendEvent({
          event: 'JOB_UPDATED',
          actor: 'agent:recon',
          payload: { jobId: 'job_sub_5', status: 'submitted', token: 'valid-token' }
        });
      } catch (err) {
        thrown = err;
      }
      assert(thrown !== null, 'Expected throw on status="submitted" payload from agent');
      assert(thrown.message.includes('GUARDRAIL_VIOLATION'));
      assert(thrown.message.includes('strictly restricted to human users'));
    });

    check('CLI crew job submit rejects submission when --token is missing', () => {
      let failed = false;
      let output = '';
      try {
        output = execSync(
          `node "${crewBin}" job submit --id "job_fake_001" --workspace "${wsGuardTest}"`,
          { encoding: 'utf8', stdio: 'pipe' }
        );
      } catch (err) {
        failed = true;
        output = (err.stdout || '') + (err.stderr || '') + err.message;
      }
      assert(failed, `CLI job submit should fail when token is omitted, output: ${output}`);
      assert(output.includes('GUARDRAIL_VIOLATION') || output.includes('--token'), `Expected token error, got: ${output}`);
    });

    check('CLI crew job submit rejects submission when --token is empty string', () => {
      let failed = false;
      let output = '';
      try {
        output = execSync(
          `node "${crewBin}" job submit --id "job_fake_001" --token "" --workspace "${wsGuardTest}"`,
          { encoding: 'utf8', stdio: 'pipe' }
        );
      } catch (err) {
        failed = true;
        output = (err.stdout || '') + (err.stderr || '') + err.message;
      }
      assert(failed, `CLI job submit should fail when token is empty, output: ${output}`);
      assert(output.includes('GUARDRAIL_VIOLATION') || output.includes('--token') || output.includes('ERROR'), `Expected token error, got: ${output}`);
    });

    check('GuardrailEngine.validateSubmission throws on automated actor even with valid token', () => {
      assert.throws(
        () => {
          GuardrailEngine.validateSubmission('agent:recon', 'job_fake_1', 'tok_123');
        },
        /GUARDRAIL_VIOLATION.*Automated actors \(agent:\*\) are strictly forbidden/
      );
    });

    check('GuardrailEngine.validateSubmission throws on human with empty or whitespace token', () => {
      assert.throws(
        () => {
          GuardrailEngine.validateSubmission('human', 'job_fake_1', '');
        },
        /GUARDRAIL_VIOLATION.*non-empty authorization token/
      );

      assert.throws(
        () => {
          GuardrailEngine.validateSubmission('human:alice', 'job_fake_1', '   ');
        },
        /GUARDRAIL_VIOLATION.*non-empty authorization token/
      );
    });

    console.log('\n======================================================================');
    console.log(`CHALLENGER VERIFICATION SUMMARY: ${passed}/${total} checks passed (0 failed)`);
    console.log('======================================================================\n');

  } finally {
    // Cleanup test directory
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (_) {}
  }
}

runChallengerVerification().catch(err => {
  console.error('\n✖ CHALLENGER VERIFICATION HARNESS FAILED:', err);
  process.exit(1);
});
