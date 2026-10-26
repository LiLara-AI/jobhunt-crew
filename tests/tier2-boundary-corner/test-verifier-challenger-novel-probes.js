'use strict';
/**
 * JobHunt Crew — Tier 2: Novel Adversarial Verification Suite
 * Author: challenger_m3_r5_1 (Empirical Challenger)
 * Location: tests/tier2-boundary-corner/test-verifier-challenger-novel-probes.js
 *
 * Empirical verification of 5 novel adversarial evasion probes:
 * 1. Alternative title inflation phrasing (verb variations, inverted syntax, fronted leadership titles)
 * 2. Novel hyphenated compound counts (SLA hours, deliverables, clusters)
 * 3. Comparative alterations with approximate adverb modifiers ("to approximately", "down to nearly")
 * 4. Novel tool detections with potential substring/alias traps (Cassandra, BigQuery, Flask, Rust)
 * 5. Corresponding clean controls ensuring 0 false blocks on verified claims
 */

const { TestSuite } = require('../helpers/test-harness');
const { ClaimVerifier, VIOLATION_CODES } = require('../../lib/honest-cv/verify-claims');
const { referenceDossier } = require('./test-verifier-challenger-deep-stress');

const suite = new TestSuite('Tier 2: Novel Adversarial Challenger Probes');

suite.test('Novel Probe 1: Alternative title inflation phrasing is caught', (assert) => {
  const probes = [
    { text: 'Held the title of VP of Engineering at Meridian Tech.', title: 'VP of Engineering', employer: 'Meridian Tech' },
    { text: 'Appointed as Director of Infrastructure at Meridian Tech.', title: 'Director of Infrastructure', employer: 'Meridian Tech' },
    { text: 'At Meridian Tech, was promoted to Vice President of Engineering.', title: 'Vice President of Engineering', employer: 'Meridian Tech' },
    { text: 'Chief Architect at Meridian Tech, directing company platform strategy.', title: 'Chief Architect', employer: 'Meridian Tech' }
  ];

  for (const p of probes) {
    const res = ClaimVerifier.verifySentence(p.text, referenceDossier);
    assert.equal(res.passed, false, `Title probe must be blocked: "${p.text}"`);
    assert.ok(
      res.violations.some(v => v.code === VIOLATION_CODES.SCOPE_INFLATION || v.code === VIOLATION_CODES.TITLE_INFLATION || v.code === VIOLATION_CODES.ROLE_INFLATION),
      `Must flag title or scope inflation for "${p.text}"`
    );
  }
});

suite.test('Novel Probe 2: Novel hyphenated counts are extracted and verified against dossier', (assert) => {
  const hyphenProbes = [
    'Enforced 72-hour SLA at Horizon Systems.',
    'Maintained a 60-cluster Kubernetes infrastructure at Horizon Systems.',
    'Completed a 45-deliverable transformation program at Meridian Tech.'
  ];

  for (const text of hyphenProbes) {
    const res = ClaimVerifier.verifySentence(text, referenceDossier);
    assert.equal(res.passed, false, `Hyphenated count inflation must be caught: "${text}"`);
    assert.ok(
      res.violations.some(v => v.code === VIOLATION_CODES.METRIC_INFLATION || v.code === VIOLATION_CODES.SCOPE_INFLATION),
      `Must report metric or scope inflation for "${text}"`
    );
  }
});

suite.test('Novel Probe 3: Comparative alterations with approximation adverbs are caught', (assert) => {
  const compProbes = [
    'Reduced customer onboarding turnaround to approximately 2 days from 14 days at Meridian Tech.',
    'Cut customer onboarding turnaround from 14 days down to nearly 1 day at Meridian Tech.',
    'Decreased deployment failure rate from 35% to nearly 2% at Horizon Systems.'
  ];

  for (const text of compProbes) {
    const res = ClaimVerifier.verifySentence(text, referenceDossier);
    assert.equal(res.passed, false, `Comparative alteration must be blocked: "${text}"`);
    assert.ok(
      res.violations.some(v => v.code === VIOLATION_CODES.METRIC_INFLATION || v.code === VIOLATION_CODES.UNTAGGED_METRIC),
      `Must report metric inflation for "${text}"`
    );
  }
});

suite.test('Novel Probe 4: Novel tools (Cassandra, BigQuery, Flask, Rust) are caught without false alias collision', (assert) => {
  const techProbes = [
    { text: 'Stored time-series metrics in Cassandra at Horizon Systems.', tool: 'cassandra' },
    { text: 'Processed analytics queries with BigQuery at Meridian Tech.', tool: 'bigquery' },
    { text: 'Developed backend API endpoints using Flask at Meridian Tech.', tool: 'flask' },
    { text: 'Engineered high-performance networking services in Rust at Horizon Systems.', tool: 'rust' }
  ];

  for (const p of techProbes) {
    const res = ClaimVerifier.verifySentence(p.text, referenceDossier);
    assert.equal(res.passed, false, `Novel tool must be caught as unsupported: "${p.text}"`);
    assert.ok(
      res.violations.some(v => v.code === VIOLATION_CODES.UNSUPPORTED_TOOL && v.tool === p.tool),
      `Must report UNSUPPORTED_TOOL for ${p.tool}`
    );
  }
});

suite.test('Novel Probe 5: Clean controls for all novel patterns pass with zero violations', (assert) => {
  const cleanControls = [
    'Held the role of Senior Software Engineer at Meridian Tech.',
    'At Meridian Tech, worked as Senior Software Engineer.',
    'Enforced 6-hour critical incident resolution SLA at Horizon Systems.',
    'Maintained a 25-cluster Kubernetes infrastructure at Horizon Systems.',
    'Delivered 10 enterprise software projects at Meridian Tech.',
    'Reduced customer onboarding turnaround from 14 days down to 4 days at Meridian Tech.',
    'Decreased deployment failure rate from 35% to 5% at Horizon Systems.',
    'Developed backend services in TypeScript and Node.js at Meridian Tech.',
    'Built event streaming pipelines using Go and Kafka at Horizon Systems.'
  ];

  for (const text of cleanControls) {
    const res = ClaimVerifier.verifySentence(text, referenceDossier);
    assert.equal(res.passed, true, `Clean control must pass: "${text}". Got violations: ${JSON.stringify(res.violations)}`);
    assert.equal(res.violations.length, 0, `Clean control must have zero violations: "${text}"`);
  }
});

if (require.main === module) {
  suite.run({ verbose: true }).then(stats => {
    if (stats.failed > 0) {
      console.error(`\nFAILED: ${stats.failed} of ${stats.total} tests failed.`);
      process.exit(1);
    } else {
      console.log(`\nPASSED: All ${stats.passed} tests passed successfully.`);
      process.exit(0);
    }
  }).catch(err => {
    console.error('Test suite crashed:', err);
    process.exit(1);
  });
}

module.exports = suite;
