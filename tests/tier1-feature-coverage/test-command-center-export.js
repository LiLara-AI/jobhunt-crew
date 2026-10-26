'use strict';
/**
 * Tier 1: Feature Coverage - Command Center Offline Exporter
 * Verifies standalone single-file export generation, zero remote URL validation,
 * safe script embedding with breakout prevention, and JSON state roundtrip parity.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const { exportDashboard, verifyZeroRemoteAssets, serializeSnapshotSafely } = require('../../lib/command-center/exporter');

const suite = new TestSuite('Tier 1: Command Center Offline Exporter');

let tempDir;

suite.test('Setup temporary export directory', async assert => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-export-test-'));
  assert.ok(fs.existsSync(tempDir));
});

suite.test('verifyZeroRemoteAssets correctly permits clean content and rejects remote URLs', async assert => {
  // Clean content
  const cleanHtml = '<!DOCTYPE html><html><head><style>body { color: #fff; }</style></head><body><h1>Offline</h1></body></html>';
  assert.ok(verifyZeroRemoteAssets(cleanHtml) === true, 'Clean HTML must pass');

  // Forbidden: remote CDN
  assert.throws(() => {
    verifyZeroRemoteAssets('<html><head><script src="https://cdn.jsdelivr.net/npm/vue"></script></head></html>');
  }, /EXPORT_SECURITY_VIOLATION/, 'Must reject jsdelivr CDN link');

  // Forbidden: Google Fonts
  assert.throws(() => {
    verifyZeroRemoteAssets('<html><head><link href="https://fonts.googleapis.com/css" rel="stylesheet"></head></html>');
  }, /EXPORT_SECURITY_VIOLATION/, 'Must reject Google Fonts link');

  // Forbidden: unpkg
  assert.throws(() => {
    verifyZeroRemoteAssets('<html><body><script src="https://unpkg.com/react"></script></body></html>');
  }, /EXPORT_SECURITY_VIOLATION/, 'Must reject unpkg link');

  // Forbidden: protocol-relative //
  assert.throws(() => {
    verifyZeroRemoteAssets('<html><body><script src="//example.com/bad.js"></script></body></html>');
  }, /EXPORT_SECURITY_VIOLATION/, 'Must reject protocol-relative remote link');
});

suite.test('serializeSnapshotSafely escapes script tag breakout and HTML comments', async assert => {
  const dangerousPayload = {
    jobTitle: 'Hacker </script><script>alert(1)</script>',
    notes: 'Testing <!-- comment breakout -->'
  };

  const serialized = serializeSnapshotSafely(dangerousPayload);
  assert.equal(serialized.includes('<'), false, 'Must not contain literal <');
  assert.equal(serialized.includes('</script>'), false, 'Must not contain unescaped </script>');
  assert.equal(serialized.includes('<!--'), false, 'Must not contain unescaped <!--');
  assert.ok(serialized.includes('\\u003c/script>'), 'Must escape </script> to \\u003c/script>');
  assert.ok(serialized.includes('\\u003c!--'), 'Must escape <!-- to \\u003c!--');
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.jobTitle, dangerousPayload.jobTitle);
});

suite.test('exportDashboard generates a standalone HTML file with zero remote URLs', async assert => {
  const outFile = path.join(tempDir, 'export-test.html');
  const sampleSnapshot = {
    version: 1,
    lastEventId: 42,
    updatedAt: new Date().toISOString(),
    jobs: {
      'job_alpha': {
        id: 'job_alpha',
        title: 'Principal Systems Architect',
        company: 'Apex Cloud',
        location: 'Riyadh, Saudi Arabia',
        score: 4.8,
        status: 'ready'
      }
    },
    applications: {},
    decisions: []
  };

  const result = await exportDashboard({
    workspace: tempDir,
    outFile,
    snapshot: sampleSnapshot
  });

  assert.ok(fs.existsSync(outFile), 'Output file must exist on disk');
  assert.equal(result.lastEventId, 42, 'Metadata must reflect snapshot lastEventId');
  assert.equal(result.jobCount, 1, 'Metadata must reflect snapshot jobCount');
  assert.ok(result.sizeBytes > 5000, 'Exported HTML should be non-trivial in size');

  const html = fs.readFileSync(outFile, 'utf8');

  // Verify zero external assets
  assert.ok(verifyZeroRemoteAssets(html) === true, 'Exported HTML must pass verifyZeroRemoteAssets');

  // Verify CSS inlining
  assert.ok(html.includes('<style>'), 'Must contain inlined <style>');
  assert.equal(/<link\s+[^>]*rel=["']stylesheet["']/i.test(html), false, 'Must not have external <link rel="stylesheet">');

  // Verify JS inlining
  assert.ok(html.includes('<script>'), 'Must contain inlined <script>');
  assert.equal(/<script\s+[^>]*src=["'][^"']*app\.js["']/i.test(html), false, 'Must not have external <script src="app.js">');

  // Verify snapshot data embedding
  assert.ok(html.includes('id="snapshot-data"'), 'Must embed snapshot in id="snapshot-data" script tag');
});

suite.test('Clean-Room Invariant: Exported UI contains all 5 modern views and strictly NO Today tab/view or label', async assert => {
  const outFile = path.join(tempDir, 'export-test.html');
  const html = fs.readFileSync(outFile, 'utf8');

  // STRICT PROHIBITION: Zero "Today" tab or label
  assert.equal(/\bToday\b/i.test(html), false, 'Clean-room violation: Exported UI must not contain any Today tab, view, or label');

  // APPROVED 5-VIEW ARCHITECTURE
  assert.ok(html.includes('decision-queue'), 'Must contain decision-queue view');
  assert.ok(html.includes('pipeline-board'), 'Must contain pipeline-board view');
  assert.ok(html.includes('workbench'), 'Must contain workbench view');
  assert.ok(html.includes('evidence-map'), 'Must contain evidence-map view');
  assert.ok(html.includes('runs-timeline'), 'Must contain runs-timeline view');
});

suite.test('JSON roundtrip parity: Embedded snapshot can be parsed and matches source', async assert => {
  const outFile = path.join(tempDir, 'export-test.html');
  const html = fs.readFileSync(outFile, 'utf8');

  // Extract embedded JSON
  const match = html.match(/<script type="application\/json" id="snapshot-data">([\s\S]*?)<\/script>/);
  assert.ok(match, 'Must find snapshot-data script block');

  const parsed = JSON.parse(match[1]);

  assert.equal(parsed.lastEventId, 42);
  assert.ok(parsed.jobs['job_alpha'] !== undefined);
  assert.equal(parsed.jobs['job_alpha'].company, 'Apex Cloud');
  assert.equal(parsed.mode, 'offline-snapshot');
});

suite.test('Clean up export test workspace', async assert => {
  if (tempDir && fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(true);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
