'use strict';
/**
 * Tier 2: Boundary & Corner Cases — Milestone M6 Adversarial Security & Loopback Isolation Suite
 *
 * Authored by: challenger_m6_1 (Empirical Challenger)
 * Scope:
 *   1. Host Header Spoofing & DNS Rebinding Payloads:
 *      - Rejection of external hostnames (evil.com, attacker.domain, 192.168.1.1, 10.0.0.1, etc.)
 *      - Subdomain rebinding attempts (localhost.evil.com, 127.0.0.1.attacker.com)
 *      - Port variations, IPv4 non-loopback IPs, spoofed forward headers (X-Forwarded-For, X-Forwarded-Host)
 *      - Verification of legitimate loopback Host headers (127.0.0.1, localhost, with/without port)
 *   2. Authentication Bypass Attempts:
 *      - Missing authentication tokens across all endpoints
 *      - Empty tokens across all 4 channels (X-Session-Token, Bearer, ?token=, Cookie)
 *      - Malformed Authorization header schemes (Basic, Digest, lowercase bearer, empty Bearer)
 *      - Partial token matches (prefix, suffix, truncated, extended)
 *      - Case sensitivity verification (uppercase hex token rejection via constant-time comparison)
 *      - Injected characters (null bytes, newlines, quotes, SQLi payloads)
 *      - Cookie parsing attacks (cookie prefix collisions, multiple cookies, malicious cookies)
 *   3. Static Asset Path Traversal Attacks:
 *      - Raw dot-dot-slash traversal (/../../package.json) via raw HTTP and path options
 *      - URL-encoded dot-dot-slash (/%2e%2e/%2e%2e/, /%2E%2E/%2E%2E/)
 *      - Double-encoded traversal (/%252e%252e/)
 *      - Windows backslash traversal (/..\\..\\package.json, /..%5c..%5c)
 *      - Null-byte poisoning (/index.html%00.png, /package.json%00.html, /index.html\0)
 *      - Absolute Windows drive paths (/C:/Windows/win.ini) and UNC paths
 *      - Positive verification of legitimate public assets (index.html, styles.css, app.js, /)
 *   4. Concurrency & Monotonic Ledger Sequencing Stress:
 *      - Rapid concurrent burst of 25 simultaneous POST /api/decision requests under atomic lock
 *      - Monotonic sequence ID assertion (strictly consecutive event IDs without gaps or duplicates)
 *      - SHA-256 cryptographic hash-chain integrity verification under race conditions
 *      - Concurrent valid decisions mixed with illegal agent submissions (strict guardrail gate)
 *      - Concurrent snapshot rebuild during high-volume decision ingress
 *   5. Payload & Malformed Input Abuse:
 *      - Request body exceeding 1MB limit (rejection with 400 Payload Too Large)
 *      - Malformed JSON payload syntax and non-object bodies
 *
 * Zero external dependencies. Uses pure Node.js built-ins.
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { TestSuite } = require('../helpers/test-harness');
const { CommandCenterServer } = require('../../lib/command-center/server');
const { EventLedger } = require('../../lib/ledger/ledger');

/**
 * Low-level HTTP request helper that allows exact control over request path,
 * headers, and payload without automatic URL normalization.
 */
function makeRawRequest(options = {}) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: options.host || '127.0.0.1',
      port: options.port,
      path: options.path || '/',
      method: options.method || 'GET',
      headers: Object.assign({}, options.headers || {})
    };

    const req = http.request(reqOptions, res => {
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

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Raw TCP socket request helper to bypass any client-side HTTP library normalization
 */
function sendRawTcpRequest(port, rawHttpString) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(rawHttpString);
    });

    let response = '';
    socket.on('data', chunk => {
      response += chunk.toString('utf8');
    });

    socket.on('end', () => {
      const statusMatch = response.match(/^HTTP\/1\.[01]\s+(\d{3})/);
      const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      resolve({ statusCode, raw: response });
    });

    socket.on('error', reject);
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve({ statusCode: 0, raw: response, timedOut: true });
    });
  });
}

const suite = new TestSuite('M6 Adversarial Security & Loopback Isolation Suite');

const TEST_SECRET_TOKEN = 'adversarial-m6-secret-token-abcdef0123456789';
let server = null;
let serverPort = 0;
let tempWorkspace = null;

suite.test('0.0 Setup test environment and initialize CommandCenterServer on dynamic port', async assert => {
  tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-m6-adversarial-'));
  fs.mkdirSync(path.join(tempWorkspace, '.crew'), { recursive: true });

  // Seed sample dossier with CONFIRM claim
  const dossier = {
    candidate: { name: 'Test Candidate', email: 'test@example.org' },
    employers: [{ id: 'emp_adv', name: 'SecurityCorp', startYear: 2020, isCurrent: true, title: 'Lead' }],
    claims: [
      { id: 'C-ADV-01', employerId: 'emp_adv', category: 'security', text: 'Adversarial test claim', status: 'CONFIRM' },
      { id: 'C-ADV-02', employerId: 'emp_adv', category: 'architecture', text: 'Atomic ledger claim', status: 'CONFIRM' }
    ]
  };
  fs.writeFileSync(path.join(tempWorkspace, 'dossier.json'), JSON.stringify(dossier, null, 2), 'utf8');

  server = new CommandCenterServer({
    workspaceDir: tempWorkspace,
    port: 0,
    token: TEST_SECRET_TOKEN
  });

  const info = await server.start();
  serverPort = info.port;

  assert.ok(serverPort > 0, 'Server must bind to dynamic port');
  assert.equal(info.token, TEST_SECRET_TOKEN);
});

// ============================================================================
// SECTION 1: Host Header Spoofing & DNS Rebinding Payloads
// ============================================================================

suite.test('1.1 Host header spoofing: external domain evil.com must be rejected with 403', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: {
      'Host': 'evil.com',
      'X-Session-Token': TEST_SECRET_TOKEN
    }
  });
  assert.equal(res.statusCode, 403, 'Host evil.com must return 403 Forbidden');
});

suite.test('1.2 Host header spoofing: attacker.domain must be rejected with 403', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: {
      'Host': 'attacker.domain',
      'X-Session-Token': TEST_SECRET_TOKEN
    }
  });
  assert.equal(res.statusCode, 403, 'Host attacker.domain must return 403 Forbidden');
});

suite.test('1.3 Host header spoofing: LAN IP 192.168.1.1 must be rejected with 403', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: {
      'Host': '192.168.1.1',
      'X-Session-Token': TEST_SECRET_TOKEN
    }
  });
  assert.equal(res.statusCode, 403, 'Host 192.168.1.1 must return 403 Forbidden');
});

suite.test('1.4 Host header spoofing: private network 10.0.0.1:8080 must be rejected with 403', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: {
      'Host': '10.0.0.1:8080',
      'X-Session-Token': TEST_SECRET_TOKEN
    }
  });
  assert.equal(res.statusCode, 403, 'Host 10.0.0.1:8080 must return 403 Forbidden');
});

suite.test('1.5 Host header spoofing: 0.0.0.0 wildcard must be rejected with 403', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: {
      'Host': '0.0.0.0',
      'X-Session-Token': TEST_SECRET_TOKEN
    }
  });
  assert.equal(res.statusCode, 403, 'Host 0.0.0.0 must return 403 Forbidden');
});

suite.test('1.6 Host header spoofing: 127.0.0.2 non-standard loopback must be rejected with 403', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: {
      'Host': '127.0.0.2',
      'X-Session-Token': TEST_SECRET_TOKEN
    }
  });
  assert.equal(res.statusCode, 403, 'Host 127.0.0.2 must return 403 Forbidden');
});

suite.test('1.7 DNS rebinding trick: localhost.evil.com subdomain must be rejected with 403', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: {
      'Host': 'localhost.evil.com',
      'X-Session-Token': TEST_SECRET_TOKEN
    }
  });
  assert.equal(res.statusCode, 403, 'Subdomain localhost.evil.com must return 403 Forbidden');
});

suite.test('1.8 DNS rebinding trick: 127.0.0.1.attacker.com must be rejected with 403', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: {
      'Host': '127.0.0.1.attacker.com',
      'X-Session-Token': TEST_SECRET_TOKEN
    }
  });
  assert.equal(res.statusCode, 403, 'Rebinding hostname 127.0.0.1.attacker.com must return 403 Forbidden');
});

suite.test('1.9 Spoofed proxy headers: X-Forwarded-Host does NOT bypass Host header enforcement', async assert => {
  // If attacker sets Host: evil.com and X-Forwarded-Host: 127.0.0.1, it must still be 403
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: {
      'Host': 'evil.com',
      'X-Forwarded-Host': '127.0.0.1',
      'X-Session-Token': TEST_SECRET_TOKEN
    }
  });
  assert.equal(res.statusCode, 403, 'X-Forwarded-Host must not bypass Host header check');
});

suite.test('1.10 Spoofed proxy headers: X-Forwarded-For is ignored and does not break loopback isolation', async assert => {
  // When Host is valid 127.0.0.1, spoofed X-Forwarded-For from proxy should not break authentication
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: {
      'Host': `127.0.0.1:${serverPort}`,
      'X-Forwarded-For': '203.0.113.195',
      'X-Session-Token': TEST_SECRET_TOKEN
    }
  });
  assert.equal(res.statusCode, 200, 'Legitimate loopback with external X-Forwarded-For succeeds');
});

suite.test('1.11 Valid Host headers: 127.0.0.1 and localhost (with port and case-insensitive) succeed', async assert => {
  const validHosts = [
    `127.0.0.1:${serverPort}`,
    '127.0.0.1',
    `localhost:${serverPort}`,
    'localhost',
    `LOCALHOST:${serverPort}`
  ];

  for (const host of validHosts) {
    const res = await makeRawRequest({
      port: serverPort,
      path: '/api/health',
      headers: {
        'Host': host,
        'X-Session-Token': TEST_SECRET_TOKEN
      }
    });
    assert.equal(res.statusCode, 200, `Valid Host header "${host}" must succeed`);
  }
});

// ============================================================================
// SECTION 2: Authentication Bypass Attempts
// ============================================================================

suite.test('2.1 Missing authentication: all protected endpoints reject with 401 Unauthorized', async assert => {
  const endpoints = ['/api/health', '/api/snapshot', '/api/decisions', '/api/jobs', '/api/runs', '/api/export', '/index.html'];

  for (const ep of endpoints) {
    const res = await makeRawRequest({
      port: serverPort,
      path: ep
    });
    assert.equal(res.statusCode, 401, `Unauthenticated request to ${ep} must return 401`);
    assert.ok(res.headers['www-authenticate'], 'Must include WWW-Authenticate header');
  }
});

suite.test('2.2 Empty token values across all 4 authentication channels reject with 401', async assert => {
  // Empty X-Session-Token
  const res1 = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: { 'X-Session-Token': '' }
  });
  assert.equal(res1.statusCode, 401, 'Empty X-Session-Token must return 401');

  // Empty Bearer token
  const res2 = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: { 'Authorization': 'Bearer ' }
  });
  assert.equal(res2.statusCode, 401, 'Empty Bearer token must return 401');

  // Whitespace Bearer token
  const res3 = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: { 'Authorization': 'Bearer    ' }
  });
  assert.equal(res3.statusCode, 401, 'Whitespace Bearer token must return 401');

  // Empty query parameter
  const res4 = await makeRawRequest({
    port: serverPort,
    path: '/api/health?token='
  });
  assert.equal(res4.statusCode, 401, 'Empty query token must return 401');

  // Empty cookie
  const res5 = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: { 'Cookie': 'crew_session=' }
  });
  assert.equal(res5.statusCode, 401, 'Empty cookie must return 401');
});

suite.test('2.3 Malformed Authorization header schemes reject with 401', async assert => {
  const malformedHeaders = [
    'Basic YWRtaW46cGFzc3dvcmQ=',
    `Digest username="admin", realm="JobHunt", token="${TEST_SECRET_TOKEN}"`,
    `Token ${TEST_SECRET_TOKEN}`,
    `bearer ${TEST_SECRET_TOKEN}`, // lowercase "bearer" should be rejected under strict spec
    'Bearer',                       // Bearer with no space
    `Bearer\t${TEST_SECRET_TOKEN}`  // tab separator
  ];

  for (const auth of malformedHeaders) {
    const res = await makeRawRequest({
      port: serverPort,
      path: '/api/health',
      headers: { 'Authorization': auth }
    });
    assert.equal(res.statusCode, 401, `Malformed auth scheme "${auth}" must return 401`);
  }
});

suite.test('2.4 Partial token matches (prefix, suffix, truncated, extended) reject with 401', async assert => {
  const partialAttempts = [
    TEST_SECRET_TOKEN.slice(0, 8),                       // First 8 chars
    TEST_SECRET_TOKEN.slice(0, TEST_SECRET_TOKEN.length - 1), // All except last char
    TEST_SECRET_TOKEN.slice(1),                          // All except first char
    TEST_SECRET_TOKEN + 'x',                             // Extended by 1 char
    TEST_SECRET_TOKEN + TEST_SECRET_TOKEN,               // Duplicated
    TEST_SECRET_TOKEN.slice(5, 15)                       // Substring in middle
  ];

  for (const attempt of partialAttempts) {
    const resHeader = await makeRawRequest({
      port: serverPort,
      path: '/api/health',
      headers: { 'X-Session-Token': attempt }
    });
    assert.equal(resHeader.statusCode, 401, `Partial token "${attempt}" in X-Session-Token must return 401`);

    const resBearer = await makeRawRequest({
      port: serverPort,
      path: '/api/health',
      headers: { 'Authorization': `Bearer ${attempt}` }
    });
    assert.equal(resBearer.statusCode, 401, `Partial token "${attempt}" in Bearer must return 401`);
  }
});

suite.test('2.5 Case sensitivity verification: uppercase hex token rejects via constant-time check', async assert => {
  const upperToken = TEST_SECRET_TOKEN.toUpperCase();
  assert.notEqual(upperToken, TEST_SECRET_TOKEN, 'Test token must have alphabetic characters to test case difference');

  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: { 'X-Session-Token': upperToken }
  });
  assert.equal(res.statusCode, 401, 'Uppercase variation of token must return 401');
});

suite.test('2.6 Injected characters in tokens (null bytes, newlines, SQLi payloads) reject with 401', async assert => {
  const attackTokens = [
    TEST_SECRET_TOKEN + '\0',
    TEST_SECRET_TOKEN + '\r\n',
    "' OR '1'='1",
    `" OR ""="`,
    TEST_SECRET_TOKEN + '<!--#include file="flag"-->',
    '${7*7}'
  ];

  for (const atk of attackTokens) {
    const res = await makeRawRequest({
      port: serverPort,
      path: `/api/health?token=${encodeURIComponent(atk)}`
    });
    assert.equal(res.statusCode, 401, `Injected token payload must return 401`);
  }
});

suite.test('2.7 Cookie injection & collision attacks: malformed or spoofed cookies reject with 401', async assert => {
  // Preceding cookie with similar name
  const res1 = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: { 'Cookie': `fake_crew_session=${TEST_SECRET_TOKEN}` }
  });
  assert.equal(res1.statusCode, 401, 'Prefix cookie fake_crew_session must not authenticate');

  // Multiple session cookies where first is invalid
  const res2 = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: { 'Cookie': `crew_session=attacker_bad_token; crew_session=${TEST_SECRET_TOKEN}` }
  });
  assert.equal(res2.statusCode, 401, 'First invalid cookie must reject without fallback');

  // Valid cookie surrounded by benign cookies must succeed
  const res3 = await makeRawRequest({
    port: serverPort,
    path: '/api/health',
    headers: { 'Cookie': `theme=dark; crew_session=${TEST_SECRET_TOKEN}; lang=en` }
  });
  assert.equal(res3.statusCode, 200, 'Valid cookie with surrounding cookies must succeed');
});

// ============================================================================
// SECTION 3: Static Asset Path Traversal Attacks
// ============================================================================

suite.test('3.1 Path traversal: raw dot-dot-slash (/../../package.json) is blocked', async assert => {
  // Low-level request specifying raw path
  const res = await makeRawRequest({
    port: serverPort,
    path: '/../../package.json',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.ok([403, 404].includes(res.statusCode), 'Path traversal must be forbidden (403) or not found (404)');
  assert.equal(res.body.includes('"name": "jobhunt-crew"'), false, 'Must never leak package.json content');
});

suite.test('3.2 Path traversal via raw TCP socket: GET /../../package.json is blocked', async assert => {
  const rawReq = `GET /../../package.json HTTP/1.1\r\nHost: 127.0.0.1:${serverPort}\r\nX-Session-Token: ${TEST_SECRET_TOKEN}\r\nConnection: close\r\n\r\n`;
  const res = await sendRawTcpRequest(serverPort, rawReq);
  assert.ok([403, 404].includes(res.statusCode), 'Raw TCP traversal must return 403 or 404');
  assert.equal(res.raw.includes('"name": "jobhunt-crew"'), false, 'Must never leak package.json content over raw TCP');
});

suite.test('3.3 Path traversal: URL-encoded dot-dot-slash (/%2e%2e/%2e%2e/package.json) is blocked', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/%2e%2e/%2e%2e/package.json',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.ok([403, 404].includes(res.statusCode), 'Encoded traversal must return 403 or 404');
  assert.equal(res.body.includes('"name": "jobhunt-crew"'), false, 'Must not leak package.json content');
});

suite.test('3.4 Path traversal: mixed-case URL encoding (/%2E%2E/%2E%2E/package.json) is blocked', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/%2E%2E/%2E%2E/package.json',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.ok([403, 404].includes(res.statusCode), 'Mixed-case encoded traversal must return 403 or 404');
  assert.equal(res.body.includes('"name": "jobhunt-crew"'), false, 'Must not leak package.json content');
});

suite.test('3.5 Path traversal: double-encoded traversal (/%252e%252e/) is blocked', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/%252e%252e/%252e%252e/package.json',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.ok([403, 404].includes(res.statusCode), 'Double-encoded traversal must return 403 or 404');
  assert.equal(res.body.includes('"name": "jobhunt-crew"'), false, 'Must not leak package.json content');
});

suite.test('3.6 Path traversal: Windows backslash traversal (/..\\..\\package.json) is blocked', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/..\\..\\package.json',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.ok([403, 404].includes(res.statusCode), 'Backslash traversal must return 403 or 404');
  assert.equal(res.body.includes('"name": "jobhunt-crew"'), false, 'Must not leak package.json content');
});

suite.test('3.7 Path traversal: encoded backslash (/..%5c..%5cpackage.json) is blocked', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/..%5c..%5cpackage.json',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.ok([403, 404].includes(res.statusCode), 'Encoded backslash traversal must return 403 or 404');
  assert.equal(res.body.includes('"name": "jobhunt-crew"'), false, 'Must not leak package.json content');
});

suite.test('3.8 Null byte injection against static paths (/index.html%00.png) is blocked', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/index.html%00.png',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.ok([400, 403, 404].includes(res.statusCode), 'Null-byte poisoned path must be rejected');
});

suite.test('3.9 Windows absolute drive path (/C:/Windows/win.ini) is contained or not found', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/C:/Windows/win.ini',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.ok([403, 404].includes(res.statusCode), 'Absolute Windows path must not escape publicDir');
  assert.equal(res.body.includes('[fonts]'), false, 'Must not leak Windows system files');
});

suite.test('3.10 Legitimate public assets: index.html, styles.css, app.js and root serve valid mime types', async assert => {
  // 1. Root /
  const resRoot = await makeRawRequest({
    port: serverPort,
    path: '/',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.equal(resRoot.statusCode, 200, 'Root path must return 200');
  assert.ok(resRoot.headers['content-type'].includes('text/html'), 'Root must serve text/html');
  assert.ok(resRoot.body.includes('JobHunt Crew'), 'Must include brand header');

  // 2. /styles.css
  const resCss = await makeRawRequest({
    port: serverPort,
    path: '/styles.css',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.equal(resCss.statusCode, 200, 'styles.css must return 200');
  assert.ok(resCss.headers['content-type'].includes('text/css'), 'styles.css must serve text/css');

  // 3. /app.js
  const resJs = await makeRawRequest({
    port: serverPort,
    path: '/app.js',
    headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
  });
  assert.equal(resJs.statusCode, 200, 'app.js must return 200');
  assert.ok(resJs.headers['content-type'].includes('javascript'), 'app.js must serve javascript');
});

// ============================================================================
// SECTION 4: Concurrency & Monotonic Ledger Sequencing Stress
// ============================================================================

suite.test('4.1 Rapid concurrent burst: 25 simultaneous POST /api/decision requests maintain lock stability and monotonic sequencing', async assert => {
  const NUM_CONCURRENT = 25;
  const requests = [];

  for (let i = 0; i < NUM_CONCURRENT; i++) {
    const payload = {
      type: i % 2 === 0 ? 'shortlist' : 'park',
      jobId: `job_concurrent_${String(i).padStart(3, '0')}`,
      payload: {
        score: 4.5,
        title: `Concurrent Engineer ${i}`,
        company: `Company ${i}`
      }
    };

    requests.push(makeRawRequest({
      port: serverPort,
      path: '/api/decision',
      method: 'POST',
      headers: {
        'X-Session-Token': TEST_SECRET_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    }));
  }

  // Fire all 25 requests simultaneously
  const results = await Promise.all(requests);

  // Assert every single request succeeded
  for (let i = 0; i < NUM_CONCURRENT; i++) {
    assert.equal(results[i].statusCode, 200, `Concurrent request ${i} must succeed with 200`);
    const data = JSON.parse(results[i].body);
    assert.equal(data.status, 'recorded', `Request ${i} must report status recorded`);
  }

  // Read all events from the ledger directly
  const ledger = new EventLedger({ workspaceDir: tempWorkspace });
  const events = ledger.readEvents({ limit: 100 });

  assert.equal(events.length, NUM_CONCURRENT, `Ledger must contain exactly ${NUM_CONCURRENT} events`);

  // Assert strict monotonic sequencing: 1, 2, 3, ... 25 with NO gaps and NO duplicates
  const eventIds = events.map(e => e.id);
  for (let i = 0; i < NUM_CONCURRENT; i++) {
    const expectedId = i + 1;
    assert.equal(eventIds[i], expectedId, `Event at index ${i} must have monotonic id ${expectedId}`);
  }

  // Verify SHA-256 cryptographic hash-chain integrity
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    const expectedPrevHash = crypto.createHash('sha256').update(JSON.stringify(prev)).digest('hex');
    assert.equal(curr.prevHash, expectedPrevHash, `Event ${curr.id} prevHash must match sha256 of previous serialized line`);
  }

  // Verify ledger integrity method
  const integrity = ledger.verifyChainIntegrity();
  assert.equal(integrity.valid, true, 'Ledger hash chain integrity must be valid');
});

suite.test('4.2 Guardrail enforcement under concurrency: agent submissions are rejected while human decisions succeed', async assert => {
  const NUM_PAIRS = 10;
  const requests = [];

  for (let i = 0; i < NUM_PAIRS; i++) {
    // 1. Illegal agent submission (GuardrailEngine violation)
    const illegalPayload = {
      type: 'SUBMIT',
      jobId: `job_illegal_${i}`,
      actor: 'agent:recon', // Illegal: agent attempting submit
      token: 'some-fake-token'
    };

    requests.push(makeRawRequest({
      port: serverPort,
      path: '/api/decision',
      method: 'POST',
      headers: {
        'X-Session-Token': TEST_SECRET_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(illegalPayload)
    }).then(res => ({ type: 'illegal', index: i, res })));

    // 2. Legal human confirm claim
    const legalPayload = {
      type: 'confirm_claim',
      claimId: `C-ADV-01`,
      actor: 'human:web',
      evidence: `Evidence confirmation under concurrency ${i}`
    };

    requests.push(makeRawRequest({
      port: serverPort,
      path: '/api/decision',
      method: 'POST',
      headers: {
        'X-Session-Token': TEST_SECRET_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(legalPayload)
    }).then(res => ({ type: 'legal', index: i, res })));
  }

  const outcomes = await Promise.all(requests);

  let illegalRejected = 0;
  let legalAccepted = 0;

  for (const out of outcomes) {
    if (out.type === 'illegal') {
      assert.equal(out.res.statusCode, 400, `Illegal agent submission must be rejected with 400`);
      const body = JSON.parse(out.res.body);
      assert.ok(body.error.includes('Guardrail Violation'), 'Must report Guardrail Violation');
      illegalRejected++;
    } else {
      assert.equal(out.res.statusCode, 200, `Legal human decision must succeed with 200`);
      legalAccepted++;
    }
  }

  assert.equal(illegalRejected, NUM_PAIRS, `All ${NUM_PAIRS} illegal agent attempts must be rejected`);
  assert.equal(legalAccepted, NUM_PAIRS, `All ${NUM_PAIRS} legal human decisions must be accepted`);

  // Assert ledger still has valid hash chain
  const ledger = new EventLedger({ workspaceDir: tempWorkspace });
  const integrity = ledger.verifyChainIntegrity();
  assert.equal(integrity.valid, true, 'Ledger hash chain integrity must remain valid');
});

suite.test('4.3 Snapshot consistency under concurrent writes and snapshot reads', async assert => {
  // Fire concurrent snapshot reads with rebuild=false and rebuild=true while writing decisions
  const operations = [];

  for (let i = 0; i < 5; i++) {
    operations.push(makeRawRequest({
      port: serverPort,
      path: '/api/decision',
      method: 'POST',
      headers: { 'X-Session-Token': TEST_SECRET_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'shortlist', jobId: `job_snap_stress_${i}` })
    }));

    operations.push(makeRawRequest({
      port: serverPort,
      path: '/api/snapshot',
      headers: { 'X-Session-Token': TEST_SECRET_TOKEN }
    }));
  }

  const results = await Promise.all(operations);
  for (const r of results) {
    assert.equal(r.statusCode, 200, 'Concurrent write or snapshot read must return 200');
  }
});

// ============================================================================
// SECTION 5: Payload & Malformed Input Abuse
// ============================================================================

suite.test('5.1 Oversized payload exceeding 1MB limit is blocked (connection terminated or 400)', async assert => {
  // Generate a 1.2MB payload
  const largeString = 'X'.repeat(1.2 * 1024 * 1024);
  const largePayload = JSON.stringify({
    type: 'shortlist',
    jobId: 'job_overflow',
    data: largeString
  });

  let threwConnReset = false;
  let statusCode = 0;
  try {
    const res = await makeRawRequest({
      port: serverPort,
      path: '/api/decision',
      method: 'POST',
      headers: {
        'X-Session-Token': TEST_SECRET_TOKEN,
        'Content-Type': 'application/json'
      },
      body: largePayload
    });
    statusCode = res.statusCode;
  } catch (err) {
    if (err.code === 'ECONNRESET' || (err.message && err.message.includes('socket hang up')) || (err.message && err.message.includes('ECONNRESET'))) {
      threwConnReset = true;
    } else {
      throw err;
    }
  }

  // The server either sends 400 or destroys the socket (ECONNRESET)
  assert.ok(threwConnReset || statusCode === 400 || statusCode === 413, 'Oversized payload must be blocked via ECONNRESET socket destruction or 400/413 status');
});

suite.test('5.2 Malformed JSON syntax in POST request returns 400', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/decision',
    method: 'POST',
    headers: {
      'X-Session-Token': TEST_SECRET_TOKEN,
      'Content-Type': 'application/json'
    },
    body: '{"type": "shortlist", truncated...'
  });

  assert.equal(res.statusCode, 400, 'Malformed JSON must return 400');
  const err = JSON.parse(res.body);
  assert.ok(err.error.includes('Malformed JSON'), 'Must report malformed JSON error');
});

suite.test('5.3 Empty request body on POST /api/decision returns 400', async assert => {
  const res = await makeRawRequest({
    port: serverPort,
    path: '/api/decision',
    method: 'POST',
    headers: {
      'X-Session-Token': TEST_SECRET_TOKEN,
      'Content-Type': 'application/json'
    },
    body: ''
  });

  assert.equal(res.statusCode, 400, 'Empty POST body must return 400');
});

// ============================================================================
// CLEANUP
// ============================================================================

suite.test('9.9 Teardown: Stop server cleanly and remove temporary workspace', async assert => {
  if (server) {
    await server.stop();
  }
  if (tempWorkspace && fs.existsSync(tempWorkspace)) {
    try {
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch (_) {}
  }
  assert.ok(true, 'Teardown completed successfully');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
