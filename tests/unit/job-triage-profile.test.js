'use strict';

/**
 * Auto-triage must score against what setup actually wrote: search-config.json
 * (shape from intake-wizard WorkspaceBuilder) plus the dossier's skills and
 * work authorization.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadTriageProfile } = require('../../lib/cli/commands/job');
const { JobScorer } = require('../../lib/discovery/job-scorer');

function workspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-triage-profile-'));
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
  }
  return dir;
}

const dossier = {
  candidate: { workAuthorization: 'saudi_national', currentTitle: 'Senior Accountant' },
  skills: {
    languages: ['Arabic', 'English'],
    frameworks: ['IFRS'],
    infrastructure: ['SAP'],
    databases: ['Oracle'],
    architecturalDomains: ['Financial Reporting', 'SAP']
  },
  preferences: { targetTitles: [], targetLocations: [], knockouts: { excludedCompanies: [], seniorityFloor: '' } }
};

const searchConfig = {
  version: '1.0.0',
  targetTitles: ['Senior Accountant'],
  targetLocations: { countries: ['Saudi Arabia'], cities: ['Riyadh'], workModes: ['Hybrid'] },
  knockouts: { excludedIndustries: [], excludedSubIndustries: [], excludedCompanies: ['Acme Trading'], seniorityFloor: 'Senior' },
  watchlist: ['Almarai']
};

describe('loadTriageProfile', () => {
  test('maps search-config.json and the dossier to the keys JobScorer reads', () => {
    const dir = workspace({ 'dossier.json': dossier, 'search-config.json': searchConfig });
    try {
      const { preferences, skills } = loadTriageProfile(dir);
      assert.deepStrictEqual(preferences.targetTitles, ['Senior Accountant']);
      assert.deepStrictEqual(preferences.targetCities, ['Riyadh']);
      assert.deepStrictEqual(preferences.targetCountries, ['Saudi Arabia']);
      assert.deepStrictEqual(preferences.companyWatchlist, ['Almarai']);
      assert.deepStrictEqual(preferences.excludedCompanies, ['Acme Trading']);
      assert.strictEqual(preferences.targetSeniority, 'Senior');
      assert.strictEqual(preferences.candidateStatus, 'saudi_national');
      assert.deepStrictEqual(skills, ['Arabic', 'English', 'IFRS', 'SAP', 'Oracle', 'Financial Reporting']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the loaded profile changes triage outcomes', () => {
    const dir = workspace({ 'dossier.json': dossier, 'search-config.json': searchConfig });
    try {
      const { preferences, skills } = loadTriageProfile(dir);
      const score = job => JobScorer.scoreVacancy(job, preferences, skills);

      const excluded = score({ title: 'Senior Accountant', company: 'Acme Trading', location: 'Riyadh' });
      assert.strictEqual(excluded.knockout, 'EXCLUDED_COMPANY');

      const match = score({ title: 'Senior Accountant', company: 'Almarai', location: 'Riyadh', description: 'IFRS reporting in SAP.' });
      const unrelated = score({ title: 'Drilling Rig Mechanic', company: 'Unknown Co', location: 'Aberdeen, UK' });
      assert.strictEqual(match.shortlisted, true);
      assert.strictEqual(unrelated.shortlisted, false, `unrelated role scored ${unrelated.score}`);

      // dossier.candidate.workAuthorization reaches the Saudization check.
      const saudiOnly = score({ title: 'Senior Accountant', company: 'Almarai', location: 'Riyadh', description: 'Saudi nationals only.' });
      assert.strictEqual(saudiOnly.knockout, undefined);
      assert.strictEqual(saudiOnly.shortlisted, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to dossier.json preferences when search-config.json is absent', () => {
    const dir = workspace({
      'dossier.json': {
        candidate: { workAuthorization: 'Transferable Iqama' },
        skills: { languages: ['Python'] },
        preferences: {
          targetTitles: ['Data Analyst'],
          targetLocations: ['Jeddah'],
          knockouts: { excludedCompanies: ['Acme Trading'], seniorityFloor: '' }
        }
      }
    });
    try {
      const { preferences, skills } = loadTriageProfile(dir);
      assert.deepStrictEqual(preferences.targetTitles, ['Data Analyst']);
      assert.deepStrictEqual(preferences.targetCities, ['Jeddah']);
      assert.deepStrictEqual(preferences.excludedCompanies, ['Acme Trading']);
      assert.strictEqual(preferences.candidateStatus, 'Transferable Iqama');
      assert.deepStrictEqual(skills, ['Python']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty workspace yields empty preferences and skills', () => {
    const dir = workspace({});
    try {
      const { preferences, skills } = loadTriageProfile(dir);
      assert.deepStrictEqual(preferences.targetTitles, []);
      assert.deepStrictEqual(preferences.excludedCompanies, []);
      assert.strictEqual(preferences.candidateStatus, '');
      assert.deepStrictEqual(skills, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
