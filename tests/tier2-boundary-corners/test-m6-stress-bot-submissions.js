'use strict';

/**
 * JobHunt Crew — M6 Adversarial Bot Submission Concurrency Stress Harness
 * Empirically stress-tests CommandCenterServer and GuardrailEngine under heavy concurrent load.
 * Verifies that automated agents (agent:*) and non-human actors can NEVER submit applications.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CommandCenterServer } = require('../../lib/command-center/server');
const { EventLedger } = require('../../lib/ledger/ledger');
const { GuardrailEngine } = require('../../lib/guardrails/engine');

const TEST_SECRET_TOKEN = 'stress_secret_token_1234567890abcdef';

function makeRawRequest({ port, path: reqPath, method, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method: method || 'GET',
      headers: {
        'Host': `127.0.0.1:${port}`,
        ...headers
      }
    };

    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function run() {
  console.log('[STRESS-HARNESS] Starting M6 Bot Submission Concurrency Challenge...');
  const tempWorkspace = path.join(__dirname, '..', '..', '.tmp-stress-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(tempWorkspace, { recursive: true });

  const ledger = new EventLedger({ workspaceDir: tempWorkspace });
  
  // Seed an initial job and ready package
  await ledger.appendEvent({
    event: 'JOB_DISCOVERED',
    actor: 'system',
    payload: {
      id: 'job_stress_target_001',
      title: 'Senior Distributed Systems Engineer',
      company: 'HighTech Industries',
      url: 'https://example.com/jobs/stress-001'
    }
  });

  await ledger.appendEvent({
    event: 'PACKAGE_MARKED_READY',
    actor: 'system',
    payload: {
      jobId: 'job_stress_target_001',
      claimVerification: { passed: true, violations: [] },
      reviewPanel: { verdict: 'APPROVE' }
    }
  });

  const server = new CommandCenterServer({
    workspaceDir: tempWorkspace,
    port: 0, // dynamic port
    token: TEST_SECRET_TOKEN,
    host: '127.0.0.1'
  });

  await server.start();
  const serverPort = server.port;
  console.log(`[STRESS-HARNESS] CommandCenterServer listening on 127.0.0.1:${serverPort}`);

  try {
    // -------------------------------------------------------------------------
    // BATTERY 1: 125 Heavy Mixed In-Flight Concurrent Requests
    // -------------------------------------------------------------------------
    console.log('[STRESS-HARNESS] Running Battery 1: 125 simultaneous mixed in-flight requests...');
    const illegalAgents = [
      'agent:recon',
      'agent:scribe',
      'agent:marshal',
      'agent:warden',
      'agent:navigator',
      'agent:herald',
      'bot:crawler',
      'bot:auto-apply',
      'system',
      'unauthorized-worker'
    ];

    const requests = [];

    // 1. 50 illegal bot submission attempts with various actors and tokens
    for (let i = 0; i < 50; i++) {
      const actor = illegalAgents[i % illegalAgents.length];
      const payload = {
        type: 'SUBMIT',
        jobId: 'job_stress_target_001',
        actor: actor,
        token: `fake-token-${i}`
      };

      requests.push(
        makeRawRequest({
          port: serverPort,
          path: '/api/decision',
          method: 'POST',
          headers: {
            'X-Session-Token': TEST_SECRET_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }).then(res => ({ kind: 'bot-submit', index: i, actor, res }))
      );
    }

    // 2. 25 valid human claim confirmations
    for (let i = 0; i < 25; i++) {
      const payload = {
        type: 'confirm_claim',
        claimId: `C-STRESS-${i}`,
        actor: 'human:alice',
        evidence: `Verified evidence ${i}`
      };

      requests.push(
        makeRawRequest({
          port: serverPort,
          path: '/api/decision',
          method: 'POST',
          headers: {
            'X-Session-Token': TEST_SECRET_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }).then(res => ({ kind: 'human-confirm', index: i, res }))
      );
    }

    // 3. 25 valid human submissions with verified token
    for (let i = 0; i < 25; i++) {
      const payload = {
        type: 'SUBMIT',
        jobId: 'job_stress_target_001',
        actor: 'human:bob',
        token: `human-auth-token-${i}`
      };

      requests.push(
        makeRawRequest({
          port: serverPort,
          path: '/api/decision',
          method: 'POST',
          headers: {
            'X-Session-Token': TEST_SECRET_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        }).then(res => ({ kind: 'human-submit', index: i, res }))
      );
    }

    // 4. 25 concurrent snapshot and jobs reads
    for (let i = 0; i < 25; i++) {
      const endpoint = i % 2 === 0 ? '/api/snapshot' : '/api/jobs';
      requests.push(
        makeRawRequest({
          port: serverPort,
          path: endpoint,
          method: 'GET',
          headers: {
            'X-Session-Token': TEST_SECRET_TOKEN
          }
        }).then(res => ({ kind: 'read', index: i, res }))
      );
    }

    const results = await Promise.all(requests);
    console.log(`[STRESS-HARNESS] Received responses for all ${results.length} concurrent requests.`);

    let botSubmitsBlocked = 0;
    let humanConfirmsPassed = 0;
    let humanSubmitsPassed = 0;
    let readsPassed = 0;

    for (const item of results) {
      if (item.kind === 'bot-submit') {
        if (item.res.statusCode === 400) {
          const body = JSON.parse(item.res.body);
          if (body.error && body.error.includes('Guardrail Violation')) {
            botSubmitsBlocked++;
          } else {
            throw new Error(`Bot submit ${item.index} rejected with 400 but unexpected error: ${item.res.body}`);
          }
        } else {
          throw new Error(`CRITICAL VULNERABILITY: Bot submit ${item.index} by ${item.actor} was NOT blocked! Status: ${item.res.statusCode}, Body: ${item.res.body}`);
        }
      } else if (item.kind === 'human-confirm') {
        if (item.res.statusCode === 200) {
          humanConfirmsPassed++;
        } else {
          throw new Error(`Human confirm ${item.index} failed with status: ${item.res.statusCode}`);
        }
      } else if (item.kind === 'human-submit') {
        if (item.res.statusCode === 200) {
          humanSubmitsPassed++;
        } else {
          throw new Error(`Human submit ${item.index} failed with status: ${item.res.statusCode}`);
        }
      } else if (item.kind === 'read') {
        if (item.res.statusCode === 200) {
          readsPassed++;
        } else {
          throw new Error(`Read ${item.index} failed with status: ${item.res.statusCode}`);
        }
      }
    }

    console.log(`[STRESS-HARNESS] Battery 1 results:
      - Bot Submissions Blocked: ${botSubmitsBlocked} / 50 (100% blocked)
      - Human Confirmations Passed: ${humanConfirmsPassed} / 25
      - Human Submissions Passed: ${humanSubmitsPassed} / 25
      - Concurrent Reads Passed: ${readsPassed} / 25`);

    if (botSubmitsBlocked !== 50) {
      throw new Error(`Expected exactly 50 blocked bot submissions, got ${botSubmitsBlocked}`);
    }

    // -------------------------------------------------------------------------
    // BATTERY 2: Evasion & Spoofing Vectors Under Concurrency
    // -------------------------------------------------------------------------
    console.log('[STRESS-HARNESS] Running Battery 2: Evasion and spoofing vectors under concurrency...');
    const evasionRequests = [];

    const evasionVectors = [
      { desc: 'Actor whitespace spoofing', payload: { type: 'SUBMIT', jobId: 'job_01', actor: '  agent:recon  ', token: 'tok' } },
      { desc: 'Actor humanoid prefix spoofing', payload: { type: 'SUBMIT', jobId: 'job_01', actor: 'humanoid', token: 'tok' } },
      { desc: 'Actor human-bot hyphen spoofing', payload: { type: 'SUBMIT', jobId: 'job_01', actor: 'human-bot', token: 'tok' } },
      { desc: 'Actor lowercase human with empty token', payload: { type: 'SUBMIT', jobId: 'job_01', actor: 'human', token: '' } },
      { desc: 'Actor human:alice with whitespace token', payload: { type: 'SUBMIT', jobId: 'job_01', actor: 'human:alice', token: '   ' } },
      { desc: 'Actor human:alice with null token', payload: { type: 'SUBMIT', jobId: 'job_01', actor: 'human:alice', token: null } },
      { desc: 'Actor null with empty token', payload: { type: 'SUBMIT', jobId: 'job_01', actor: null, token: '' } },
      { desc: 'Actor empty string with empty token', payload: { type: 'SUBMIT', jobId: 'job_01', actor: '', token: '' } },
      { desc: 'Agent with valid token', payload: { type: 'SUBMIT', jobId: 'job_01', actor: 'agent:recon', token: 'super-secret-token' } },
      { desc: 'Action lowercase submit by agent', payload: { type: 'submit', jobId: 'job_01', actor: 'agent:recon', token: 'tok' } },
      { desc: 'Action application_submitted by agent', payload: { type: 'application_submitted', jobId: 'job_01', actor: 'agent:recon', token: 'tok' } },
      { desc: 'Action mark_submitted by agent', payload: { type: 'mark_submitted', jobId: 'job_01', actor: 'agent:recon', token: 'tok' } },
      { desc: 'Action mixed case SuBmIt by agent', payload: { type: 'SuBmIt', jobId: 'job_01', actor: 'agent:recon', token: 'tok' } }
    ];

    // Fire 4 waves of the 12 evasion vectors concurrently = 48 requests
    for (let wave = 0; wave < 4; wave++) {
      for (let i = 0; i < evasionVectors.length; i++) {
        const v = evasionVectors[i];
        evasionRequests.push(
          makeRawRequest({
            port: serverPort,
            path: '/api/decision',
            method: 'POST',
            headers: {
              'X-Session-Token': TEST_SECRET_TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(v.payload)
          }).then(res => ({ desc: v.desc, wave, res }))
        );
      }
    }

    const evasionResults = await Promise.all(evasionRequests);
    let evasionBlocked = 0;
    for (const er of evasionResults) {
      if (er.res.statusCode === 400) {
        evasionBlocked++;
      } else {
        throw new Error(`CRITICAL VULNERABILITY: Evasion test "${er.desc}" (wave ${er.wave}) was NOT blocked! Status: ${er.res.statusCode}, Body: ${er.res.body}`);
      }
    }

    console.log(`[STRESS-HARNESS] Battery 2 results: ${evasionBlocked} / ${evasionResults.length} evasion attempts blocked (100%).`);

    // -------------------------------------------------------------------------
    // BATTERY 3: Forensic Inspection of Ledger and Snapshot State
    // -------------------------------------------------------------------------
    console.log('[STRESS-HARNESS] Running Battery 3: Forensic verification of ledger and snapshot...');
    
    // 1. Verify ledger hash chain integrity
    const integrityCheck = ledger.verifyChainIntegrity();
    if (!integrityCheck.valid) {
      throw new Error(`Ledger hash chain integrity failed: ${JSON.stringify(integrityCheck)}`);
    }
    console.log(`[STRESS-HARNESS] Ledger chain integrity verified: ${integrityCheck.count} events valid.`);

    // 2. Read every raw line from ledger.jsonl
    const ledgerFile = ledger.ledgerPath;
    const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
    let submissionEvents = 0;

    for (let idx = 0; idx < lines.length; idx++) {
      const ev = JSON.parse(lines[idx]);
      if (ev.event === 'APPLICATION_SUBMITTED') {
        submissionEvents++;
        const actor = ev.actor;
        if (!actor || !actor.startsWith('human')) {
          throw new Error(`CORRUPTED LEDGER: Event ${ev.id} is APPLICATION_SUBMITTED with illegal non-human actor "${actor}"!`);
        }
        if (!ev.payload.token || typeof ev.payload.token !== 'string' || ev.payload.token.trim().length === 0) {
          throw new Error(`CORRUPTED LEDGER: Event ${ev.id} is APPLICATION_SUBMITTED without valid non-empty token!`);
        }
      }
    }
    console.log(`[STRESS-HARNESS] Ledger audit passed: exactly ${submissionEvents} APPLICATION_SUBMITTED events, ALL verified human.`);

    // 3. Verify snapshot endpoint
    const snapRes = await makeRawRequest({
      port: serverPort,
      path: '/api/snapshot',
      headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
    });
    if (snapRes.statusCode !== 200) {
      throw new Error(`Snapshot fetch failed with status: ${snapRes.statusCode}`);
    }
    const snap = JSON.parse(snapRes.body);
    if (!snap.jobs || !snap.jobs['job_stress_target_001']) {
      throw new Error('Target job missing in snapshot');
    }
    console.log('[STRESS-HARNESS] Snapshot verified and consistent.');

    console.log('[STRESS-HARNESS] ALL EMPIRICAL CHALLENGES PASSED! 0 bot submissions leaked, 100% blocked under concurrency.');
    return { success: true };
  } finally {
    await server.stop();
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch (_) {}
  }
}

run().then(res => {
  console.log('[STRESS-HARNESS] COMPLETE: Process exit 0.');
  process.exit(0);
}).catch(err => {
  console.error('[STRESS-HARNESS] FAILED:', err);
  process.exit(1);
});
