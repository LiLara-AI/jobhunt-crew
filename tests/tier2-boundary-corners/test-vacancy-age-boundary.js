'use strict';
/**
 * Tier 2: Boundary & Corner Cases - 120-Day-Old Open Vacancy Eligibility
 * Verifies that posting age (e.g. 0d, 30d, 60d, 90d, 120d, 365d) never closes,
 * downgrades, or penalizes an open vacancy.
 */

const { TestSuite } = require('../helpers/test-harness');
const { TriageScorer } = require('../../lib/discovery/job-scorer');

const suite = new TestSuite('Tier 2: Vacancy Age Boundary & Eligibility');

suite.test('Vacancies of all ages (0d, 1d, 30d, 60d, 90d, 120d, 365d, 500d) receive identical scores with zero age penalty', assert => {
  const ages = [0, 1, 30, 45, 60, 90, 120, 180, 365, 500];

  // Evaluate baseline at age 0d
  const baseJob = {
    id: 'job_age_0',
    title: 'Principal Platform Architect',
    company: 'NEOM',
    postedAgeDays: 0,
    isOpen: true
  };
  const baseResult = TriageScorer.scoreVacancy(baseJob);
  assert.equal(baseResult.score, 4.2, 'Baseline score at age 0d must be 4.2');
  assert.equal(baseResult.status, 'shortlisted', 'Baseline status must be shortlisted');
  assert.equal(baseResult.verdict, 'PASS', 'Baseline verdict must be PASS');
  assert.equal(baseResult.shortlisted, true);
  assert.equal(baseResult.isOpen, true);

  for (const age of ages) {
    const job = {
      id: `job_age_${age}`,
      title: 'Principal Platform Architect',
      company: 'NEOM',
      postedAgeDays: age,
      isOpen: true
    };

    const result = TriageScorer.scoreVacancy(job);

    // Assert genuine calculated score (4.2) and status
    assert.equal(result.score, 4.2, `Score at age ${age}d must remain exactly 4.2`);
    assert.equal(result.status, 'shortlisted', `Status at age ${age}d must be shortlisted`);
    assert.equal(result.verdict, 'PASS', `Verdict at age ${age}d must be PASS`);
    assert.equal(result.shortlisted, true);
    assert.equal(result.isOpen, true);

    // Invariance assertion: score at age N must strictly equal score at age 0
    assert.equal(result.score, baseResult.score, `Score at age ${age}d must be strictly identical to age 0d`);
    assert.equal(result.compositeScore, baseResult.compositeScore, `Composite score at age ${age}d must be identical`);
    assert.ok(result.ageBadge.includes(`${age}d ago`));
  }
});

suite.test('Closing an open vacancy solely due to age is rejected across all boundaries', assert => {
  const job = { id: 'job_ancient', title: 'Director of Cloud', postedAgeDays: 120, isOpen: true };

  assert.equal(TriageScorer.canCloseVacancy(job, { type: 'posting_age', days: 120 }), false);
  assert.equal(TriageScorer.canCloseVacancy(job, { type: 'age_limit', days: 90 }), false);

  // Legitimate closure with evidence succeeds regardless of age
  assert.equal(TriageScorer.canCloseVacancy(job, { type: 'http_404', proof: '404 Not Found' }), true);
  assert.equal(TriageScorer.canCloseVacancy(job, { type: 'explicit_closure_notice', proof: 'Position filled' }), true);
});

suite.test('Knockout and restricted roles evaluated without preferences correctly yield score 0 and FAIL', assert => {
  // 1. Saudization restricted by description
  const baristaJob = {
    title: 'Barista',
    company: 'Starbucks',
    postedAgeDays: 0,
    isOpen: false,
    description: 'Open only for Saudi nationals'
  };
  const baristaResult = TriageScorer.scoreVacancy(baristaJob);
  assert.equal(baristaResult.score, 0, 'Barista knockout score must be 0');
  assert.equal(baristaResult.verdict, 'FAIL', 'Barista knockout verdict must be FAIL');
  assert.equal(baristaResult.status, 'FAIL', 'Barista knockout status must be FAIL');
  assert.equal(baristaResult.shortlisted, false);
  assert.equal(baristaResult.knockout, 'SAUDIZATION_RESTRICTED');

  // 2. 100% HRSD localized profession (HR Director)
  const hrJob = {
    title: 'Human Resources Director',
    company: 'NEOM',
    postedAgeDays: 0,
    isOpen: true
  };
  const hrResult = TriageScorer.scoreVacancy(hrJob);
  assert.equal(hrResult.score, 0, 'HR Director knockout score must be 0');
  assert.equal(hrResult.verdict, 'FAIL', 'HR Director knockout verdict must be FAIL');
  assert.equal(hrResult.status, 'FAIL', 'HR Director knockout status must be FAIL');
  assert.equal(hrResult.shortlisted, false);
  assert.equal(hrResult.knockout, 'SAUDIZATION_RESTRICTED');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
