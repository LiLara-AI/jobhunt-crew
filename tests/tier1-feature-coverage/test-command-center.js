'use strict';
/**
 * Tier 1: Feature Coverage - Local Web Command Center Server & Security
 * Tests the real genuine CommandCenterServer:
 * Verifies 127.0.0.1 loopback binding, token authentication, REST decision endpoints,
 * guardrail enforcement on human submissions, and zero remote external asset dependencies in export.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const { CommandCenterServer } = require('../../lib/command-center/server');

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

const suite = new TestSuite('Tier 1: Command Center Server & Security');

const TEST_TOKEN = 'secret-crew-token-2026';
let server;
let baseUrl;
let tempWorkspace;

suite.test('Setup isolated test workspace and start genuine CommandCenterServer', async assert => {
  tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-cc-test-'));
  fs.mkdirSync(path.join(tempWorkspace, '.crew'), { recursive: true });

  server = new CommandCenterServer({
    workspaceDir: tempWorkspace,
    port: 0,
    token: TEST_TOKEN
  });

  const info = await server.start();
  baseUrl = server.getBaseUrl();

  assert.ok(baseUrl.startsWith('http://127.0.0.1:'), 'Server must bind exclusively to 127.0.0.1 loopback');
  assert.equal(info.token, TEST_TOKEN, 'Server must preserve configured session token');
  assert.ok(info.port > 0, 'Server must listen on valid ephemeral port');
});

suite.test('Requests lacking Bearer token are rejected with HTTP 401 Unauthorized', async assert => {
  const res = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    body: JSON.stringify({ type: 'shortlist', jobId: 'j100' })
  });
  assert.equal(res.statusCode, 401);
  assert.ok(res.body.includes('Unauthorized'));
});

suite.test('Requests with invalid Bearer token are rejected with HTTP 401 Unauthorized', async assert => {
  const res = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer wrong-token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: 'shortlist', jobId: 'j100' })
  });
  assert.equal(res.statusCode, 401);
  assert.ok(res.body.includes('Unauthorized'));
});

suite.test('Authorized human decisions record successfully and exactly once', async assert => {
  const decisionTypes = [
    { type: 'shortlist', payload: { jobId: 'job_42' } },
    { type: 'park', payload: { jobId: 'job_42', reason: 'timing' } },
    { type: 'confirm_claim', payload: { claimId: 'C-01', evidence: 'Verified on repo' } },
    { type: 'approve_pack', payload: { jobId: 'job_42' } },
    { type: 'mark_submitted', payload: { jobId: 'job_42', token: 'human-auth-tok' } }
  ];

  for (const dt of decisionTypes) {
    const payload = JSON.stringify({
      id: `dec_${dt.type}`,
      type: dt.type,
      token: dt.payload.token,
      ...dt.payload
    });

    const res = await makeRequest(`${baseUrl}/api/decision`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: payload
    });

    assert.equal(res.statusCode, 200, `Decision ${dt.type} must return 200 OK`);
    assert.ok(res.body.includes('recorded'), `Decision ${dt.type} response must contain 'recorded'`);
  }

  assert.equal(server.decisionsLog.length, 5, 'Server must log all 5 decisions');
});

suite.test('Human submission without authorization token is rejected by Guardrail with HTTP 400', async assert => {
  const payload = JSON.stringify({
    type: 'mark_submitted',
    jobId: 'job_99'
    // Intentionally missing token
  });

  const res = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: payload
  });

  assert.equal(res.statusCode, 400, 'Submission without human authorization token must fail with 400');
  assert.ok(res.body.includes('GUARDRAIL_VIOLATION'), 'Response must explain guardrail violation');
});

suite.test('Exported snapshot contains zero remote web dependencies (http:// or https:// external links)', async assert => {
  const res = await makeRequest(`${baseUrl}/export`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${TEST_TOKEN}` }
  });
  assert.equal(res.statusCode, 200);

  // Check no external font, cdn, script tags exist
  const externalLinkRegex = /src=["']https?:\/\/|href=["']https?:\/\//i;
  assert.equal(externalLinkRegex.test(res.body), false, 'Export must have 0 external CDN or remote web links');
  assert.ok(res.body.includes('JobHunt Crew'), 'Exported HTML must contain dashboard title');
});

suite.test('Tear down Command Center server and clean temp workspace', async assert => {
  if (server) {
    await server.stop();
  }
  if (tempWorkspace && fs.existsSync(tempWorkspace)) {
    try { fs.rmSync(tempWorkspace, { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(true);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
