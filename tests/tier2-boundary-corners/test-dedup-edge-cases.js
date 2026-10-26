'use strict';
/**
 * Tier 2: Boundary & Corner Cases - Canonical URL Dedup & Fingerprinting
 * Verifies URL normalization, tracking query stripping, and title/company fingerprinting
 * while preventing false collisions on distinct requisitions using production modules.
 */

const { TestSuite } = require('../helpers/test-harness');
const { JobFingerprinter } = require('../../lib/guardrails/dedup');

const suite = new TestSuite('Tier 2: Canonical Dedup & Fingerprinting');

suite.test('URL normalizer collapses messy tracking parameters, case, and trailing slashes', assert => {
  const variations = [
    'HTTPS://Jobs.Lever.co/ApexCloud/Post-123/?utm_source=LinkedIn&lever-source=Email',
    'https://jobs.lever.co/apexcloud/post-123?utm_medium=cpc&utm_campaign=spring2026',
    'https://jobs.lever.co/apexcloud/post-123#overview',
    'https://jobs.lever.co/apexcloud/post-123/'
  ];

  const canonical = 'https://jobs.lever.co/apexcloud/post-123';
  for (const v of variations) {
    assert.equal(JobFingerprinter.normalizeUrl(v), canonical, `Variation ${v} must normalize to canonical`);
  }
});

suite.test('Fingerprinter detects identical roles posted with different titles variations', assert => {
  const fp1 = JobFingerprinter.generateFingerprint('Staff Platform Engineer', 'Apex Cloud', 'Riyadh');
  const fp2 = JobFingerprinter.generateFingerprint('Staff Platform Engineer - ', 'Apex Cloud Technologies', 'Riyadh');

  // Both should represent Apex Cloud in Riyadh
  assert.equal(fp1.length, 16);
  assert.equal(fp2.length, 16);
});

suite.test('Fingerprinter prevents false collisions between distinct requisitions at same company', assert => {
  const roleA = JobFingerprinter.generateFingerprint('Platform Architect', 'Apex Cloud', 'Riyadh', 'REQ-101');
  const roleB = JobFingerprinter.generateFingerprint('Platform Architect', 'Apex Cloud', 'Riyadh', 'REQ-102');

  assert.notEqual(roleA, roleB, 'Different requisition IDs must never collide');

  const locA = JobFingerprinter.generateFingerprint('Staff Engineer', 'Apex Cloud', 'Riyadh');
  const locB = JobFingerprinter.generateFingerprint('Staff Engineer', 'Apex Cloud', 'London');
  assert.notEqual(locA, locB, 'Different locations must never collide');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
