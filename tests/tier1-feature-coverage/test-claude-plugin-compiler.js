'use strict';

/**
 * Tier 1: Feature Coverage — Claude Code / Cowork Plugin Compiler
 *
 * Verifies manifest schema, zero-XML YAML frontmatter enforcement,
 * the 7 modular skill packages, frontmatter-free operating rules,
 * clean-room compliance, and zip packaging.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const { ClaudePluginCompiler } = require('../../lib/compiler/claude-plugin');

const suite = new TestSuite('M5 Feature 27: Claude Code / Cowork Plugin Compiler');

suite.test('TC-COMPILER-01: Manifest Structure & Schema Validation', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compiler-test-'));
  try {
    const compiler = new ClaudePluginCompiler({
      outDir: path.join(tmpDir, 'bundle')
    });
    const result = await compiler.build();

    assert.ok(fs.existsSync(result.manifestPath), 'plugin.json must exist');
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.equal(manifest.name, 'jobhunt-crew');
    assert.ok(typeof manifest.version === 'string' && manifest.version.length > 0);
    assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'suggestedPrompts'), false);
    assert.ok(manifest.metadata && Array.isArray(manifest.metadata.suggestedPrompts) && manifest.metadata.suggestedPrompts.length >= 3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-COMPILER-02: Frontmatter XML Tag Rejection (Zero Angle Brackets)', async assert => {
  // Test sanitizer function directly
  assert.equal(ClaudePluginCompiler.sanitizeDescription('A <tag>strip</tag> xml & <extra>'), 'A strip xml &');
  assert.equal(ClaudePluginCompiler.sanitizeDescription('A description with < brackets'), 'A description with brackets');
  assert.equal(ClaudePluginCompiler.sanitizeDescription('Safe text without brackets'), 'Safe text without brackets');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compiler-test-'));
  try {
    const compiler = new ClaudePluginCompiler({
      outDir: path.join(tmpDir, 'bundle')
    });
    await compiler.build();

    const skillsDir = path.join(tmpDir, 'bundle', 'skills');
    const skillDirs = fs.readdirSync(skillsDir);

    for (const s of skillDirs) {
      const skillFile = path.join(skillsDir, s, 'SKILL.md');
      const content = fs.readFileSync(skillFile, 'utf8');
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch !== null, `Skill ${s} must have YAML frontmatter`);

      const yaml = fmMatch[1];
      const descMatch = yaml.match(/description:\s*"([^"]*)"/);
      assert.ok(descMatch !== null, `Skill ${s} frontmatter must have description`);
      const desc = descMatch[1];
      assert.ok(!desc.includes('<') && !desc.includes('>'), `Skill ${s} description must not contain < or >: ${desc}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-COMPILER-03: 7 Clean-Room Skill Packages Completeness', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compiler-test-'));
  try {
    const compiler = new ClaudePluginCompiler({
      outDir: path.join(tmpDir, 'bundle')
    });
    const result = await compiler.build();
    assert.equal(result.skillsCount, 7, 'Must compile exactly 7 skills');

    const expectedSkills = ['setup', 'update', 'honest-cv', 'apply-multi-vacancy', 'contacto', 'interview-prep', 'offer-review'];
    for (const name of expectedSkills) {
      const skillPath = path.join(tmpDir, 'bundle', 'skills', name, 'SKILL.md');
      assert.ok(fs.existsSync(skillPath), `Skill file must exist: ${name}/SKILL.md`);
      const size = fs.statSync(skillPath).size;
      assert.ok(size > 150, `Skill ${name} must have substantial instructions (got ${size} bytes)`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-COMPILER-04: Operating Rules Validation (AGENTS.md Frontmatter-Free)', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compiler-test-'));
  try {
    const compiler = new ClaudePluginCompiler({
      outDir: path.join(tmpDir, 'bundle')
    });
    const result = await compiler.build();

    assert.ok(fs.existsSync(result.rulesPath), 'rules/AGENTS.md must exist');
    const content = fs.readFileSync(result.rulesPath, 'utf8');

    // Invariant: MUST NOT have YAML frontmatter
    assert.ok(!content.startsWith('---'), 'rules/AGENTS.md must NOT start with frontmatter');

    // Must cover 5 core guardrails
    assert.ok(content.includes('100% Local File State'), 'Must cover Rule 1');
    assert.ok(content.includes('Strict Human-in-the-Loop'), 'Must cover Rule 2');
    assert.ok(content.includes('Deterministic Claim Verification'), 'Must cover Rule 3');
    assert.ok(content.includes('Zero Age Penalty'), 'Must cover Rule 4');
    assert.ok(content.includes('Optimal Task-Specific'), 'Must cover Rule 5');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-COMPILER-05: Clean-Room & Zip Packaging Verification', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compiler-test-'));
  try {
    const zipPath = path.join(tmpDir, 'test-plugin.zip');
    const compiler = new ClaudePluginCompiler({
      outDir: path.join(tmpDir, 'bundle'),
      zip: true,
      zipPath
    });
    const result = await compiler.build();

    assert.ok(fs.existsSync(zipPath), 'Zip archive must be generated');
    const zipBuffer = fs.readFileSync(zipPath);
    assert.ok(zipBuffer.length > 500, 'Zip archive must be non-empty');
    assert.equal(zipBuffer[0], 0x50); // PK
    assert.equal(zipBuffer[1], 0x4b);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

suite.test('TC-COMPILER-06: Self-Contained Bundle (engine ships, no bundled MCP declaration)', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compiler-test-'));
  try {
    const compiler = new ClaudePluginCompiler({
      outDir: path.join(tmpDir, 'bundle')
    });
    const result = await compiler.build();
    const bundle = path.join(tmpDir, 'bundle');

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    // Cowork's server-side marketplace validator rejects plugin-declared MCP
    // servers without a `url` string (failed_content). The crew server is
    // stdio-based, so the manifest must not declare it; hosts register it
    // explicitly (claude mcp add / Desktop config / mcp_config.json).
    assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'mcpServers'), false, 'Manifest must not declare bundled MCP servers (Cowork sync validator)');
    assert.ok(fs.existsSync(path.join(bundle, 'bin', 'crew-mcp.js')), 'MCP entry script must exist inside bundle: bin/crew-mcp.js');
    assert.ok(fs.existsSync(path.join(bundle, 'lib', 'mcp', 'server.js')), 'Bundle must include lib/mcp/server.js');
    assert.ok(fs.existsSync(path.join(bundle, 'templates')), 'Bundle must include templates/');
    assert.ok(fs.existsSync(path.join(bundle, 'mcp_config.json')), 'Bundle must include mcp_config.json');
    assert.ok(!fs.existsSync(path.join(bundle, '.crew')), 'Bundle must never include .crew state');
    assert.ok(!fs.existsSync(path.join(bundle, '.pii-denylist')), 'Bundle must never include .pii-denylist');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
