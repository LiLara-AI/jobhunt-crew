'use strict';

/**
 * The marketplace-synced plugin lives in plugins/jobhunt-crew/ and is a
 * compiler-generated artifact. This test fails when the committed copy
 * drifts from the sources; regenerate with:
 *   node scripts/build-claude-plugin.js --out plugins/jobhunt-crew
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ClaudePluginCompiler } = require('../../lib/compiler/claude-plugin');

const repoRoot = path.resolve(__dirname, '../..');
const committedDir = path.join(repoRoot, 'plugins', 'jobhunt-crew');

function snapshot(dir) {
  const out = new Map();
  const walk = (cur, rel) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        const text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
        out.set(r, crypto.createHash('sha256').update(text).digest('hex'));
      }
    }
  };
  walk(dir, '');
  return out;
}

test('committed marketplace bundle matches a fresh compiler build', async () => {
  assert.ok(fs.existsSync(path.join(committedDir, '.claude-plugin', 'plugin.json')), 'plugins/jobhunt-crew bundle must be committed');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-bundle-fresh-'));
  try {
    const outDir = path.join(tmpDir, 'bundle');
    const compiler = new ClaudePluginCompiler({ workspaceDir: repoRoot, outDir });
    await compiler.build();
    const fresh = snapshot(outDir);
    const committed = snapshot(committedDir);
    assert.deepEqual([...committed.keys()].sort(), [...fresh.keys()].sort(), 'Bundle file list drifted; regenerate plugins/jobhunt-crew');
    for (const [rel, hash] of fresh) {
      assert.equal(committed.get(rel), hash, `Bundle file drifted: ${rel}; regenerate plugins/jobhunt-crew`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
