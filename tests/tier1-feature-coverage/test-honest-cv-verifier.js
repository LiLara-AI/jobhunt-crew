'use strict';
/**
 * Tier 1: Feature Coverage - Honest-CV Verifier Engine & Golden Corpus Benchmark
 * Evaluates the 42-case Golden Corpus (21 clean, 21 planted fabrications).
 * Contract:
 * - 100% recall on planted fabrications (21/21 caught).
 * - <= 5% false blocks on clean drafts (<= 1/21, target 0/21).
 */

const { TestSuite } = require('../helpers/test-harness');
const { corpus, dossiers } = require('../fixtures/golden-corpus/corpus');

const { ClaimVerifier } = require('../../lib/honest-cv/verify-claims');

const suite = new TestSuite('Tier 1: Honest-CV Verifier & 42-Case Golden Corpus');

suite.test('Golden Corpus achieves 100% recall on 21 planted fabrications', assert => {
  const fabrications = corpus.filter(c => c.type === 'fabrication');
  assert.equal(fabrications.length, 21, 'Must contain exactly 21 fabrication cases');

  let detectedCount = 0;
  const missedCases = [];

  for (const c of fabrications) {
    const dossier = dossiers[c.candidate];
    assert.ok(dossier, `Dossier must exist for candidate ${c.candidate}`);
    const result = ClaimVerifier.verifySentence(c, dossier);

    if (!result.passed) {
      detectedCount++;
      // Verify violation code matches or is appropriate
      assert.ok(result.violations.length > 0, `Violations must be reported for ${c.id}`);
    } else {
      missedCases.push(c.id);
    }
  }

  const recall = (detectedCount / fabrications.length) * 100;
  assert.equal(detectedCount, 21, `Expected 100% recall (21/21) but caught ${detectedCount}/21. Missed: ${missedCases.join(', ')}`);
  assert.equal(recall, 100);
});

suite.test('Golden Corpus achieves <= 5% false block rate on 21 clean drafts', assert => {
  const cleanCases = corpus.filter(c => c.type === 'clean');
  assert.equal(cleanCases.length, 21, 'Must contain exactly 21 clean cases');

  let falseBlockCount = 0;
  const blockedCases = [];

  for (const c of cleanCases) {
    const dossier = dossiers[c.candidate];
    assert.ok(dossier, `Dossier must exist for candidate ${c.candidate}`);
    const result = ClaimVerifier.verifySentence(c, dossier);

    if (!result.passed) {
      falseBlockCount++;
      blockedCases.push({ id: c.id, violations: result.violations });
    }
  }

  const falseBlockRate = (falseBlockCount / cleanCases.length) * 100;
  assert.lessThanOrEqual(falseBlockRate, 5, `False block rate must be <= 5%, got ${falseBlockRate}% (${falseBlockCount}/21). Blocked: ${JSON.stringify(blockedCases)}`);
  assert.equal(falseBlockCount, 0, 'Target is 0 false blocks on clean test cases');
});

suite.test('Verifier accurately identifies specific violation taxonomy categories', assert => {
  const testSubtypes = [
    'inflated_metric',
    'unsupported_tool',
    'transplanted_employer',
    'delegated_to_built_authorship',
    'scope_inflation',
    'hallucinated_credential',
    'fabricated_patent'
  ];

  for (const st of testSubtypes) {
    const item = corpus.find(c => c.subtype === st);
    assert.ok(item, `Fixture with subtype ${st} must exist`);
    const dossier = dossiers[item.candidate];
    const result = ClaimVerifier.verifySentence(item, dossier);
    assert.equal(result.passed, false, `Item ${item.id} (${st}) must fail verification`);
    assert.ok(result.violations.some(v => v.code === item.violationCode || v.code.includes(st.toUpperCase().slice(0, 5))));
  }
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
