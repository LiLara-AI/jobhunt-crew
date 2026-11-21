'use strict';
/**
 * Tier 3: Cross-Feature Interactions - Multi-Vacancy Strategy
 * Verifies single-company multi-vacancy triage (apply vs skip recommendations),
 * one convergent claim-verified CV across selected roles, and per-role custom cover letters.
 */

const { TestSuite } = require('../helpers/test-harness');

const { MultiVacancyStrategist } = require('../../lib/honest-cv/multi-vacancy');

const suite = new TestSuite('Tier 3: Multi-Vacancy Strategy');

suite.test('Multi-vacancy strategist recommends apply vs skip with reasons and generates 1 convergent CV', assert => {
  const company = 'Apex Cloud Technologies';
  const vacancies = [
    { id: 'v1', title: 'Principal Platform Architect', level: 'Principal', department: 'Platform Infrastructure' },
    { id: 'v2', title: 'Lead Distributed Systems Engineer', level: 'Lead', department: 'Distributed Systems' },
    { id: 'v3', title: 'Junior Cloud Operations Technician', level: 'Junior', department: 'IT Support' }
  ];

  // Bridging claims come from the dossier; the strategist never invents claim ids.
  const candidateProfile = {
    currentTitle: 'Principal Platform Architect',
    dossier: { claims: [{ id: 'CLM-001', status: 'VERIFIED' }, { id: 'CLM-002', status: 'VERIFIED' }, { id: 'CLM-003', status: 'CONFIRM' }] }
  };

  const plan = MultiVacancyStrategist.evaluateCompanyVacancies(company, vacancies, candidateProfile);

  assert.equal(plan.recommendations.length, 3);
  assert.equal(plan.recommendations[0].action, 'APPLY');
  assert.equal(plan.recommendations[1].action, 'APPLY');
  assert.equal(plan.recommendations[2].action, 'SKIP');
  assert.ok(plan.recommendations[2].reason.includes('below candidate seniority target'));

  // Exactly 1 convergent CV
  assert.ok(plan.convergentCv);
  assert.equal(plan.convergentCv.targetJobIds.length, 2);
  assert.deepEqual(plan.convergentCv.coreClaimIds, ['CLM-001', 'CLM-002']);

  // Per-role cover letters
  assert.equal(plan.perRoleCoverLetters.length, 2);
  assert.equal(plan.perRoleCoverLetters[0].jobId, 'v1');
  assert.equal(plan.perRoleCoverLetters[1].jobId, 'v2');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
