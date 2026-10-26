'use strict';
/**
 * Tier 1: Feature Coverage - Command Center Server & REST API Full Matrix
 * Verifies loopback binding, polymorphic authentication variations,
 * all REST endpoints, guardrail rejections, static asset path traversal protection,
 * and host header rebinding protection.
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

const suite = new TestSuite('Tier 1: Command Center Server & REST API Full Matrix');

const TEST_TOKEN = 'matrix-test-token-778899';
let server;
let baseUrl;
let tempWorkspace;

suite.test('Initialize temporary workspace and start server on dynamic port', async assert => {
  tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-server-matrix-'));
  fs.mkdirSync(path.join(tempWorkspace, '.crew'), { recursive: true });

  // Seed sample dossier.json with a CONFIRM claim
  const sampleDossier = {
    candidate: { name: 'Dr. Morgan Vance', email: 'm.vance@example.org' },
    employers: [{ id: 'emp_1', name: 'CloudCorp', startYear: 2021, isCurrent: true, title: 'Lead Architect' }],
    claims: [
      { id: 'C-01', employerId: 'emp_1', category: 'architecture', text: 'Architected distributed event log', status: 'CONFIRM', clarificationPrompt: 'Verify concurrency limit' }
    ]
  };
  fs.writeFileSync(path.join(tempWorkspace, 'dossier.json'), JSON.stringify(sampleDossier, null, 2), 'utf8');

  server = new CommandCenterServer({
    workspaceDir: tempWorkspace,
    port: 0,
    token: TEST_TOKEN
  });

  const info = await server.start();
  baseUrl = server.getBaseUrl();

  assert.ok(baseUrl.startsWith('http://127.0.0.1:'), 'Must bind to 127.0.0.1 loopback');
  assert.equal(info.token, TEST_TOKEN, 'Must match token');
});

suite.test('Authentication variations: 401 on missing, 401 on invalid', async assert => {
  // Missing
  const res1 = await makeRequest(`${baseUrl}/api/health`);
  assert.equal(res1.statusCode, 401, 'Missing token must return 401');

  // Wrong Bearer
  const res2 = await makeRequest(`${baseUrl}/api/health`, {
    headers: { 'Authorization': 'Bearer wrong-pass' }
  });
  assert.equal(res2.statusCode, 401, 'Invalid Bearer token must return 401');

  // Wrong X-Session-Token
  const res3 = await makeRequest(`${baseUrl}/api/health`, {
    headers: { 'X-Session-Token': 'wrong-pass' }
  });
  assert.equal(res3.statusCode, 401, 'Invalid X-Session-Token must return 401');

  // Wrong query parameter
  const res4 = await makeRequest(`${baseUrl}/api/health?token=bad-token`);
  assert.equal(res4.statusCode, 401, 'Invalid query token must return 401');
});

suite.test('Authentication variations: 200 on all 4 valid channels', async assert => {
  // 1. Authorization: Bearer <token>
  const resBearer = await makeRequest(`${baseUrl}/api/health`, {
    headers: { 'Authorization': `Bearer ${TEST_TOKEN}` }
  });
  assert.equal(resBearer.statusCode, 200, 'Bearer auth must succeed');

  // 2. X-Session-Token header
  const resHeader = await makeRequest(`${baseUrl}/api/health`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.equal(resHeader.statusCode, 200, 'X-Session-Token auth must succeed');

  // 3. Query parameter ?token=<token>
  const resQuery = await makeRequest(`${baseUrl}/api/health?token=${TEST_TOKEN}`);
  assert.equal(resQuery.statusCode, 200, 'Query param auth must succeed');

  // 4. Session Cookie crew_session=<token>
  const resCookie = await makeRequest(`${baseUrl}/api/health`, {
    headers: { 'Cookie': `crew_session=${TEST_TOKEN}` }
  });
  assert.equal(resCookie.statusCode, 200, 'Cookie auth must succeed');
});

suite.test('Host header validation blocks external host rebinding', async assert => {
  const res = await makeRequest(`${baseUrl}/api/health`, {
    headers: {
      'Host': 'attacker-site.com',
      'X-Session-Token': TEST_TOKEN
    }
  });
  assert.equal(res.statusCode, 403, 'External Host header must be rejected with 403');
});

suite.test('GET /api/health returns system runtime status and storage metrics', async assert => {
  const res = await makeRequest(`${baseUrl}/api/health`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.status, 'ok');
  assert.equal(data.server, 'jobhunt-crew-command-center');
  assert.ok(data.storage !== undefined, 'Must include storage object');
  assert.ok(typeof data.uptimeSeconds === 'number', 'Must include uptimeSeconds');
});

suite.test('POST /api/decision records domain events and re-indexes snapshot', async assert => {
  // 1. Shortlist role
  const res1 = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    headers: { 'X-Session-Token': TEST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'shortlist', jobId: 'job_test_01' })
  });
  assert.equal(res1.statusCode, 200);
  const data1 = JSON.parse(res1.body);
  assert.equal(data1.status, 'recorded');
  assert.equal(data1.eventType, 'JOB_SELECTED');

  // 2. Confirm claim
  const res2 = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    headers: { 'X-Session-Token': TEST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'confirm_claim', claimId: 'C-01', evidence: 'Audited by candidate' })
  });
  assert.equal(res2.statusCode, 200);

  // Check dossier was updated to VERIFIED
  const rawDossier = fs.readFileSync(path.join(tempWorkspace, 'dossier.json'), 'utf8');
  const d = JSON.parse(rawDossier);
  assert.equal(d.claims[0].status, 'VERIFIED', 'Dossier claim must be updated to VERIFIED');
});

suite.test('GET /api/snapshot returns valid state object', async assert => {
  const res = await makeRequest(`${baseUrl}/api/snapshot`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.equal(res.statusCode, 200);
  const snap = JSON.parse(res.body);
  assert.equal(snap.version, 1);
  assert.ok(snap.lastEventId > 0, 'LastEventId should be incremented');
});

suite.test('GET /api/decisions returns pending counts and lists', async assert => {
  const res = await makeRequest(`${baseUrl}/api/decisions`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.equal(res.statusCode, 200);
  const dec = JSON.parse(res.body);
  assert.ok(typeof dec.totalPending === 'number');
  assert.ok(dec.counts !== undefined);
  assert.ok(dec.decisions !== undefined);
});

suite.test('GET /api/jobs supports filtering and pagination', async assert => {
  const res = await makeRequest(`${baseUrl}/api/jobs?limit=10&offset=0`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.ok(Array.isArray(data.jobs));
  assert.equal(data.limit, 10);
});

suite.test('GET /api/runs returns event history from ledger', async assert => {
  const res = await makeRequest(`${baseUrl}/api/runs?limit=50`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.equal(res.statusCode, 200);
  const data = JSON.parse(res.body);
  assert.ok(Array.isArray(data.events));
  assert.ok(data.events.length >= 2, 'Should have at least 2 events recorded');
});

suite.test('Malformed request handling: bad JSON returns HTTP 400', async assert => {
  const res = await makeRequest(`${baseUrl}/api/decision`, {
    method: 'POST',
    headers: { 'X-Session-Token': TEST_TOKEN, 'Content-Type': 'application/json' },
    body: '{ bad-json '
  });
  assert.equal(res.statusCode, 400);
  const err = JSON.parse(res.body);
  assert.ok(err.error.includes('Malformed JSON'));
});

suite.test('Static file serving and path traversal defense', async assert => {
  // Normal asset
  const resNormal = await makeRequest(`${baseUrl}/index.html`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.equal(resNormal.statusCode, 200);
  assert.ok(resNormal.body.includes('JobHunt Crew'));

  // Path traversal attempts
  const resTraverse1 = await makeRequest(`${baseUrl}/../../package.json`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.ok([403, 404].includes(resTraverse1.statusCode), 'Path traversal must be forbidden or not found');

  const resTraverse2 = await makeRequest(`${baseUrl}/%2e%2e%2fpackage.json`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.ok([403, 404].includes(resTraverse2.statusCode), 'Encoded traversal must be forbidden or not found');

  const resNullByte = await makeRequest(`${baseUrl}/index.html%00.png`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.ok([403, 404].includes(resNullByte.statusCode), 'Null-byte poisoned path must be forbidden or not found');
});

suite.test('Clean-Room Invariant: Served web UI contains all 5 modern views and strictly NO Today tab/view or label', async assert => {
  const res = await makeRequest(`${baseUrl}/index.html`, {
    headers: { 'X-Session-Token': TEST_TOKEN }
  });
  assert.equal(res.statusCode, 200);

  // STRICT PROHIBITION: Zero "Today" tab or label
  assert.equal(/\bToday\b/i.test(res.body), false, 'Clean-room violation: Served UI must not contain any Today tab, view, or label');

  // APPROVED 5-VIEW ARCHITECTURE
  assert.ok(res.body.includes('decision-queue'), 'Must contain decision-queue view');
  assert.ok(res.body.includes('pipeline-board'), 'Must contain pipeline-board view');
  assert.ok(res.body.includes('workbench'), 'Must contain workbench view');
  assert.ok(res.body.includes('evidence-map'), 'Must contain evidence-map view');
  assert.ok(res.body.includes('runs-timeline'), 'Must contain runs-timeline view');
});

suite.test('Graceful server shutdown', async assert => {
  await server.stop();
  if (tempWorkspace && fs.existsSync(tempWorkspace)) {
    try { fs.rmSync(tempWorkspace, { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(true, 'Server closed cleanly');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
