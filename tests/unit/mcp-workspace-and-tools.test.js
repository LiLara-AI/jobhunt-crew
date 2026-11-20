'use strict';

/**
 * MCP server and CLI: workspace guard (plugin folder / home directory),
 * doctor workspace reporting, sweep ingest, persisted interview stories,
 * and EOSB pass-through on offer evaluation.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { McpServer } = require('../../lib/mcp/server');
const { resolveWorkspace, workspaceRefusal, PLUGIN_ROOT } = require('../../lib/cli/shared');
const { DiscoveryEngine } = require('../../lib/discovery');

const CLI = path.join(PLUGIN_ROOT, 'bin', 'crew.js');
const MCP = path.join(PLUGIN_ROOT, 'bin', 'crew-mcp.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-mcp-unit-'));

// Child processes must not inherit a pinned workspace or the test-suite opt-in.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (!('CREW_WORKSPACE' in extra)) delete env.CREW_WORKSPACE;
  if (!('CREW_ALLOW_PLUGIN_WORKSPACE' in extra)) delete env.CREW_ALLOW_PLUGIN_WORKSPACE;
  return env;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('A: workspace resolves flag > CREW_WORKSPACE > cwd and refuses the plugin folder and home', () => {
  const ws = tmp();
  const other = tmp();
  try {
    withEnv({ CREW_WORKSPACE: other, CREW_ALLOW_PLUGIN_WORKSPACE: undefined }, () => {
      assert.equal(resolveWorkspace({ workspace: ws }), ws);
      assert.equal(resolveWorkspace({}), other);
      assert.equal(new McpServer({ workspace: ws }).workspace, ws);
      assert.equal(new McpServer().workspace, other);
    });
    withEnv({ CREW_WORKSPACE: undefined, CREW_ALLOW_PLUGIN_WORKSPACE: undefined }, () => {
      assert.equal(workspaceRefusal(ws), null);
      assert.match(workspaceRefusal(PLUGIN_ROOT), /WORKSPACE_REFUSED.*plugin folder.*--workspace <folder>.*CREW_WORKSPACE/);
      assert.match(workspaceRefusal(os.homedir()), /WORKSPACE_REFUSED.*home directory/);
      assert.throws(() => resolveWorkspace({ workspace: PLUGIN_ROOT }), /WORKSPACE_REFUSED/);
      assert.throws(() => resolveWorkspace({ workspace: os.homedir() }), /WORKSPACE_REFUSED/);
    });
    withEnv({ CREW_ALLOW_PLUGIN_WORKSPACE: '1' }, () => {
      assert.equal(workspaceRefusal(PLUGIN_ROOT), null);
      assert.match(workspaceRefusal(os.homedir()), /home directory/, 'the opt-in never covers the home directory');
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test('A: MCP server in a refused folder returns the refusal from every tool call and writes nothing', async () => {
  const home = tmp(); // stand-in home directory, so the real one is never touched
  try {
    const env = cleanEnv({ HOME: home, USERPROFILE: home });
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'crew_doctor', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'crew_record_event', arguments: { type: 'JOB_DISCOVERED', payload: { id: 'j1' } } } }
    ].map(r => JSON.stringify(r)).join('\n') + '\n';
    const run = spawnSync(process.execPath, [MCP], { cwd: home, env, input: requests, encoding: 'utf8' });
    const replies = run.stdout.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(replies.length, 3, run.stderr);
    assert.ok(replies[0].result.tools.length > 0, 'tools/list still works so the host can connect');
    for (const reply of replies.slice(1)) {
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, /WORKSPACE_REFUSED.*home directory.*--workspace <folder>.*CREW_WORKSPACE/);
    }
    assert.equal(fs.existsSync(path.join(home, '.crew')), false);

    // The CLI refuses the same folders, and the plugin folder too.
    const init = spawnSync(process.execPath, [CLI, 'init'], { cwd: home, env, encoding: 'utf8' });
    assert.notEqual(init.status, 0);
    assert.match(init.stderr, /WORKSPACE_REFUSED/);
    assert.equal(fs.existsSync(path.join(home, '.crew')), false);
    const inPlugin = spawnSync(process.execPath, [CLI, 'tool', 'crew_doctor'], { cwd: PLUGIN_ROOT, env: cleanEnv(), encoding: 'utf8' });
    assert.notEqual(inPlugin.status, 0);
    assert.match(inPlugin.stderr, /WORKSPACE_REFUSED.*plugin folder/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('B: crew_doctor and crew_get_snapshot report the workspace folder and dossier presence', async () => {
  const ws = tmp();
  try {
    const server = new McpServer({ workspace: ws });
    const before = await server.callTool('crew_doctor', {});
    assert.equal(before.workspace, ws);
    assert.deepEqual(before.dossier, { exists: false, path: null });
    assert.ok(before.checks.some(c => /dossier/i.test(c.name) && c.pass === false && c.critical === false));

    fs.writeFileSync(path.join(ws, 'dossier.json'), JSON.stringify({ candidate: {}, claims: [] }));
    const after = await server.callTool('crew_doctor', {});
    assert.deepEqual(after.dossier, { exists: true, path: path.join(ws, 'dossier.json') });

    assert.equal((await server.callTool('crew_get_snapshot', {})).workspace, ws);
    assert.equal((await server.callTool('crew_get_snapshot', { filter: { limit: 1 } })).workspace, ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('C: crew_discover_sweep accepts an object target, ingests with dedup, and returns slim rows', async () => {
  const ws = tmp();
  const realSweep = DiscoveryEngine.prototype.sweepAts;
  const seenTargets = [];
  const board = [
    { id: 'wd-1', requisitionId: 'R-1', title: 'Operations Manager', company: 'Example Co', location: 'Riyadh', url: 'https://example.com/jobs/1', postedAt: '2026-01-01T00:00:00.000Z', remoteStatus: 'onsite', department: 'Ops', source: 'workday', rawPayload: { description: 'x'.repeat(5000) } },
    { id: 'wd-2', requisitionId: 'R-2', title: 'Finance Analyst', company: 'Example Co', location: 'Jeddah', url: 'https://example.com/jobs/2', remoteStatus: 'hybrid', department: 'Finance', source: 'workday', rawPayload: { description: 'y'.repeat(5000) } }
  ];
  DiscoveryEngine.prototype.sweepAts = async (provider, target) => { seenTargets.push(target); return board.map(j => ({ ...j })); };
  try {
    const server = new McpServer({ workspace: ws });
    const schema = server.tools.get('crew_discover_sweep').inputSchema.properties;
    assert.deepEqual(schema.target.type, ['string', 'object']);
    assert.equal(schema.ingest.type, 'boolean');

    const target = { tenant: 'example', dc: 'wd3', site: 'Careers' };
    const dry = await server.callTool('crew_discover_sweep', { provider: 'workday', target });
    assert.deepEqual(seenTargets[0], target, 'object target is passed through to the engine');
    assert.deepEqual([dry.found, dry.ingested, dry.duplicates], [2, 0, 0]);
    assert.equal(fs.existsSync(path.join(ws, '.crew', 'ledger.jsonl')), false, 'no ledger write without ingest');
    assert.deepEqual(Object.keys(dry.jobs[0]).sort(), ['company', 'department', 'duplicate', 'id', 'location', 'postedAt', 'remoteStatus', 'title', 'url']);
    assert.ok(JSON.stringify(dry).length < 2000, 'rawPayload is not returned to the model');

    const first = await server.callTool('crew_discover_sweep', { provider: 'workday', target, ingest: true });
    assert.deepEqual([first.found, first.ingested, first.duplicates], [2, 2, 0]);
    const snapshot = await server.callTool('crew_get_snapshot', {});
    assert.deepEqual(Object.keys(snapshot.jobs).sort(), ['wd-1', 'wd-2']);
    const events = server.ledger.readEvents();
    assert.deepEqual(events.map(e => e.event || e.type), ['JOB_DISCOVERED', 'JOB_DISCOVERED']);
    assert.ok(events[0].payload.rawPayload, 'the ledger keeps the full posting');

    const second = await server.callTool('crew_discover_sweep', { provider: 'workday', target: 'example', ingest: true });
    assert.deepEqual([second.found, second.ingested, second.duplicates], [2, 0, 2]);
    assert.equal(server.ledger.readEvents().length, 2);

    await assert.rejects(server.callTool('crew_discover_sweep', { provider: 'workday', target: ['x'] }), /target/);
  } finally {
    DiscoveryEngine.prototype.sweepAts = realSweep;
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('D: crew_interview_story add persists stories for later list, pack, and the CLI', async () => {
  const ws = tmp();
  const story = {
    situation: 'A regional outage hit 3 sites under a hard deadline',
    task: 'I owned the recovery plan end to end',
    action: 'First I isolated the fault, then I rolled back the release',
    result: 'Service restored in 20 minutes',
    reflection: 'Next time I would add a staged rollout',
    claimId: 'C-01'
  };
  try {
    const added = await new McpServer({ workspace: ws }).callTool('crew_interview_story', { action: 'add', story });
    assert.equal(added.persisted, true);
    assert.equal(added.storiesPath, path.join(ws, '.crew', 'stories.json'));

    // A fresh server instance (a later MCP session) still sees the story.
    const later = new McpServer({ workspace: ws });
    const listed = await later.callTool('crew_interview_story', { action: 'list' });
    assert.deepEqual(listed.stories.map(s => s.id), [added.story.id]);
    const pack = await later.callTool('crew_interview_story', { action: 'pack', company: 'Acme', role_title: 'Engineer', selected_story_ids: [added.story.id] });
    assert.equal(pack.storiesCount, 1);
    assert.match(pack.markdown, /regional outage/);

    await later.callTool('crew_interview_story', { action: 'add', story: { ...story, title: 'Second', claimId: 'C-02' } });
    assert.equal((await later.callTool('crew_interview_story', { action: 'list' })).stories.length, 2);

    const cli = spawnSync(process.execPath, [CLI, 'interview-story', '--workspace', ws, '--json'], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).storiesCount, 2);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('E/F3: crew_ksa_offer evaluate returns EOSB and defaults to non-Saudi, stating the assumption', async () => {
  const ws = tmp();
  try {
    const server = new McpServer({ workspace: ws });
    const expat = await server.callTool('crew_ksa_offer', { action: 'evaluate', total_salary: 30000, tenure_years: 6, separation_type: 'RESIGNATION' });
    // Article 84: 2.5 + 1 months of 30,000 = 105,000; Article 85 resignation at 6 years: two thirds.
    assert.equal(expat.eosb.fullAccrualArticle84, 105000);
    assert.equal(expat.eosb.finalEosbAmount, 70000);
    assert.equal(expat.eosb.separationType, 'RESIGNATION');
    assert.equal(expat.gosi.employeeDeduction, 0);
    assert.equal(expat.netMonthlyTakeHome, 30000);
    assert.equal(expat.nationality.isSaudiNational, false);
    assert.equal(expat.nationality.source, 'assumed_default');

    const saudi = await server.callTool('crew_ksa_offer', { action: 'evaluate', total_salary: 30000, is_saudi_national: true });
    assert.equal(saudi.gosi.employeeDeduction, 2632.5);
    assert.equal(saudi.nationality.source, 'stated');
    assert.equal((await server.callTool('crew_ksa_offer', { action: 'gosi', basic: 20000, housing: 5000 })).isSaudiNational, false);
    assert.equal(server.tools.get('crew_ksa_offer').inputSchema.properties.is_saudi_national.default, false);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
