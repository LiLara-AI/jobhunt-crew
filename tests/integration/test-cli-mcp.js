'use strict';
/**
 * Integration Test: Extended CLI Router & Native stdio MCP Server
 * Verifies bin/crew.js and lib/mcp/server.js end-to-end.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { TestSuite } = require('../helpers/test-harness');

const suite = new TestSuite('Integration: Extended CLI & Native MCP Server');
const crewBin = path.resolve(__dirname, '../../bin/crew.js');
const mcpBin = path.resolve(__dirname, '../../bin/crew-mcp.js');

let tmpDir;

suite.test('Set up isolated temporary directory for CLI/MCP tests', assert => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-cli-mcp-test-'));
  assert.ok(fs.existsSync(tmpDir));
});

suite.test('CLI init creates runtime directory and initial ledger files', assert => {
  const out = execSync(`node "${crewBin}" init --workspace "${tmpDir}"`, { encoding: 'utf8' });
  assert.ok(out.includes('[INIT]'));
  assert.ok(fs.existsSync(path.join(tmpDir, '.crew', 'ledger.jsonl')));
  assert.ok(fs.existsSync(path.join(tmpDir, '.crew', 'snapshot.json')));
  assert.ok(fs.existsSync(path.join(tmpDir, '.pii-denylist')));
});

suite.test('CLI doctor reports PASSED on initialized workspace', assert => {
  const out = execSync(`node "${crewBin}" doctor --workspace "${tmpDir}"`, { encoding: 'utf8' });
  assert.ok(out.includes('PASSED'));
});

suite.test('CLI job add discovers and deduplicates vacancies', assert => {
  const addCmd = `node "${crewBin}" job add --url "https://boards.greenhouse.io/apex/jobs/101?utm_source=li" --title "Platform Engineer" --company "Apex" --location "Riyadh" --source "web" --workspace "${tmpDir}"`;
  const out1 = execSync(addCmd, { encoding: 'utf8' });
  assert.ok(out1.includes('JOB_DISCOVERED'));

  // Adding same role again should detect duplicate
  const out2 = execSync(addCmd, { encoding: 'utf8' });
  assert.ok(out2.includes('already exists') || out2.includes('collapsed'));
});

suite.test('CLI job triage assigns score and updates status', assert => {
  // First extract the job ID from snapshot
  const snapshot = JSON.parse(fs.readFileSync(path.join(tmpDir, '.crew', 'snapshot.json'), 'utf8'));
  const jobs = Object.values(snapshot.jobs || {});
  assert.ok(jobs.length > 0);
  const jobId = jobs[0].id;

  const triageCmd = `node "${crewBin}" job triage --id "${jobId}" --score 4.8 --status "PASS" --rationale "Strong match" --workspace "${tmpDir}"`;
  const out = execSync(triageCmd, { encoding: 'utf8' });
  assert.ok(out.includes('JOB_TRIAGED'));

  const updatedSnap = JSON.parse(fs.readFileSync(path.join(tmpDir, '.crew', 'snapshot.json'), 'utf8'));
  assert.equal(updatedSnap.jobs[jobId].score, 4.8);
  assert.equal(updatedSnap.jobs[jobId].status, 'PASS');
});

suite.test('CLI job close enforces evidence guardrail and blocks age penalty', assert => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(tmpDir, '.crew', 'snapshot.json'), 'utf8'));
  const jobId = Object.keys(snapshot.jobs)[0];

  // Age closure must fail
  assert.throws(() => {
    execSync(`node "${crewBin}" job close --id "${jobId}" --reason "Older than 60 days" --evidence "posting_age" --workspace "${tmpDir}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
  }, /GUARDRAIL_VIOLATION/);

  // Valid evidence closure must succeed
  const closeCmd = `node "${crewBin}" job close --id "${jobId}" --reason "Job removed" --evidence "http_404" --proof "404 Not Found" --workspace "${tmpDir}"`;
  const out = execSync(closeCmd, { encoding: 'utf8' });
  assert.ok(out.includes('JOB_CLOSED'));
});

suite.test('CLI job submit blocks agent actors and requires human token', assert => {
  // Add a new job for submission
  execSync(`node "${crewBin}" job add --url "https://jobs.lever.co/apex/sub-001" --title "SRE" --company "Apex" --location "Riyadh" --workspace "${tmpDir}"`, { encoding: 'utf8' });
  const snapshot = JSON.parse(fs.readFileSync(path.join(tmpDir, '.crew', 'snapshot.json'), 'utf8'));
  const subJob = Object.values(snapshot.jobs).find(j => j.title === 'SRE');
  assert.ok(subJob);

  // Agent submit must fail
  assert.throws(() => {
    execSync(`node "${crewBin}" job submit --id "${subJob.id}" --token "tok_123" --actor "agent:scribe" --workspace "${tmpDir}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
  }, /GUARDRAIL_VIOLATION/);

  // Human submit of unverified job must fail readiness gate
  assert.throws(() => {
    execSync(`node "${crewBin}" job submit --id "${subJob.id}" --token "tok_123" --actor "human:alice" --workspace "${tmpDir}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
  }, /GUARDRAIL_VIOLATION/);

  // Mark package ready with passed verification and review approval
  execSync(`node "${crewBin}" ledger append --event PACKAGE_MARKED_READY --payload "{\\"jobId\\":\\"${subJob.id}\\",\\"claimVerification\\":{\\"passed\\":true},\\"reviewPanel\\":{\\"verdict\\":\\"APPROVE\\"}}" --actor "agent:scribe" --workspace "${tmpDir}"`, { encoding: 'utf8' });

  // Human submit of verified & ready package must succeed
  const submitCmd = `node "${crewBin}" job submit --id "${subJob.id}" --token "tok_123" --actor "human:alice" --workspace "${tmpDir}"`;
  const out = execSync(submitCmd, { encoding: 'utf8' });
  assert.ok(out.includes('APPLICATION_SUBMITTED'));
});

suite.test('CLI backup and restore round-trips state with ledger integrity verification', assert => {
  const backupFile = path.join(tmpDir, 'backup-test.json');
  const backupOut = execSync(`node "${crewBin}" backup --out "${backupFile}" --workspace "${tmpDir}"`, { encoding: 'utf8' });
  assert.ok(backupOut.includes('[BACKUP]'));
  assert.ok(fs.existsSync(backupFile));

  // Modify ledger to corrupt it
  const ledgerPath = path.join(tmpDir, '.crew', 'ledger.jsonl');
  fs.appendFileSync(ledgerPath, '{"corrupted": true}\n');

  // Restore should overwrite and re-verify
  const restoreOut = execSync(`node "${crewBin}" restore --file "${backupFile}" --workspace "${tmpDir}"`, { encoding: 'utf8' });
  assert.ok(restoreOut.includes('[RESTORE]'));
  assert.ok(restoreOut.includes('Ledger verified'));
});

suite.test('CLI claim verify correctly validates clean drafts and detects fabrications', assert => {
  const morganPath = path.join(__dirname, '..', 'fixtures', 'dossiers', 'morgan-vance.json');

  // 1. Clean draft -> exits 0
  const cleanCmd = `node "${crewBin}" claim verify --dossier "${morganPath}" --draft "Reduced core event-processing p99 latency from 180ms to 42ms through Kafka topic repartitioning." --json --workspace "${tmpDir}"`;
  const cleanOut = execSync(cleanCmd, { encoding: 'utf8' });
  const cleanResult = JSON.parse(cleanOut);
  assert.equal(cleanResult.passed, true, 'Clean draft must pass claim verification');
  assert.equal(cleanResult.summary.totalViolations, 0);

  // 2. Fabricated draft -> exits 1 with violations
  let failedAsExpected = false;
  try {
    execSync(`node "${crewBin}" claim verify --dossier "${morganPath}" --draft "Reduced latency down to 10ms with Terraform." --json --workspace "${tmpDir}"`, {
      encoding: 'utf8',
      stdio: 'pipe'
    });
  } catch (err) {
    failedAsExpected = true;
    assert.equal(err.status, 1, 'Fabricated draft must cause exit code 1');
    const errResult = JSON.parse(err.stdout);
    assert.equal(errResult.passed, false);
    assert.ok(errResult.violations.length >= 2);
  }
  assert.ok(failedAsExpected, 'Fabricated draft must fail and throw non-zero exit');
});

suite.test('Native stdio MCP Server implements JSON-RPC 2.0 lifecycle and exposes all tools', async assert => {
  const mcpProcess = spawn('node', [mcpBin, '--workspace', tmpDir], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdoutData = '';
  mcpProcess.stdout.on('data', chunk => {
    stdoutData += chunk.toString();
  });

  const sendRequest = (req) => {
    mcpProcess.stdin.write(JSON.stringify(req) + '\n');
  };

  const waitForResponse = async (id, timeoutMs = 4000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const lines = stdoutData.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === id) return parsed;
        } catch (_) {}
      }
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`Timeout waiting for response id ${id}`);
  };

  // 1. initialize
  sendRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const initRes = await waitForResponse(1);
  assert.equal(initRes.result.protocolVersion, '2024-11-05');
  assert.equal(initRes.result.serverInfo.name, 'jobhunt-crew-mcp');

  // 2. tools/list
  sendRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listRes = await waitForResponse(2);
  const toolNames = listRes.result.tools.map(t => t.name);
  assert.ok(toolNames.includes('crew_record_event'));
  assert.ok(toolNames.includes('crew_get_snapshot'));
  assert.ok(toolNames.includes('crew_triage_job'));
  assert.ok(toolNames.includes('crew_close_job'));
  assert.ok(toolNames.includes('crew_get_job'));
  assert.ok(toolNames.includes('crew_doctor'));
  assert.ok(toolNames.includes('crew_verify_draft'));
  assert.ok(toolNames.includes('crew_editorial_rules'));

  // 3. crew_doctor
  sendRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'crew_doctor', arguments: {} }
  });
  const docRes = await waitForResponse(3);
  assert.equal(docRes.result.isError, false);
  const docText = JSON.parse(docRes.result.content[0].text);
  assert.equal(docText.status, 'PASS');

  // 4. crew_verify_draft
  const morganPath = path.join(__dirname, '..', 'fixtures', 'dossiers', 'morgan-vance.json');
  sendRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'crew_verify_draft',
      arguments: {
        draft_path: 'Reduced core event-processing p99 latency from 180ms to 42ms through Kafka topic repartitioning.',
        dossier_path: morganPath
      }
    }
  });
  const verifyRes = await waitForResponse(4);
  assert.equal(verifyRes.result.isError, false);
  const verifyContent = JSON.parse(verifyRes.result.content[0].text);
  assert.equal(verifyContent.passed, true);

  // 5. crew_editorial_rules (learn & apply)
  sendRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'crew_editorial_rules',
      arguments: {
        action: 'learn',
        rule_id: 'R_MCP_TEST',
        pattern: 'legacy_tool',
        replacement: 'modern_tool',
        rationale: 'modernize tool terminology'
      }
    }
  });
  const ruleLearnRes = await waitForResponse(5);
  assert.equal(ruleLearnRes.result.isError, false);
  const ruleLearnContent = JSON.parse(ruleLearnRes.result.content[0].text);
  assert.equal(ruleLearnContent.success, true);
  assert.equal(ruleLearnContent.rule.id, 'R_MCP_TEST');

  sendRequest({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'crew_editorial_rules',
      arguments: {
        action: 'apply',
        text: 'Engineered backend with legacy_tool.'
      }
    }
  });
  const ruleApplyRes = await waitForResponse(6);
  assert.equal(ruleApplyRes.result.isError, false);
  const ruleApplyContent = JSON.parse(ruleApplyRes.result.content[0].text);
  assert.equal(ruleApplyContent.success, true);
  assert.equal(ruleApplyContent.transformedText, 'Engineered backend with modern_tool.');

  // 7. crew_close_job with illegal age penalty -> guardrail violation returned as isError: true
  sendRequest({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'crew_close_job',
      arguments: {
        job_id: 'job_nonexistent',
        evidence_type: 'posting_age',
        proof: '100 days old'
      }
    }
  });
  const errRes = await waitForResponse(7);
  assert.equal(errRes.result.isError, true);

  mcpProcess.kill();
});

suite.test('Clean up temporary test directory', assert => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  assert.ok(true);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
