'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { KsaOfferCalculator } = require('../../lib/crew/ksa-offer');

const CLI = path.resolve(__dirname, '../../bin/crew.js');
const sum = s => Number((s.basic + s.housing + s.transport).toFixed(2));
const codes = s => s.warnings.map(w => w.code);

test('missing allowances come from the remainder of a stated gross, never above it', () => {
  // Reported case: gross 30,000 with basic 20,000 used to yield components of 30,500.
  const basicOnly = KsaOfferCalculator.calculateSalaryStructure(30000, { split: { basic: 20000 } });
  assert.deepEqual([basicOnly.basic, basicOnly.housing, basicOnly.transport], [20000, 7142.86, 2857.14]);
  assert.equal(sum(basicOnly), 30000);

  const oneMissing = KsaOfferCalculator.calculateSalaryStructure(30000, { split: { basic: 20000, housing: 5000 } });
  assert.equal(oneMissing.transport, 5000);

  const housingOnly = KsaOfferCalculator.calculateSalaryStructure(30000, { split: { housing: 5000 } });
  assert.equal(sum(housingOnly), 30000);

  const awkward = KsaOfferCalculator.calculateSalaryStructure(10000.01, { split: { basic: 3333.33 } });
  assert.equal(sum(awkward), 10000.01, 'rounding does not drift from gross');

  const viaEvaluate = KsaOfferCalculator.evaluateOffer({ totalSalary: 30000, basic: 20000 });
  assert.equal(sum(viaEvaluate.structure), 30000);

  const overstated = KsaOfferCalculator.calculateSalaryStructure(10000, { split: { basic: 12000 } });
  assert.deepEqual([overstated.housing, overstated.transport], [0, 0]);
  assert.ok(codes(overstated).includes('COMPONENTS_EXCEED_GROSS'));

  // Unchanged: no split means the standard 65/25/10 ratio.
  const standard = KsaOfferCalculator.calculateSalaryStructure(50000);
  assert.deepEqual([standard.basic, standard.housing, standard.transport], [32500, 12500, 5000]);
});

test('housing allowance is benchmarked against 25% of basic, not of gross', () => {
  // 3,500 is exactly 25% of basic 14,000 but only 17.5% of gross 20,000.
  const atNorm = KsaOfferCalculator.calculateSalaryStructure(20000, { split: { basic: 14000, housing: 3500, transport: 2500 } });
  assert.equal(codes(atNorm).includes('SUBSTANDARD_HOUSING_ALLOWANCE'), false);

  const below = KsaOfferCalculator.calculateSalaryStructure(20000, { split: { basic: 14000, housing: 3000, transport: 3000 } });
  assert.ok(codes(below).includes('SUBSTANDARD_HOUSING_ALLOWANCE'));

  const companyHousing = KsaOfferCalculator.calculateSalaryStructure(20000, { split: { basic: 17000, housing: 0, transport: 3000 }, companyHousing: true });
  assert.equal(codes(companyHousing).includes('SUBSTANDARD_HOUSING_ALLOWANCE'), false);
});

test('nationality defaults to non-Saudi in the library and the CLI, and the output says so', () => {
  assert.equal(KsaOfferCalculator.calculateGosi(30000).employeeDeduction, 0);
  assert.equal(KsaOfferCalculator.calculateGosi(30000, true).employeeDeduction, 2925);

  const assumed = KsaOfferCalculator.evaluateOffer({ totalSalary: 30000 });
  assert.equal(assumed.gosi.isSaudiNational, false);
  assert.equal(assumed.netMonthlyTakeHome, 30000);
  assert.deepEqual([assumed.nationality.isSaudiNational, assumed.nationality.source], [false, 'assumed_default']);
  assert.match(assumed.nationality.note, /not stated/);
  assert.match(assumed.summary, /non-Saudi, assumed/);

  const stated = KsaOfferCalculator.evaluateOffer({ totalSalary: 30000, isSaudiNational: true });
  assert.equal(stated.gosi.employeeDeduction, 2632.5);
  assert.deepEqual([stated.nationality.isSaudiNational, stated.nationality.source], [true, 'stated']);

  const cli = flags => JSON.parse(spawnSync(process.execPath, [CLI, 'ksa-offer', '--gross', '30000', ...flags], { encoding: 'utf8' }).stdout);
  const cliExpat = cli(['--tenure', '6', '--separation', 'RESIGNATION']);
  assert.equal(cliExpat.gosi.employeeDeduction, 0);
  assert.equal(cliExpat.evaluation.nationality.source, 'assumed_default');
  assert.equal(cliExpat.evaluation.eosb.finalEosbAmount, cliExpat.eosb.finalEosbAmount);
  assert.equal(cli(['--saudi']).evaluation.nationality.source, 'stated');
});

test('an offer with no non-compete clause is not reported as having an unbounded one', () => {
  const none = KsaOfferCalculator.evaluateOffer({ totalSalary: 30000 });
  assert.deepEqual([none.nonCompete.isValid, none.nonCompete.stated, none.nonCompete.issues], [true, false, []]);
  const worldwide = KsaOfferCalculator.evaluateOffer({ totalSalary: 30000, nonCompeteMonths: 12, nonCompeteScope: 'Worldwide' });
  assert.equal(worldwide.nonCompete.isValid, false);
});
