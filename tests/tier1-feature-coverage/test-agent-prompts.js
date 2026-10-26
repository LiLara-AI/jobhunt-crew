'use strict';

/**
 * Tier 1: Feature Coverage — 7-Agent Prompt Definitions
 *
 * Verifies Antigravity frontmatter schema, task-specific Gemini model routing,
 * clean-room compliance, work-state waking references, and candidate isolation in Critic.
 */

const fs = require('fs');
const path = require('path');
const { TestSuite } = require('../helpers/test-harness');

const suite = new TestSuite('M5 Feature 25: 7-Agent Crew Prompt Definitions');

const AGENTS_DIR = path.resolve(__dirname, '../../agents');
const EXPECTED_AGENTS = [
  { file: 'dispatcher.md', name: 'dispatcher', model: 'flash' },
  { file: 'recon.md', name: 'recon', model: 'flash' },
  { file: 'scribe.md', name: 'scribe', model: 'pro' },
  { file: 'inquisitor.md', name: 'inquisitor', model: 'pro' },
  { file: 'critic.md', name: 'critic', model: 'pro' },
  { file: 'liaison.md', name: 'liaison', model: 'flash' },
  { file: 'navigator.md', name: 'navigator', model: 'flash' }
];

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const yaml = match[1];
  const data = {};
  const lines = yaml.split(/\r?\n/);
  let currentListKey = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ') && currentListKey) {
      data[currentListKey].push(trimmed.slice(2).trim());
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.slice(0, colonIdx).trim();
      const val = line.slice(colonIdx + 1).trim();

      if (val === '') {
        currentListKey = key;
        data[key] = [];
      } else {
        currentListKey = null;
        if (val === 'true') data[key] = true;
        else if (val === 'false') data[key] = false;
        else if (val.startsWith('"') && val.endsWith('"')) data[key] = val.slice(1, -1);
        else data[key] = val;
      }
    }
  }
  return data;
}

suite.test('All 7 agent prompt definitions exist in agents/ directory', assert => {
  for (const agent of EXPECTED_AGENTS) {
    const filePath = path.join(AGENTS_DIR, agent.file);
    assert.ok(fs.existsSync(filePath), `Agent prompt file must exist: ${agent.file}`);
  }
});

suite.test('Agent frontmatter conforms strictly to Antigravity automation schema', assert => {
  for (const agent of EXPECTED_AGENTS) {
    const filePath = path.join(AGENTS_DIR, agent.file);
    const content = fs.readFileSync(filePath, 'utf8');
    const fm = parseFrontmatter(content);

    assert.ok(fm !== null, `${agent.file} must have valid YAML frontmatter`);
    assert.equal(fm.name, agent.name, `Frontmatter name must match ${agent.name}`);
    assert.ok(typeof fm.description === 'string' && fm.description.length > 10, `${agent.file} must have non-empty description`);
    assert.ok(Array.isArray(fm.tools) && fm.tools.length > 0, `${agent.file} must have tools list`);
    assert.equal(fm.mainAgent, true, `${agent.file} must declare mainAgent: true`);
    assert.equal(fm.subagent, true, `${agent.file} must declare subagent: true`);
    assert.equal(fm.commandExecutionPolicy, 'auto', `${agent.file} must declare commandExecutionPolicy: auto`);
  }
});

suite.test('Each agent prompt documents correct task-specific Gemini model routing', assert => {
  for (const agent of EXPECTED_AGENTS) {
    const filePath = path.join(AGENTS_DIR, agent.file);
    const content = fs.readFileSync(filePath, 'utf8');
    const expectedModelSnippet = `model: "${agent.model}"`;
    assert.ok(content.includes(expectedModelSnippet), `${agent.file} must document ${expectedModelSnippet}`);
  }
});

suite.test('Agent prompts enforce work-state waking and reference .crew state files', assert => {
  for (const agent of EXPECTED_AGENTS) {
    const filePath = path.join(AGENTS_DIR, agent.file);
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('.crew/snapshot.json'), `${agent.file} must reference .crew/snapshot.json`);
  }
});

suite.test('Critic agent prompt strictly defines provable candidate de-identification and isolation', assert => {
  const filePath = path.join(AGENTS_DIR, 'critic.md');
  const content = fs.readFileSync(filePath, 'utf8');
  assert.ok(content.includes('Provable Candidate Isolation Protocol'), 'Critic must contain isolation protocol section');
  assert.ok(content.includes('Candidate-Blind Ingestion'), 'Critic must declare candidate-blind ingestion');
  assert.ok(content.includes('Zero Candidate Profiling'), 'Critic must prohibit candidate profiling');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
