'use strict';

/**
 * JobScorer for Arabic company names, GCC locations outside KSA, and
 * seniority relative to the candidate's own level.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { JobScorer, seniorityLevel } = require('../../lib/discovery/job-scorer');

const score = (job, prefs = {}, skills = []) => JobScorer.scoreVacancy(job, prefs, skills);

describe('excluded companies (Unicode-aware)', () => {
  test('one Arabic exclusion does not knock out every Arabic employer', () => {
    const prefs = { excludedCompanies: ['شركة أرامكو'] };
    assert.strictEqual(score({ title: 'Engineer', company: 'شركة المراعي' }, prefs).knockout, undefined);
    assert.strictEqual(score({ title: 'Engineer', company: 'شركة أرامكو' }, prefs).knockout, 'EXCLUDED_COMPANY');
    // Hamza / punctuation variants of the same name still match.
    assert.strictEqual(score({ title: 'Engineer', company: 'شركة ارامكو.' }, prefs).knockout, 'EXCLUDED_COMPANY');
  });

  test('Latin names still match ignoring case and punctuation', () => {
    assert.strictEqual(score({ title: 'Engineer', company: 'ACME-Trading, Co.' }, { excludedCompanies: ['Acme Trading Co'] }).knockout, 'EXCLUDED_COMPANY');
  });

  test('a job with no company is never excluded or watchlisted by an empty match', () => {
    const result = score({ title: 'Engineer', company: '' }, { excludedCompanies: ['---'], companyWatchlist: ['NEOM'] });
    assert.strictEqual(result.knockout, undefined);
    assert.strictEqual(result.dimensions.watchlistTier, 2.5);
  });
});

describe('GCC location fit', () => {
  const loc = (location, prefs) => score({ title: 'Engineer', company: 'Unknown Co', location }, prefs).dimensions.locationMatch;

  test('another city in a targeted GCC country is a partial match', () => {
    assert.strictEqual(loc('Dubai, UAE', { targetCities: ['Abu Dhabi'] }), 3.5);
    assert.strictEqual(loc('Doha', { targetCities: ['Riyadh'], targetCountries: ['Qatar'] }), 3.5);
    assert.strictEqual(loc('Manama, Bahrain', { targetCountries: ['Bahrain'] }), 3.5);
    assert.strictEqual(loc('دبي', { targetCountries: ['United Arab Emirates'] }), 3.5);
  });

  test('a GCC-wide target covers every GCC country', () => {
    for (const place of ['Dubai', 'Abu Dhabi', 'Doha', 'Kuwait City', 'Manama', 'Muscat', 'Jeddah']) {
      assert.strictEqual(loc(place, { targetCities: ['Riyadh'], targetCountries: ['GCC'] }), 3.5, place);
    }
  });

  test('a verbatim target city is still a full match', () => {
    assert.strictEqual(loc('Dubai, UAE', { targetCities: ['Dubai'] }), 5.0);
  });

  test('untargeted places stay low and KSA-only targets behave as before', () => {
    assert.strictEqual(loc('Dubai, UAE', { targetCities: ['Riyadh'] }), 1.0);
    assert.strictEqual(loc('Riyadh', { targetCities: ['Dubai'] }), 1.0);
    assert.strictEqual(loc('Bucharest, Romania', { targetCountries: ['Oman'] }), 1.0);
    assert.strictEqual(loc('Jeddah, Saudi Arabia', { targetCities: ['Riyadh'] }), 3.5);
    assert.strictEqual(loc('Remote', { targetCities: ['Riyadh'] }), 3.5);
    assert.strictEqual(loc('', { targetCities: ['Riyadh'] }), 3.0);
    assert.strictEqual(loc('Dubai, UAE', {}), 4.0);
  });
});

describe('seniority relative to the candidate', () => {
  const sen = (title, prefs) => score({ title, company: 'Unknown Co' }, prefs).dimensions.seniorityMatch;

  test('seniorityLevel reads the ladder', () => {
    assert.strictEqual(seniorityLevel('Junior Accountant'), 0);
    assert.strictEqual(seniorityLevel('Mid-level Engineer'), 1);
    assert.strictEqual(seniorityLevel('Sr. Nurse'), 2);
    assert.strictEqual(seniorityLevel('Team Lead'), 3);
    assert.strictEqual(seniorityLevel('Senior Director of Sales'), 4);
    assert.strictEqual(seniorityLevel('Accountant'), null);
    assert.strictEqual(seniorityLevel('Leadership Coach'), null);
  });

  test('a junior candidate is not pushed toward director roles', () => {
    const prefs = { targetSeniority: 'Junior' };
    assert.strictEqual(sen('Junior Accountant', prefs), 5.0);
    assert.strictEqual(sen('Accountant', prefs), 4.0);
    assert.strictEqual(sen('Senior Accountant', prefs), 2.5);
    assert.strictEqual(sen('Finance Director', prefs), 1.0);
  });

  test('a director-level candidate is not pushed toward junior roles', () => {
    const prefs = { targetSeniority: 'Director' };
    assert.strictEqual(sen('Finance Director', prefs), 5.0);
    assert.strictEqual(sen('Principal Analyst', prefs), 4.0);
    assert.strictEqual(sen('Junior Accountant', prefs), 1.0);
  });

  test('without an explicit level, the levels named in target titles are used', () => {
    const prefs = { targetTitles: ['Senior Accountant', 'Lead Accountant'] };
    assert.strictEqual(sen('Senior Financial Analyst', prefs), 5.0);
    assert.strictEqual(sen('Finance Director', prefs), 4.0);
    assert.strictEqual(sen('Graduate Trainee', prefs), 2.5);
  });

  test('with no level in the preferences the previous fixed scale applies', () => {
    for (const prefs of [{}, { targetTitles: ['Accountant'] }, { targetSeniority: '' }]) {
      assert.strictEqual(sen('Finance Director', prefs), 5.0);
      assert.strictEqual(sen('Senior Accountant', prefs), 4.0);
      assert.strictEqual(sen('Junior Accountant', prefs), 1.5);
    }
  });
});

describe('skills fit without a captured JD', () => {
  test('no description means neutral, a description with no hits means low', () => {
    const job = { title: 'Accountant', company: 'Unknown Co' };
    assert.strictEqual(score(job, {}, ['IFRS']).dimensions.techStackMatch, 3.5);
    assert.strictEqual(score({ ...job, description: 'Welding and rigging.' }, {}, ['IFRS']).dimensions.techStackMatch, 2.0);
    assert.strictEqual(score({ ...job, description: 'IFRS reporting.' }, {}, ['IFRS']).dimensions.techStackMatch, 3.5);
  });
});

describe('zero age penalty', () => {
  test('posting age never changes the score under the new preferences', () => {
    const prefs = { targetTitles: ['Senior Accountant'], targetCities: ['Riyadh'], targetCountries: ['GCC'], targetSeniority: 'Senior' };
    const base = { title: 'Senior Accountant', company: 'Unknown Co', location: 'Dubai' };
    const scores = [0, 30, 120, 365].map(postedAgeDays => score({ ...base, postedAgeDays }, prefs).score);
    assert.deepStrictEqual(scores, Array(4).fill(scores[0]));
  });
});

test('rank words alone never make a title match', () => {
  const { JobScorer } = require('../../lib/discovery/job-scorer');
  const prefs = { targetTitles: ['Customer Experience Manager'], targetCities: ['Riyadh'], targetCountries: ['Saudi Arabia'], companyWatchlist: ['Qiddiya'] };
  const unrelated = JobScorer.scoreVacancy({ title: 'Senior Manager - Accounts', company: 'Qiddiya', location: 'Riyadh, Saudi Arabia' }, prefs, []);
  assert.equal(unrelated.shortlisted, false, `unrelated role scored ${unrelated.score}`);
  const related = JobScorer.scoreVacancy({ title: 'Manager, Customer Experience', company: 'Qiddiya', location: 'Riyadh, Saudi Arabia' }, prefs, []);
  assert.equal(related.shortlisted, true, `related role scored ${related.score}`);
});
