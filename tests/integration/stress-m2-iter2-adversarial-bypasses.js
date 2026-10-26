'use strict';
/**
 * JobHunt Crew — M2 Iteration 2 Adversarial Bypass Verification Suite
 * Author: challenger_m2_iter2_2 (Empirical Challenger)
 *
 * Verifies that all 5 critical adversarial bypass vectors are deterministically
 * blocked with GUARDRAIL_VIOLATION across CLI, Ledger, and MCP tool surfaces:
 *
 * Vector 1: Emit PACKAGE_MARKED_READY with missing verification or unapproved review
 * Vector 2: Submit unverified or newly discovered application via CLI, ledger, or MCP
 * Vector 3: Close job via CLI without --proof or with age-based/invalid proof
 * Vector 4: Submit application as human without valid authorization token
 * Vector 5: Circumvent cooldown windows or deduplication checks
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const crewBin = path.join(repoRoot, 'bin', 'crew.js');
const mcpBin = path.join(repoRoot, 'bin', 'crew-mcp.js');

const { GuardrailEngine } = require(path.join(repoRoot, 'lib', 'guardrails', 'engine'));
const { EventLedger } = require(path.join(repoRoot, 'lib', 'ledger', 'ledger'));
const {
  checkDuplicateRequisition,
  DuplicateApplicationGuard,
  normalizeJobUrl
} = require(path.join(repoRoot, 'lib', 'guardrails', 'dedup'));

async function run() {
  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
    failures: []
  };

  function testSync(name, fn) {
    summary.total++;
    try {
      fn();
      summary.passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      summary.failed++;
      summary.failures.push({ name, error: err.message });
      console.error(`  ✖ ${name}: ${err.message}`);
    }
  }

  async function testAsync(name, fn) {
    summary.total++;
    try {
      await fn();
      summary.passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      summary.failed++;
      summary.failures.push({ name, error: err.message });
      console.error(`  ✖ ${name}: ${err.message}`);
    }
  }

  console.log('======================================================================');
  console.log('JOBHUNT CREW — M2 ITERATION 2 ADVERSARIAL BYPASS SUITE');
  console.log('======================================================================\n');

  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-m2-iter2-adv-'));
  execSync(`node "${crewBin}" init --workspace "${tmpWorkspace}"`, { encoding: 'utf8' });

  // Add initial test vacancies in workspace
  execSync(`node "${crewBin}" job add --url "https://careers.solaris.ai/jobs/senior-ml-eng" --title "Senior ML Engineer" --company "Solaris AI" --location "Riyadh" --source "direct" --workspace "${tmpWorkspace}"`, { encoding: 'utf8' });
  execSync(`node "${crewBin}" job add --url "https://careers.orion.org/jobs/staff-devops" --title "Staff DevOps Engineer" --company "Orion Global" --location "Dammam" --source "ats" --workspace "${tmpWorkspace}"`, { encoding: 'utf8' });

  const snapshotFile = path.join(tmpWorkspace, '.crew', 'snapshot.json');
  const snap = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  const jobs = Object.values(snap.jobs);
  const solarisJob = jobs.find(j => j.company === 'Solaris AI');
  const orionJob = jobs.find(j => j.company === 'Orion Global');

  assert.ok(solarisJob, 'Solaris AI job must exist in snapshot');
  assert.ok(orionJob, 'Orion Global job must exist in snapshot');

  // =========================================================================
  // VECTOR 1: PACKAGE_MARKED_READY BYPASS ATTEMPTS
  // =========================================================================
  console.log('>>> VECTOR 1: PACKAGE_MARKED_READY Readiness Gate Bypass Probes');

  // 1.1 Direct EventLedger with missing claimVerification
  await testAsync('EventLedger.appendEvent blocks PACKAGE_MARKED_READY when claimVerification is missing', async () => {
    const ledger = new EventLedger({ ledgerPath: path.join(tmpWorkspace, '.crew', 'ledger.jsonl') });
    await assert.rejects(
      async () => {
        await ledger.appendEvent({
          event: 'PACKAGE_MARKED_READY',
          payload: { jobId: solarisJob.id, reviewPanel: { verdict: 'APPROVE' } },
          actor: 'agent:scribe'
        });
      },
      /GUARDRAIL_VIOLATION.*claim verification/
    );
  });

  // 1.2 Direct EventLedger with claimVerification.passed = false
  await testAsync('EventLedger.appendEvent blocks PACKAGE_MARKED_READY when claimVerification.passed is false', async () => {
    const ledger = new EventLedger({ ledgerPath: path.join(tmpWorkspace, '.crew', 'ledger.jsonl') });
    await assert.rejects(
      async () => {
        await ledger.appendEvent({
          event: 'PACKAGE_MARKED_READY',
          payload: {
            jobId: solarisJob.id,
            claimVerification: { passed: false },
            reviewPanel: { verdict: 'APPROVE' }
          },
          actor: 'agent:scribe'
        });
      },
      /GUARDRAIL_VIOLATION.*claim verification/
    );
  });

  // 1.3 Direct EventLedger with missing reviewPanel
  await testAsync('EventLedger.appendEvent blocks PACKAGE_MARKED_READY when reviewPanel is missing', async () => {
    const ledger = new EventLedger({ ledgerPath: path.join(tmpWorkspace, '.crew', 'ledger.jsonl') });
    await assert.rejects(
      async () => {
        await ledger.appendEvent({
          event: 'PACKAGE_MARKED_READY',
          payload: {
            jobId: solarisJob.id,
            claimVerification: { passed: true }
          },
          actor: 'agent:scribe'
        });
      },
      /GUARDRAIL_VIOLATION.*review panel approval/
    );
  });

  // 1.4 Direct EventLedger with reviewPanel.verdict = 'REQUEST_CHANGES'
  await testAsync('EventLedger.appendEvent blocks PACKAGE_MARKED_READY when reviewPanel verdict is REQUEST_CHANGES', async () => {
    const ledger = new EventLedger({ ledgerPath: path.join(tmpWorkspace, '.crew', 'ledger.jsonl') });
    await assert.rejects(
      async () => {
        await ledger.appendEvent({
          event: 'PACKAGE_MARKED_READY',
          payload: {
            jobId: solarisJob.id,
            claimVerification: { passed: true },
            reviewPanel: { verdict: 'REQUEST_CHANGES' }
          },
          actor: 'agent:scribe'
        });
      },
      /GUARDRAIL_VIOLATION.*review panel approval/
    );
  });

  // 1.5 Direct EventLedger with empty payload
  await testAsync('EventLedger.appendEvent blocks PACKAGE_MARKED_READY with empty payload object', async () => {
    const ledger = new EventLedger({ ledgerPath: path.join(tmpWorkspace, '.crew', 'ledger.jsonl') });
    await assert.rejects(
      async () => {
        await ledger.appendEvent({
          event: 'PACKAGE_MARKED_READY',
          payload: {},
          actor: 'agent:scribe'
        });
      },
      /GUARDRAIL_VIOLATION.*claim verification/
    );
  });

  // 1.6 CLI crew ledger append PACKAGE_MARKED_READY without verification
  testSync('CLI crew ledger append blocks PACKAGE_MARKED_READY without claimVerification', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" ledger append --event PACKAGE_MARKED_READY --payload "{\\"jobId\\":\\"${solarisJob.id}\\",\\"reviewPanel\\":{\\"verdict\\":\\"APPROVE\\"}}" --actor "agent:scribe" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION/);
  });

  // 1.7 CLI crew ledger append PACKAGE_MARKED_READY without review approval
  testSync('CLI crew ledger append blocks PACKAGE_MARKED_READY with unapproved review panel', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" ledger append --event PACKAGE_MARKED_READY --payload "{\\"jobId\\":\\"${solarisJob.id}\\",\\"claimVerification\\":{\\"passed\\":true},\\"reviewPanel\\":{\\"verdict\\":\\"REJECT\\"}}" --actor "agent:scribe" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION/);
  });

  // =========================================================================
  // VECTOR 2: SUBMIT UNVERIFIED APPLICATION BYPASS ATTEMPTS
  // =========================================================================
  console.log('\n>>> VECTOR 2: Unverified Application Submission Bypass Probes');

  // 2.1 CLI crew job submit on newly discovered job (not ready)
  testSync('CLI crew job submit rejects unverified job (not marked ready)', () => {
    let blocked = false;
    try {
      execSync(`node "${crewBin}" job submit --id "${solarisJob.id}" --token "human-auth-tok" --actor "human:operator" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      if (err.message.includes('GUARDRAIL_VIOLATION') && err.message.includes('unverified')) {
        blocked = true;
      }
    }
    assert.ok(blocked, 'Unverified job submission must be blocked with GUARDRAIL_VIOLATION');
  });

  // 2.2 CLI crew job submit on non-existent job ID
  testSync('CLI crew job submit rejects non-existent job ID as unverified', () => {
    let blocked = false;
    try {
      execSync(`node "${crewBin}" job submit --id "non_existent_job_999" --token "human-auth-tok" --actor "human:operator" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      if (err.message.includes('GUARDRAIL_VIOLATION')) {
        blocked = true;
      }
    }
    assert.ok(blocked, 'Non-existent job ID submission must be blocked with GUARDRAIL_VIOLATION');
  });

  // 2.3 CLI crew ledger append APPLICATION_SUBMITTED for unverified job
  testSync('CLI crew ledger append rejects APPLICATION_SUBMITTED for unverified job', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" ledger append --event APPLICATION_SUBMITTED --payload "{\\"jobId\\":\\"${orionJob.id}\\",\\"token\\":\\"auth_tok_xyz\\"}" --actor "human" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION.*unverified/);
  });

  // 2.4 CLI crew ledger append JOB_SUBMITTED for unverified job
  testSync('CLI crew ledger append rejects JOB_SUBMITTED for unverified job', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" ledger append --event JOB_SUBMITTED --payload "{\\"id\\":\\"${orionJob.id}\\",\\"token\\":\\"auth_tok_xyz\\"}" --actor "human" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION.*unverified/);
  });

  // 2.5 CLI crew ledger append with payload.status = 'submitted' for unverified job
  testSync('CLI crew ledger append rejects payload.status="submitted" for unverified job', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" ledger append --event JOB_STATUS_CHANGED --payload "{\\"jobId\\":\\"${orionJob.id}\\",\\"status\\":\\"submitted\\",\\"token\\":\\"auth_tok_xyz\\"}" --actor "human" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION.*unverified/);
  });

  // =========================================================================
  // VECTOR 3: VACANCY CLOSURE WITHOUT PROOF OR INVALID PROOF
  // =========================================================================
  console.log('\n>>> VECTOR 3: Vacancy Closure Without Proof or With Age-Based Proof Probes');

  // 3.1 CLI crew job close without --proof flag
  testSync('CLI crew job close rejects closure when --proof is omitted', () => {
    let failed = false;
    try {
      execSync(`node "${crewBin}" job close --id "${solarisJob.id}" --reason "Role closed" --evidence "http_404" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      if (err.message.includes('--proof') || err.message.includes('GUARDRAIL_VIOLATION')) {
        failed = true;
      }
    }
    assert.ok(failed, 'Omitting --proof flag must fail');
  });

  // 3.2 CLI crew job close with empty --proof string
  testSync('CLI crew job close rejects empty --proof flag', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job close --id "${solarisJob.id}" --reason "Role closed" --evidence "http_404" --proof "" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION|Missing required/);
  });

  // 3.3 CLI crew job close with whitespace-only --proof
  testSync('CLI crew job close rejects whitespace-only --proof flag', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job close --id "${solarisJob.id}" --reason "Role closed" --evidence "http_404" --proof "    " --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION/);
  });

  // 3.4 CLI crew job close with posting_age evidence
  testSync('CLI crew job close rejects posting_age evidence type', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job close --id "${solarisJob.id}" --reason "Stale vacancy" --evidence "posting_age" --proof "Listed 120 days ago" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION.*posting age/);
  });

  // 3.5 CLI crew job close with reason containing '> 60 days'
  testSync('CLI crew job close rejects closure with age text in reason', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job close --id "${solarisJob.id}" --reason "Vacancy is older than 60 days" --evidence "http_404" --proof "Valid 404 response" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION.*posting age/);
  });

  // 3.6 CLI crew ledger append JOB_CLOSED with posting_age evidence
  testSync('CLI crew ledger append rejects JOB_CLOSED with posting_age evidence', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" ledger append --event JOB_CLOSED --payload "{\\"id\\":\\"${solarisJob.id}\\",\\"evidence\\":{\\"type\\":\\"posting_age\\",\\"proof\\":\\"90 days\\"}}" --actor "agent:recon" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION.*posting age/);
  });

  // =========================================================================
  // VECTOR 4: HUMAN SUBMISSION WITHOUT AUTH TOKEN
  // =========================================================================
  console.log('\n>>> VECTOR 4: Human Submission Without Auth Token Probes');

  // 4.1 CLI crew job submit without --token
  testSync('CLI crew job submit rejects call when --token is omitted', () => {
    let failed = false;
    try {
      execSync(`node "${crewBin}" job submit --id "${solarisJob.id}" --actor "human:admin" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      if (err.message.includes('--token') || err.message.includes('GUARDRAIL_VIOLATION')) {
        failed = true;
      }
    }
    assert.ok(failed, 'Omitting --token must fail');
  });

  // 4.2 CLI crew job submit with empty string token
  testSync('CLI crew job submit rejects call with empty --token ""', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job submit --id "${solarisJob.id}" --token "" --actor "human:admin" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION|Missing required/);
  });

  // 4.3 CLI crew ledger append APPLICATION_SUBMITTED with missing token
  testSync('CLI crew ledger append rejects human APPLICATION_SUBMITTED with missing token', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" ledger append --event APPLICATION_SUBMITTED --payload "{\\"jobId\\":\\"${solarisJob.id}\\"}" --actor "human" --workspace "${tmpWorkspace}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION.*token/);
  });

  // 4.4 GuardrailEngine.validateSubmission direct unit probes
  testSync('GuardrailEngine.validateSubmission rejects human with undefined token', () => {
    assert.throws(() => {
      GuardrailEngine.validateSubmission('human', 'job-xyz', undefined);
    }, /GUARDRAIL_VIOLATION.*token/);
  });

  testSync('GuardrailEngine.validateSubmission rejects human with whitespace-only token', () => {
    assert.throws(() => {
      GuardrailEngine.validateSubmission('human:alice', 'job-xyz', '    ');
    }, /GUARDRAIL_VIOLATION.*token/);
  });

  testSync('GuardrailEngine.validateSubmission rejects automated agent even when token is supplied', () => {
    assert.throws(() => {
      GuardrailEngine.validateSubmission('agent:recon', 'job-xyz', 'valid-token-123');
    }, /GUARDRAIL_VIOLATION/);
  });

  // =========================================================================
  // VECTOR 5: COOLDOWN AND DEDUPLICATION BYPASS PROBES
  // =========================================================================
  console.log('\n>>> VECTOR 5: Cooldown and Deduplication Circumvention Probes');

  // 5.1 CLI crew job add with tracking parameters on existing URL
  testSync('CLI crew job add collapses duplicate URL with UTM tracking parameters', () => {
    const out = execSync(`node "${crewBin}" job add --url "https://careers.solaris.ai/jobs/senior-ml-eng?utm_source=linkedin&utm_campaign=winter2026&ref=email" --title "Senior ML Engineer" --company "Solaris AI" --location "Riyadh" --workspace "${tmpWorkspace}"`, {
      encoding: 'utf8'
    });
    assert.ok(out.includes('already exists') || out.includes('collapsed'), 'Should report duplicate collapsed');
  });

  // 5.2 CLI crew job add with identical company and requisitionId
  testSync('CLI crew job add collapses duplicate company + requisitionId', () => {
    execSync(`node "${crewBin}" job add --url "https://careers.orion.org/req-900" --title "Site Reliability Eng" --company "Orion Global" --requisition-id "REQ-ORION-900" --workspace "${tmpWorkspace}"`, {
      encoding: 'utf8'
    });
    const out = execSync(`node "${crewBin}" job add --url "https://careers.orion.org/req-900-mirror" --title "Site Reliability Eng Mirror" --company "Orion Global" --requisitionId "REQ-ORION-900" --workspace "${tmpWorkspace}"`, {
      encoding: 'utf8'
    });
    assert.ok(out.includes('already exists'), 'Requisition REQ-ORION-900 duplicate must be detected');

    const out2 = execSync(`node "${crewBin}" job add --url "https://careers.orion.org/req-900-mirror-2" --title "SRE" --company "Orion Global" --requisition-id "REQ-ORION-900" --workspace "${tmpWorkspace}"`, {
      encoding: 'utf8'
    });
    assert.ok(out2.includes('already exists'), 'Requisition REQ-ORION-900 duplicate must be detected with --requisition-id');
  });

  // 5.3 Deduplication engine throws DUPLICATE_REQUISITION when throwOnError is true
  testSync('checkDuplicateRequisition throws DUPLICATE_REQUISITION on duplicate requisitionId', () => {
    const existingList = [
      { id: 'job_01', company: 'Titan Cloud', title: 'Security Architect', requisitionId: 'REQ-TITAN-1' }
    ];
    assert.throws(() => {
      checkDuplicateRequisition(existingList, {
        company: 'Titan Cloud',
        title: 'Cloud Security Lead',
        requisitionId: 'REQ-TITAN-1'
      }, { throwOnError: true });
    }, /DUPLICATE_REQUISITION/);
  });

  testSync('checkDuplicateRequisition throws DUPLICATE_REQUISITION on identical canonical URL', () => {
    const existingList = [
      { id: 'job_02', company: 'Nova Corp', title: 'Data Lead', url: 'https://jobs.lever.co/novacorp/12345' }
    ];
    assert.throws(() => {
      checkDuplicateRequisition(existingList, {
        company: 'Nova Corp',
        title: 'Lead Data Engineer',
        url: 'https://jobs.lever.co/novacorp/12345/apply?lever-source=linkedin'
      }, { throwOnError: true });
    }, /DUPLICATE_REQUISITION/);
  });

  // 5.4 Cooldown window warning verification
  testSync('checkDuplicateRequisition returns COMPANY_COOLDOWN_ACTIVE warning within 30 days', () => {
    const pastAppDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const existingList = [
      { id: 'job_03', company: 'Vertex Solutions', title: 'Frontend Lead', status: 'applied', appliedAt: pastAppDate }
    ];
    const res = checkDuplicateRequisition(existingList, {
      company: 'Vertex Solutions',
      title: 'Full Stack Engineer',
      url: 'https://vertex.example.com/jobs/full-stack'
    }, { throwOnError: false, cooldownDays: 30 });

    assert.strictEqual(res.isDuplicate, false);
    assert.strictEqual(res.warning, 'COMPANY_COOLDOWN_ACTIVE');
    assert.strictEqual(res.cooldownRemainingDays, 20);
  });

  // 5.5 Cooldown window clears after 30 days
  testSync('checkDuplicateRequisition returns zero warning when past cooldown window', () => {
    const pastAppDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago
    const existingList = [
      { id: 'job_04', company: 'Apex Digital', title: 'Backend Lead', status: 'submitted', submittedAt: pastAppDate }
    ];
    const res = checkDuplicateRequisition(existingList, {
      company: 'Apex Digital',
      title: 'DevOps Specialist',
      url: 'https://apex.example.com/jobs/devops'
    }, { throwOnError: false, cooldownDays: 30 });

    assert.strictEqual(res.isDuplicate, false);
    assert.strictEqual(res.warning, null);
  });

  // 5.6 DuplicateApplicationGuard stateful behavior
  testSync('DuplicateApplicationGuard blocks duplicate application to same requisition', () => {
    const guard = new DuplicateApplicationGuard(30);
    guard.recordApplication('REQ-ALPHA-100', 'Alpha Tech', new Date().toISOString());

    const evalRes = guard.evaluateApplicationEligibility('REQ-ALPHA-100', 'Alpha Tech');
    assert.strictEqual(evalRes.allowed, false);
    assert.strictEqual(evalRes.reason, 'DUPLICATE_REQUISITION');
  });

  // =========================================================================
  // MCP SERVER PROTOCOL ADVERSARIAL CHECKS
  // =========================================================================
  console.log('\n>>> SECTION 6: MCP Server Tool Adversarial Bypasses');

  await testAsync('MCP Server: Rejects unverified submission with isError: true and GUARDRAIL_VIOLATION', async () => {
    const mcpProcess = spawn('node', [mcpBin, '--workspace', tmpWorkspace], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    mcpProcess.stdout.on('data', d => { stdout += d.toString(); });

    const wait = async (id, timeout = 4000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        for (const line of stdout.split('\n').filter(Boolean)) {
          try {
            const p = JSON.parse(line);
            if (p.id === id) return p;
          } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 20));
      }
      throw new Error(`Timeout waiting for response id ${id}`);
    };

    // 1. Initialize
    mcpProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    await wait(1);

    // 2. Try to submit unverified application via MCP crew_record_event
    mcpProcess.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'crew_record_event',
        arguments: {
          type: 'APPLICATION_SUBMITTED',
          payload: { jobId: solarisJob.id, token: 'valid-token' },
          actor: 'human:operator'
        }
      }
    }) + '\n');
    const r2 = await wait(2);

    assert.strictEqual(r2.result.isError, true, 'MCP call must return isError: true');
    assert.ok(r2.result.content[0].text.includes('GUARDRAIL_VIOLATION'), 'Response must contain GUARDRAIL_VIOLATION');
    assert.ok(r2.result.content[0].text.includes('unverified'), 'Response must explain unverified application');

    // 3. Try to emit PACKAGE_MARKED_READY via MCP crew_record_event without claimVerification
    mcpProcess.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'crew_record_event',
        arguments: {
          type: 'PACKAGE_MARKED_READY',
          payload: { jobId: solarisJob.id, reviewPanel: { verdict: 'APPROVE' } },
          actor: 'agent:scribe'
        }
      }
    }) + '\n');
    const r3 = await wait(3);

    assert.strictEqual(r3.result.isError, true, 'MCP call must return isError: true');
    assert.ok(r3.result.content[0].text.includes('GUARDRAIL_VIOLATION'), 'Response must contain GUARDRAIL_VIOLATION');
    assert.ok(r3.result.content[0].text.includes('claim verification'), 'Response must cite claim verification failure');

    // 4. Try to close job via MCP crew_close_job with posting_age evidence
    mcpProcess.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'crew_close_job',
        arguments: {
          job_id: solarisJob.id,
          evidence_type: 'posting_age',
          proof: '90 days old'
        }
      }
    }) + '\n');
    const r4 = await wait(4);

    assert.strictEqual(r4.result.isError, true, 'MCP call must return isError: true');
    assert.ok(r4.result.content[0].text.includes('GUARDRAIL_VIOLATION'), 'Response must contain GUARDRAIL_VIOLATION');

    // 5. Try human submission without auth token via MCP
    mcpProcess.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'crew_record_event',
        arguments: {
          type: 'APPLICATION_SUBMITTED',
          payload: { jobId: solarisJob.id },
          actor: 'human'
        }
      }
    }) + '\n');
    const r5 = await wait(5);

    assert.strictEqual(r5.result.isError, true, 'MCP call must return isError: true');
    assert.ok(r5.result.content[0].text.includes('GUARDRAIL_VIOLATION'), 'Response must contain GUARDRAIL_VIOLATION');
    assert.ok(r5.result.content[0].text.includes('token'), 'Response must cite missing token');

    mcpProcess.kill();
  });

  // Cleanup temporary workspace
  if (tmpWorkspace && fs.existsSync(tmpWorkspace)) {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  }

  console.log('\n======================================================================');
  console.log(`ADVERSARIAL SUITE SUMMARY: ${summary.passed}/${summary.total} checks passed (${summary.failed} failed)`);
  if (summary.failures.length > 0) {
    console.log('FAILURES:');
    summary.failures.forEach((f, idx) => {
      console.log(`  ${idx + 1}. ${f.name}: ${f.error}`);
    });
  }
  console.log('======================================================================\n');

  return summary;
}

if (require.main === module) {
  run().then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}

module.exports = { run };
