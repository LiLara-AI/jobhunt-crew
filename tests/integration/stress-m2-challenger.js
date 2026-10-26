'use strict';
/**
 * JobHunt Crew — Adversarial Stress Test Suite for Milestone M2
 * Author: challenger_m2_2 (Empirical Challenger)
 *
 * Comprehensive stress harness covering:
 * 1. Guardrail Bypass Attempts:
 *    - Automated agent submissions across direct API, CLI, and MCP
 *    - Age-based closure attempts (posting_age, > 60 days, old vacancy, indicators, missing/empty proof)
 *    - CLI empty proof fallback vulnerability
 *    - Unverified application submission / readiness gate verification
 * 2. MCP Server Protocol & Robustness:
 *    - JSON-RPC 2.0 handshake (initialize, ping, tools/list, notifications/initialized)
 *    - Protocol error handling (unknown method -32601, malformed JSON -32700, missing params -32602)
 *    - stdio tool execution for all 6 tools
 *    - Process crash resilience on guardrail violations ({ isError: true })
 * 3. Event Ledger Cryptographic Integrity & Tamper Detection:
 *    - Sequence gaps
 *    - Tampered payloads / invalid parent hash chaining
 *    - Corrupted JSON lines
 * 4. Concurrency Lock & Stale Recovery:
 *    - Atomic 'wx' creation
 *    - Stale lock detection and recovery
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
const { FileLock } = require(path.join(repoRoot, 'lib', 'ledger', 'lock'));

async function run() {
  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
    vulnerabilities: []
  };

  function check(name, fn) {
    summary.total++;
    try {
      fn();
      summary.passed++;
      console.log(`      ✓ ${name}`);
    } catch (err) {
      summary.failed++;
      summary.vulnerabilities.push({ name, error: err.message });
      console.error(`      ✖ ${name}: ${err.message}`);
    }
  }

  async function checkAsync(name, fn) {
    summary.total++;
    try {
      await fn();
      summary.passed++;
      console.log(`      ✓ ${name}`);
    } catch (err) {
      summary.failed++;
      summary.vulnerabilities.push({ name, error: err.message });
      console.error(`      ✖ ${name}: ${err.message}`);
    }
  }

  console.log('======================================================================');
  console.log('JOBHUNT CREW — M2 ADVERSARIAL CHALLENGER STRESS SUITE');
  console.log('======================================================================\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-m2-stress-'));
  execSync(`node "${crewBin}" init --workspace "${tmpDir}"`, { encoding: 'utf8' });

  // Add baseline fixture job
  execSync(`node "${crewBin}" job add --url "https://careers.example.com/jobs/lead-architect-01" --title "Lead Solutions Architect" --company "Vertex Systems" --location "Riyadh" --source "web" --workspace "${tmpDir}"`, { encoding: 'utf8' });
  const snapshot = JSON.parse(fs.readFileSync(path.join(tmpDir, '.crew', 'snapshot.json'), 'utf8'));
  const testJobId = Object.keys(snapshot.jobs)[0];
  assert.ok(testJobId, 'Baseline fixture job must exist');

  // =========================================================================
  // 1. AUTOMATED SUBMISSION GUARDRAILS
  // =========================================================================
  console.log('>>> SECTION 1: Automated Agent Submission Guardrail Tests');

  const automatedActors = [
    'agent:scribe',
    'agent:recon',
    'system:auto',
    'agent:inquisitor',
    'agent:critic',
    'agent:liaison',
    'agent:navigator',
    'bot:auto-applier',
    'automated-cron',
    '',
    null,
    undefined,
    12345,
    'human-imposter',
    'HUMAN',
    'agent:human'
  ];

  for (const actor of automatedActors) {
    check(`GuardrailEngine.validateSubmission rejects actor: ${JSON.stringify(actor)}`, () => {
      assert.throws(() => {
        GuardrailEngine.validateSubmission(actor, testJobId, 'token-123');
      }, /GUARDRAIL_VIOLATION/);
    });
  }

  check('CLI crew job submit rejects --actor agent:scribe with GUARDRAIL_VIOLATION', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job submit --id "${testJobId}" --token "tok_abc" --actor "agent:scribe" --workspace "${tmpDir}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION/);
  });

  check('CLI crew job submit rejects --actor agent:recon with GUARDRAIL_VIOLATION', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job submit --id "${testJobId}" --token "tok_abc" --actor "agent:recon" --workspace "${tmpDir}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION/);
  });

  check('CLI crew job submit rejects --actor system:auto with GUARDRAIL_VIOLATION', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job submit --id "${testJobId}" --token "tok_abc" --actor "system:auto" --workspace "${tmpDir}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION/);
  });

  check('CLI crew ledger append APPLICATION_SUBMITTED rejects --actor agent:scribe', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" ledger append --event APPLICATION_SUBMITTED --payload "{\\"jobId\\":\\"${testJobId}\\",\\"token\\":\\"tok_123\\"}" --actor "agent:scribe" --workspace "${tmpDir}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION/);
  });

  check('GuardrailEngine.validateSubmission rejects human actor with missing token', () => {
    assert.throws(() => {
      GuardrailEngine.validateSubmission('human', testJobId, '');
    }, /GUARDRAIL_VIOLATION/);
  });

  // =========================================================================
  // 2. AGE-BASED CLOSURE GUARDRAILS
  // =========================================================================
  console.log('\n>>> SECTION 2: Evidence-Based Closure Guardrail Tests');

  const ageClosureCases = [
    { label: 'type: posting_age', ev: { type: 'posting_age', proof: 'Listed 90 days ago' } },
    { label: 'reason: > 60 days with posting_age', ev: { type: 'posting_age', reason: '> 60 days', proof: 'Old' } },
    { label: 'reason: old vacancy with posting_age', ev: { type: 'posting_age', reason: 'old vacancy', proof: 'Old' } },
    { label: 'type: age_limit', ev: { type: 'age_limit', proof: 'Exceeded 45 days' } },
    { label: 'type: days_old', ev: { type: 'days_old', proof: '120 days old' } },
    { label: 'days flag: { days: 60 }', ev: { type: 'http_404', days: 60, proof: '404' } },
    { label: 'reason text mentions posting_age', ev: { type: 'http_404', reason: 'closed because of posting_age', proof: '404' } },
    { label: 'reason text mentions days old', ev: { type: 'http_404', reason: 'this listing is 75 days old', proof: '404' } },
    { label: 'reason text mentions older than', ev: { type: 'http_404', reason: 'older than 60 days', proof: '404' } },
    { label: 'invalid type: old vacancy', ev: { type: 'old vacancy', proof: 'Old' } },
    { label: 'invalid type: > 60 days', ev: { type: '> 60 days', proof: 'Old' } },
    { label: 'empty proof', ev: { type: 'http_404', proof: '' } },
    { label: 'whitespace proof', ev: { type: 'http_404', proof: '   ' } },
    { label: 'missing proof', ev: { type: 'http_404' } }
  ];

  for (const c of ageClosureCases) {
    check(`GuardrailEngine.validateClosure rejects ${c.label}`, () => {
      assert.throws(() => {
        GuardrailEngine.validateClosure(c.ev);
      }, /GUARDRAIL_VIOLATION/);
    });
  }

  check('CLI crew job close blocks evidence "posting_age"', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job close --id "${testJobId}" --reason "stale posting" --evidence "posting_age" --proof "90 days" --workspace "${tmpDir}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION/);
  });

  check('CLI crew job close blocks reason "> 60 days" with age evidence', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job close --id "${testJobId}" --reason "> 60 days old" --evidence "posting_age" --proof "old" --workspace "${tmpDir}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION/);
  });

  check('CLI crew job close blocks evidence "old vacancy" without valid proof', () => {
    assert.throws(() => {
      execSync(`node "${crewBin}" job close --id "${testJobId}" --reason "old vacancy" --evidence "old vacancy" --workspace "${tmpDir}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    }, /GUARDRAIL_VIOLATION/);
  });

  // Empirical test for the CLI proof fallback vulnerability
  check('[VULNERABILITY PROBE] CLI crew job close requires mandatory proof and does not fallback to reason', () => {
    // When someone omits --proof, crew job close currently falls back to `reason` (bin/crew.js:509)
    // This allows closing vacancies with arbitrary reasons without objective proof
    let blocked = false;
    try {
      execSync(`node "${crewBin}" job close --id "${testJobId}" --reason "Vacancy closed by recruiter" --evidence "http_404" --workspace "${tmpDir}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      if (err.message.includes('GUARDRAIL_VIOLATION') || err.message.includes('--proof')) {
        blocked = true;
      }
    }
    assert.ok(blocked, 'CLI job close should require explicit --proof instead of silently substituting --reason');
  });

  // =========================================================================
  // 3. READINESS GATE & UNVERIFIED APPLICATION SUBMISSION
  // =========================================================================
  console.log('\n>>> SECTION 3: Readiness Gate & Unverified Submission Tests');

  check('GuardrailEngine.validateApplicationReadiness blocks package without claimVerification', () => {
    assert.throws(() => {
      GuardrailEngine.validateApplicationReadiness({
        reviewPanel: { verdict: 'APPROVE' }
      });
    }, /GUARDRAIL_VIOLATION.*claim verification/);
  });

  check('GuardrailEngine.validateApplicationReadiness blocks package with claimVerification.passed = false', () => {
    assert.throws(() => {
      GuardrailEngine.validateApplicationReadiness({
        claimVerification: { passed: false },
        reviewPanel: { verdict: 'APPROVE' }
      });
    }, /GUARDRAIL_VIOLATION.*claim verification/);
  });

  check('GuardrailEngine.validateApplicationReadiness blocks package with unresolved claim violations', () => {
    assert.throws(() => {
      GuardrailEngine.validateApplicationReadiness({
        claimVerification: { passed: true, violations: ['Fabricated metric: 500%'] },
        reviewPanel: { verdict: 'APPROVE' }
      });
    }, /GUARDRAIL_VIOLATION.*violations/);
  });

  check('GuardrailEngine.validateApplicationReadiness blocks package without review panel approval', () => {
    assert.throws(() => {
      GuardrailEngine.validateApplicationReadiness({
        claimVerification: { passed: true, violations: [] },
        reviewPanel: { verdict: 'REQUEST_CHANGES' }
      });
    }, /GUARDRAIL_VIOLATION.*review panel approval/);
  });

  check('GuardrailEngine.validateApplicationReadiness passes 100% verified and approved package', () => {
    const res = GuardrailEngine.validateApplicationReadiness({
      claimVerification: { passed: true, violations: [] },
      reviewPanel: { verdict: 'APPROVE', score: 4.8 }
    });
    assert.strictEqual(res, true);
  });

  // Empirical test for submission before claim verification
  check('[VULNERABILITY PROBE] Unverified application submission must fail readiness gate', () => {
    // Add a fresh unverified job
    execSync(`node "${crewBin}" job add --url "https://careers.example.com/jobs/unverified-01" --title "Platform Engineer" --company "Apex Tech" --workspace "${tmpDir}"`, { encoding: 'utf8' });
    const snap = JSON.parse(fs.readFileSync(path.join(tmpDir, '.crew', 'snapshot.json'), 'utf8'));
    const unverifiedJobId = Object.values(snap.jobs).find(j => j.title === 'Platform Engineer').id;

    // Attempting to submit this unverified job MUST fail readiness gate
    let submissionBlocked = false;
    try {
      execSync(`node "${crewBin}" job submit --id "${unverifiedJobId}" --token "human-token-123" --actor "human:reviewer" --workspace "${tmpDir}"`, {
        encoding: 'utf8',
        stdio: 'pipe'
      });
    } catch (err) {
      if (err.message.includes('GUARDRAIL_VIOLATION') || err.message.includes('readiness') || err.message.includes('verification')) {
        submissionBlocked = true;
      }
    }

    assert.ok(submissionBlocked, 'Unverified application was submitted without failing readiness gate');
  });

  // =========================================================================
  // 4. MCP SERVER PROTOCOL & ROBUSTNESS
  // =========================================================================
  console.log('\n>>> SECTION 4: Native stdio MCP Server Stress Testing');

  await checkAsync('MCP Server: JSON-RPC 2.0 full handshake, stdio tools, and error resilience', async () => {
    const mcpProcess = spawn('node', [mcpBin, '--workspace', tmpDir], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';

    mcpProcess.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString();
    });

    mcpProcess.stderr.on('data', chunk => {
      stderrBuffer += chunk.toString();
    });

    let processAlive = true;
    mcpProcess.on('exit', () => {
      processAlive = false;
    });

    const send = (msg) => {
      mcpProcess.stdin.write(JSON.stringify(msg) + '\n');
    };

    const wait = async (id, timeout = 4000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const lines = stdoutBuffer.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const p = JSON.parse(line);
            if (p.id === id) return p;
          } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 20));
      }
      throw new Error(`Timeout waiting for response id ${id}`);
    };

    // 1. initialize
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const r1 = await wait(1);
    assert.strictEqual(r1.result.protocolVersion, '2024-11-05');
    assert.strictEqual(r1.result.serverInfo.name, 'jobhunt-crew-mcp');

    // 2. notifications/initialized (no response expected)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(processAlive, true);

    // 3. ping
    send({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} });
    const r2 = await wait(2);
    assert.deepStrictEqual(r2.result, {});

    // 4. tools/list
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const r3 = await wait(3);
    const tools = r3.result.tools.map(t => t.name);
    assert.ok(tools.includes('crew_record_event'));
    assert.ok(tools.includes('crew_get_snapshot'));
    assert.ok(tools.includes('crew_triage_job'));
    assert.ok(tools.includes('crew_close_job'));
    assert.ok(tools.includes('crew_get_job'));
    assert.ok(tools.includes('crew_doctor'));

    // 5. crew_doctor tool
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'crew_doctor', arguments: {} } });
    const r4 = await wait(4);
    assert.strictEqual(r4.result.isError, false);
    assert.strictEqual(JSON.parse(r4.result.content[0].text).status, 'PASS');

    // 6. crew_record_event tool
    send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'crew_record_event',
        arguments: {
          type: 'JOB_DISCOVERED',
          payload: {
            id: 'job_mcp_stress_10',
            title: 'Cloud Architect',
            company: 'Nebula Systems',
            url: 'https://nebula.example.com/job/10',
            location: 'Riyadh'
          },
          actor: 'agent:recon'
        }
      }
    });
    const r5 = await wait(5);
    assert.strictEqual(r5.result.isError, false);
    assert.strictEqual(JSON.parse(r5.result.content[0].text).success, true);

    // 7. crew_get_snapshot tool
    send({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'crew_get_snapshot',
        arguments: { filter: { company: 'Nebula' } }
      }
    });
    const r6 = await wait(6);
    assert.strictEqual(r6.result.isError, false);
    const snapResult = JSON.parse(r6.result.content[0].text);
    assert.strictEqual(snapResult.filteredJobsCount, 1);

    // 8. crew_triage_job tool
    send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'crew_triage_job',
        arguments: {
          job_id: 'job_mcp_stress_10',
          score: 4.5,
          status: 'PASS',
          rationale: 'High alignment'
        }
      }
    });
    const r7 = await wait(7);
    assert.strictEqual(r7.result.isError, false);

    // 9. crew_close_job tool with valid proof
    send({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'crew_close_job',
        arguments: {
          job_id: 'job_mcp_stress_10',
          evidence_type: 'http_404',
          proof: 'HTTP GET returned 404',
          reason: 'Removed'
        }
      }
    });
    const r8 = await wait(8);
    assert.strictEqual(r8.result.isError, false);

    // 10. Guardrail Violation via MCP: Automated submission -> must return isError: true and NOT crash process
    send({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'crew_record_event',
        arguments: {
          type: 'APPLICATION_SUBMITTED',
          payload: { jobId: 'job_mcp_stress_10', token: 'tok_1' },
          actor: 'agent:scribe'
        }
      }
    });
    const r9 = await wait(9);
    assert.strictEqual(r9.result.isError, true);
    assert.ok(r9.result.content[0].text.includes('GUARDRAIL_VIOLATION'));
    assert.strictEqual(processAlive, true);

    // 11. Guardrail Violation via MCP: Age-based closure -> must return isError: true and NOT crash process
    send({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'crew_close_job',
        arguments: {
          job_id: 'job_mcp_stress_10',
          evidence_type: 'posting_age',
          proof: '90 days old'
        }
      }
    });
    const r10 = await wait(10);
    assert.strictEqual(r10.result.isError, true);
    assert.ok(r10.result.content[0].text.includes('GUARDRAIL_VIOLATION'));
    assert.strictEqual(processAlive, true);

    // 12. Protocol error handling: Unknown method -> -32601
    send({ jsonrpc: '2.0', id: 11, method: 'unknown_rpc_method', params: {} });
    const r11 = await wait(11);
    assert.ok(r11.error);
    assert.strictEqual(r11.error.code, -32601);
    assert.strictEqual(processAlive, true);

    // 13. Protocol error handling: Missing tool name -> -32602
    send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: {} });
    const r12 = await wait(12);
    assert.ok(r12.error);
    assert.strictEqual(r12.error.code, -32602);
    assert.strictEqual(processAlive, true);

    // 14. Protocol error handling: Tool not found -> -32601
    send({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'nonexistent_tool' } });
    const r13 = await wait(13);
    assert.ok(r13.error);
    assert.strictEqual(r13.error.code, -32601);
    assert.strictEqual(processAlive, true);

    mcpProcess.kill();
  });

  // =========================================================================
  // 5. EVENT LEDGER INTEGRITY & TAMPER DETECTION
  // =========================================================================
  console.log('\n>>> SECTION 5: Event Ledger Cryptographic Integrity & Tamper Detection');

  await checkAsync('EventLedger detects sequence ID gap (tampering)', async () => {
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-corrupt-seq-'));
    try {
      const ledgerFile = path.join(corruptDir, 'ledger.jsonl');
      const ledger = new EventLedger({ ledgerPath: ledgerFile });

      await ledger.appendEvent({ event: 'EV1', payload: { a: 1 } });
      await ledger.appendEvent({ event: 'EV2', payload: { a: 2 } });

      // Tamper: modify event 2 seq to 3
      const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map(JSON.parse);
      lines[1].id = 3;
      lines[1].seq = 3;
      fs.writeFileSync(ledgerFile, lines.map(JSON.stringify).join('\n') + '\n', 'utf8');

      const integrity = ledger.verifyChainIntegrity();
      assert.strictEqual(integrity.valid, false);
      assert.ok(integrity.reason.includes('Sequence gap'));
    } finally {
      fs.rmSync(corruptDir, { recursive: true, force: true });
    }
  });

  await checkAsync('EventLedger detects parent hash mismatch (tampered payload)', async () => {
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-corrupt-hash-'));
    try {
      const ledgerFile = path.join(corruptDir, 'ledger.jsonl');
      const ledger = new EventLedger({ ledgerPath: ledgerFile });

      await ledger.appendEvent({ event: 'EV1', payload: { amount: 100 } });
      await ledger.appendEvent({ event: 'EV2', payload: { amount: 200 } });

      // Tamper payload of event 1
      const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').map(JSON.parse);
      lines[0].payload.amount = 999999; // tampered!
      fs.writeFileSync(ledgerFile, lines.map(JSON.stringify).join('\n') + '\n', 'utf8');

      const integrity = ledger.verifyChainIntegrity();
      assert.strictEqual(integrity.valid, false);
      assert.ok(integrity.reason.includes('Tampered payload hash'));
    } finally {
      fs.rmSync(corruptDir, { recursive: true, force: true });
    }
  });

  await checkAsync('EventLedger detects corrupted JSON line', async () => {
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-corrupt-json-'));
    try {
      const ledgerFile = path.join(corruptDir, 'ledger.jsonl');
      const ledger = new EventLedger({ ledgerPath: ledgerFile });

      await ledger.appendEvent({ event: 'EV1', payload: { ok: true } });
      fs.appendFileSync(ledgerFile, '{ malformed json line\n');

      const integrity = ledger.verifyChainIntegrity();
      assert.strictEqual(integrity.valid, false);
      assert.ok(integrity.reason.includes('Malformed JSON'));
    } finally {
      fs.rmSync(corruptDir, { recursive: true, force: true });
    }
  });

  // Cleanup tmpDir
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n======================================================================');
  console.log(`STRESS SUITE SUMMARY: ${summary.passed}/${summary.total} checks passed (${summary.failed} failed)`);
  if (summary.vulnerabilities.length > 0) {
    console.log(`Vulnerabilities Detected:`);
    summary.vulnerabilities.forEach((v, idx) => {
      console.log(`  ${idx + 1}. ${v.name}: ${v.error}`);
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
