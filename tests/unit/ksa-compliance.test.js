'use strict';

/**
 * KSA compliance must accept the work-authorization ids intake stores
 * (snake_case) as well as the legacy Title-Case strings, and must treat a
 * localized profession as a property of the job TITLE, not of any JD mention.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  KsaCountryPack,
  IqamaTransferEngine,
  normalizeWorkAuthorization
} = require('../../lib/discovery/ksa-pack');
const { JobScorer } = require('../../lib/discovery/job-scorer');

describe('work authorization normalization', () => {
  test('intake ids, intake labels and legacy strings map to one canonical form', () => {
    const cases = {
      'Saudi National': ['saudi_national', 'Saudi National', 'SAUDI NATIONAL'],
      'GCC National': ['gcc_national', 'GCC National'],
      'Transferable Iqama': ['transferable_iqama', 'Transferable Iqama', 'Transferable Iqama (KSA Resident)'],
      'Requires Visa Sponsorship': ['visa_sponsorship', 'Requires Visa Sponsorship']
    };
    for (const [canonical, spellings] of Object.entries(cases)) {
      for (const s of spellings) assert.strictEqual(normalizeWorkAuthorization(s), canonical, s);
    }
    assert.strictEqual(normalizeWorkAuthorization('Authorized'), 'Authorized');
    assert.strictEqual(normalizeWorkAuthorization('constructor'), 'constructor');
  });

  test('snake_case ids behave exactly like the Title-Case strings', () => {
    const saudiOnly = 'Finance Analyst. Saudi nationals only.';
    const saudi = KsaCountryPack.evaluateCompliance(saudiOnly, 'saudi_national');
    assert.strictEqual(saudi.eligible, true);
    assert.strictEqual(saudi.isPriority, true);
    assert.strictEqual(KsaCountryPack.evaluateCompliance(saudiOnly, 'transferable_iqama').eligible, false);

    const iqamaOnly = 'Must have transferable Iqama. No visa sponsorship.';
    assert.strictEqual(KsaCountryPack.evaluateCompliance(iqamaOnly, 'visa_sponsorship').eligible, false);
    assert.strictEqual(KsaCountryPack.evaluateCompliance(iqamaOnly, 'transferable_iqama').eligible, true);
    assert.strictEqual(IqamaTransferEngine.evaluate(iqamaOnly, 'visa_sponsorship').eligible, false);
    assert.strictEqual(IqamaTransferEngine.evaluate(iqamaOnly, 'gcc_national').applicable, false);
  });
});

describe('localized professions', () => {
  const jd = 'You will partner with the HR Manager and brief the receptionist on visitor access.';

  test('a JD that only mentions a localized profession is not knocked out', () => {
    const result = JobScorer.scoreVacancy({ title: 'Senior Data Engineer', company: 'Unknown Co', description: jd }, {});
    assert.strictEqual(result.knockout, undefined);
    assert.ok(result.score > 0);

    const compliance = KsaCountryPack.evaluateCompliance(`Senior Data Engineer ${jd}`, 'Transferable Iqama', { title: 'Senior Data Engineer' });
    assert.strictEqual(compliance.isSaudizationRestricted, false);
    assert.strictEqual(compliance.eligible, true);
  });

  test('a localized profession in the title still knocks out non-Saudi candidates', () => {
    for (const title of ['HR Manager', 'Front Desk Receptionist', 'موظف استقبال']) {
      const expat = JobScorer.scoreVacancy({ title, company: 'Unknown Co' }, { candidateStatus: 'transferable_iqama' });
      assert.strictEqual(expat.knockout, 'SAUDIZATION_RESTRICTED', title);
      const saudi = JobScorer.scoreVacancy({ title, company: 'Unknown Co' }, { candidateStatus: 'saudi_national' });
      assert.strictEqual(saudi.knockout, undefined, title);
    }
  });

  test('explicit Saudi-only wording anywhere in the JD still restricts the role', () => {
    const result = JobScorer.scoreVacancy(
      { title: 'Senior Data Engineer', company: 'Unknown Co', description: 'This role is for Saudi nationals only.' }, {});
    assert.strictEqual(result.knockout, 'SAUDIZATION_RESTRICTED');
  });

  test('a bare text call without metadata.title keeps scanning that text', () => {
    assert.strictEqual(KsaCountryPack.evaluateCompliance('Human Resources Manager', 'Transferable Iqama').eligible, false);
  });
});
