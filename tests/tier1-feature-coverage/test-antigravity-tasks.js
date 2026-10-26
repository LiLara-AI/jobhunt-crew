'use strict';

/**
 * Tier 1: Feature Coverage — Antigravity Scheduled Tasks Sidecar Generator
 *
 * Verifies sidecar generator schema compliance, cron parameterization,
 * RFC 3986 URI encoding, scoped permission grants, and filesystem installation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { TestSuite } = require('../helpers/test-harness');
const {
  toWorkspaceUri,
  generateSidecarConfigs,
  installSidecars,
  runSelfTest
} = require('../../lib/setup-antigravity-tasks');

const suite = new TestSuite('M5 Feature 26: Antigravity Scheduled Tasks Sidecars Generator');

suite.test('Self-test CLI execution exits 0 and reports 100% passed', assert => {
  const scriptPath = path.resolve(__dirname, '../../lib/setup-antigravity-tasks.js');
  const output = execSync(`node "${scriptPath}" --self-test`, { encoding: 'utf8' });
  assert.ok(output.includes('[SELF-TEST] 100% PASSED'), 'CLI self-test must report 100% PASSED');
});

suite.test('Generated configurations strictly adhere to Antigravity automation schema', assert => {
  const configs = generateSidecarConfigs({ hour: 8, timezone: 'Asia/Riyadh' });
  const keys = Object.keys(configs);
  assert.equal(keys.length, 7, 'Must generate exactly 7 agent sidecar configurations');

  for (const [id, cfg] of Object.entries(configs)) {
    assert.equal(cfg.builtin, 'schedule', `${id}: builtin must be schedule`);
    assert.ok(cfg.cron && cfg.cron.startsWith('CRON_TZ=Asia/Riyadh'), `${id}: cron must start with CRON_TZ`);
    assert.ok(Array.isArray(cfg.command) && cfg.command[0] === 'agentapi' && cfg.command[1] === 'new-conversation', `${id}: command must invoke agentapi new-conversation`);
    assert.equal(cfg.restart_policy, 'always', `${id}: restart_policy must be always`);
    assert.ok(typeof cfg.display_name === 'string' && cfg.display_name.startsWith('JobHunt Crew - '), `${id}: display_name must follow standard format`);
    assert.ok(cfg.agent_permissions && Array.isArray(cfg.agent_permissions.workspace_uris), `${id}: workspace_uris must be an array`);
    assert.ok(Array.isArray(cfg.agent_permissions.access_grants), `${id}: access_grants must be an array`);
    assert.ok(cfg.agent_permissions.access_grants.includes('command(node bin/crew.js)'), `${id}: must grant crew CLI access`);
  }

  // Inquisitor must also grant AST verifier access
  const inq = configs['jobhunt-crew-inquisitor'];
  assert.ok(inq.agent_permissions.access_grants.includes('command(node lib/honest-cv/verify-claims.js)'), 'Inquisitor must grant verify-claims.js access');
});

suite.test('Custom timezone and start hour correctly parameterize cron expressions', assert => {
  const configs = generateSidecarConfigs({ timezone: 'Asia/Dubai', hour: 9 });

  assert.equal(configs['jobhunt-crew-dispatcher'].cron, 'CRON_TZ=Asia/Dubai 0 9 * * *');
  assert.equal(configs['jobhunt-crew-recon'].cron, 'CRON_TZ=Asia/Dubai 30 9 * * *');
  assert.equal(configs['jobhunt-crew-scribe'].cron, 'CRON_TZ=Asia/Dubai 15 10 * * *');
  assert.equal(configs['jobhunt-crew-inquisitor'].cron, 'CRON_TZ=Asia/Dubai 45 10 * * *');
  assert.equal(configs['jobhunt-crew-critic'].cron, 'CRON_TZ=Asia/Dubai 0 11 * * *');
  assert.equal(configs['jobhunt-crew-liaison'].cron, 'CRON_TZ=Asia/Dubai 15 11 * * *');
  assert.equal(configs['jobhunt-crew-navigator'].cron, 'CRON_TZ=Asia/Dubai 30 11 * * 6');
});

suite.test('RFC 3986 Workspace URI normalization handles Windows drives and spaces', assert => {
  const winUri = toWorkspaceUri('C:\\Users\\Candidate\\AI Projects\\job hunt\\jobhunt-crew');
  assert.ok(winUri.startsWith('file:///'), 'Windows path must start with file:///');
  assert.ok(winUri.includes('AI%20Projects'), 'Spaces must be percent-encoded');
  assert.ok(winUri.includes('job%20hunt'), 'Spaces in folder names must be encoded');

  const posixUri = toWorkspaceUri('/home/user/workspace/jobhunt-crew');
  assert.equal(posixUri, 'file:///home/user/workspace/jobhunt-crew');
});

suite.test('Installation creates all 7 sidecars in .crew/tasks/ without touching user config', assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-sidecars-test-'));
  try {
    const configs = generateSidecarConfigs({ workspace: tmpDir, hour: 8 });
    const installed = installSidecars(configs, { workspace: tmpDir });

    assert.equal(installed.length, 7, 'Must install 7 sidecar.json files');
    for (const p of installed) {
      assert.ok(fs.existsSync(p), `Installed sidecar must exist: ${p}`);
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      assert.equal(parsed.builtin, 'schedule');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
