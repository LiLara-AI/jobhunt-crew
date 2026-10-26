'use strict';

const assert = require('assert');
const { ClaimVerifier, verifyDraftAgainstDossier } = require('../../lib/honest-cv/verify-claims');

// Fixture matching the Sentinel probe description:
const customDossier = {
  candidate: {
    name: 'Test Candidate',
    currentTitle: 'Engineering Manager',
    salaryFloor: { currency: 'SAR', minimumBase: 25000, targetTotal: 35000 }
  },
  employers: [
    { id: 'emp_northwind', name: 'Northwind Logistics', isCurrent: false },
    { id: 'emp_contoso', name: 'Contoso Retail', isCurrent: true }
  ],
  claims: [
    {
      id: 'CLM-NW-01',
      employerId: 'emp_northwind',
      category: 'leadership',
      text: 'Led a team of 12 people at Northwind Logistics.',
      metrics: ['12 people'],
      tools: []
    },
    {
      id: 'CLM-NW-02',
      employerId: 'emp_northwind',
      category: 'budget',
      text: 'Managed an annual budget of SAR 2.5 million at Northwind Logistics.',
      metrics: ['SAR 2.5 million'],
      tools: []
    }
  ],
  skills: {},
  degrees: [],
  certifications: []
};

console.log('Testing Sentinel 4 Failure Modes Against verifyDraftAgainstDossier & ClaimVerifier:');

const testCases = [
  {
    id: 'CASE 1: Inflated headcount',
    text: 'At Northwind Logistics I led a team of 35 people.',
    expectedToFail: true,
    note: 'Verified is 12 people, draft claims 35 people'
  },
  {
    id: 'CASE 2: Unknown employer',
    text: 'Led a team of 12 people at Aramco.',
    expectedToFail: true,
    note: 'Aramco is not in candidate dossier employers'
  },
  {
    id: 'CASE 3: Numbers written as words',
    text: 'At Northwind Logistics I led a team of thirty people.',
    expectedToFail: true,
    note: 'Thirty people (30) is inflated over verified 12'
  },
  {
    id: 'CASE 4: Transplant to wrong employer',
    text: 'At Contoso Retail I managed an annual budget of SAR 2.5 million.',
    expectedToFail: true,
    note: 'Budget only verified for Northwind Logistics, transplanted to Contoso Retail'
  }
];

for (const tc of testCases) {
  console.log(`\n--- ${tc.id} ---`);
  console.log(`Input Text: "${tc.text}"`);
  console.log(`Note: ${tc.note}`);

  const res = verifyDraftAgainstDossier(customDossier, tc.text);
  console.log(`Result: passed=${res.passed}, violationsCount=${res.violations.length}`);
  if (res.violations.length > 0) {
    console.log(`Violations: ${JSON.stringify(res.violations)}`);
  }

  if (res.passed) {
    console.log(`>>> BYPASS CONFIRMED! Verifier incorrectly PASSED this fabrication!`);
  } else {
    console.log(`>>> CAUGHT! Verifier correctly flagged this fabrication.`);
  }
}
