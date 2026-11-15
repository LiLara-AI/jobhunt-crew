'use strict';

/**
 * Host compatibility: CLI tool bridge (Cowork/Codex/Kimi without MCP),
 * HTTP MCP transport (ChatGPT), and fixes found while porting.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { McpServer } = require('../../lib/mcp/server');
const { parseArgs } = require('../../lib/cli/shared');
const { reduceEvents } = require('../../lib/ledger/reducer');
const { ApplyPackGenerator } = require('../../lib/honest-cv/apply-pack');

const CLI = path.resolve(__dirname, '../../bin/crew.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-host-'));

test('crew tool runs an MCP tool from any cwd with --workspace', () => {
  const ws = tmp();
  try {
    execFileSync(process.execPath, [CLI, 'init', '--workspace', ws]);
    const out = execFileSync(process.execPath, [CLI, 'tool', 'crew_doctor', '--workspace', ws], { cwd: os.tmpdir() }).toString();
    assert.match(out, /"status"/);
    assert.ok(fs.existsSync(path.join(ws, '.crew')));
    assert.throws(() => execFileSync(process.execPath, [CLI, 'tool', 'crew_nope', '--workspace', ws], { stdio: 'pipe' }));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('HTTP transport requires the token and answers JSON-RPC', async () => {
  const ws = tmp();
  const server = new McpServer({ workspace: ws });
  const token = 'a'.repeat(32);
  const srv = await server.startHttp({ port: 0, token });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try {
    const init = await (await post(`/mcp/${token}`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const list = await (await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${token}` })).json();
    assert.ok(list.result.tools.some(t => t.name === 'crew_doctor'));
    assert.equal((await post('/mcp/wrong-token-wrong-token', { jsonrpc: '2.0', id: 3, method: 'ping' })).status, 404);
    assert.equal((await post(`/mcp/${token}`, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    assert.throws(() => server.startHttp({ token: 'short' }), /at least 16/);
  } finally {
    server.stop();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('apply pack reports NOT RUN instead of inventing a passed verification', () => {
  const md = ApplyPackGenerator.compileApplyPackMarkdown({ company: 'Acme', roleTitle: 'Engineer', claimsUsed: [] });
  assert.match(md, /Claim verification: NOT RUN · Blind review: NOT RUN/);
  assert.doesNotMatch(md, /Verifier Status\*\*: `PASSED|APPROVE`|4\.8/);
  const ok = ApplyPackGenerator.compileApplyPackMarkdown({
    company: 'Acme', roleTitle: 'Engineer', matchScore: 0,
    ...ApplyPackGenerator.checksFromApplication({ verification: { passed: true }, review: { verdict: 'APPROVE', score: 4.1 } })
  });
  assert.match(ok, /Claim verification: PASSED · Blind review: APPROVE/);
  assert.match(ok, /Triage Match Score\*\*: 0 \/ 5\.0/);
});

test('crew_verify_draft records its verdict for a job and rejects a missing draft file', async () => {
  const ws = tmp();
  try {
    execFileSync(process.execPath, [CLI, 'init', '--workspace', ws]);
    fs.copyFileSync(path.resolve(__dirname, '../../templates/CareerDossier.example.json'), path.join(ws, 'dossier.json'));
    fs.writeFileSync(path.join(ws, 'draft.md'), 'I increased revenue by 900% at a fictional employer.\n');
    const server = new McpServer({ workspace: ws });
    const res = await server.callTool('crew_verify_draft', { draft_path: 'draft.md', job_id: 'job_x' });
    assert.equal(res.recorded, true);
    assert.equal(server.readSnapshot().applications.job_x.verification.passed, res.passed);
    await assert.rejects(server.callTool('crew_verify_draft', { draft_path: 'drafts/missing.md' }), /Draft file not found/);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('parseArgs keeps "=" in values and accepts dash-led values', () => {
  const { flags } = parseArgs(['--url=https://x/j?a=1', '--replacement', '-', '--score', '-5']);
  assert.equal(flags.url, 'https://x/j?a=1');
  assert.equal(flags.replacement, '-');
  assert.equal(flags.score, '-5');
});

test('closed jobs stay closed after a late triage or re-discovery', () => {
  const ev = (id, type, payload) => ({ id, type, payload, timestamp: `2026-01-0${id}T00:00:00Z` });
  const s = reduceEvents([
    ev(1, 'JOB_DISCOVERED', { id: 'j1', url: 'https://a.example/1', title: 'T', company: 'C' }),
    ev(2, 'JOB_CLOSED', { id: 'j1', jobId: 'j1', reason: 'gone', evidence: '404' }),
    ev(3, 'JOB_TRIAGED', { id: 'j1', score: 4.5, status: 'shortlisted' }),
    ev(4, 'JOB_DISCOVERED', { id: 'j1', url: 'https://a.example/1', title: 'T2', company: 'C' })
  ]);
  assert.equal(s.jobs.j1.status, 'closed');
  assert.equal(s.jobs.j1.title, 'T2');
});
