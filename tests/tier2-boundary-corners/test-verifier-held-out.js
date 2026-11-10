'use strict';
/**
 * Tier 2: Boundary & Corner Cases - Held-Out Claim Verifier Evaluation
 *
 * Evaluates the 10 held-out probe cases:
 * 1. inflate-team: "At Northwind Logistics I led a team of 35 people." (Flagged - SCOPE_INFLATION)
 * 2. new-employer: "Led a team of 12 people at Aramco." (Flagged - UNKNOWN_EMPLOYER)
 * 3. spelled-number: "led a team of thirty people." (Flagged - SCOPE_INFLATION)
 * 4. transplant: "At Contoso Retail I managed an annual budget of SAR 2.5 million." (Flagged - TRANSPLANTED_EMPLOYER)
 * 5-10. 6 clean cases asserting verified facts that MUST PASS with 0 false blocks.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const { TestSuite } = require('../helpers/test-harness');
const { verifyDraftAgainstDossier, ClaimVerifier, VIOLATION_CODES } = require('../../lib/honest-cv/verify-claims');

const suite = new TestSuite('Tier 2: Held-Out Claim Verifier Evaluation Suite');

const heldOutDossier = {
  candidate: {
    name: 'Test Candidate',
    currentTitle: 'Engineering Manager',
    salaryFloor: { currency: 'SAR', minimumBase: 25000, targetTotal: 35000 }
  },
  employers: [
    { id: 'emp_northwind', name: 'Northwind Logistics', isCurrent: false, title: 'Engineering Manager' },
    { id: 'emp_contoso', name: 'Contoso Retail', isCurrent: true, title: 'Lead Software Engineer' }
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
      tools: ['AWS']
    },
    {
      id: 'CLM-CO-01',
      employerId: 'emp_contoso',
      category: 'engineering',
      text: 'Developed retail inventory sync pipeline in Go at Contoso Retail.',
      metrics: [],
      tools: ['Go']
    }
  ],
  skills: { languages: ['Go'], infrastructure: ['AWS'] },
  degrees: [],
  certifications: []
};

const HELD_OUT_CASES = [
  {
    id: 'inflate-team',
    text: 'At Northwind Logistics I led a team of 35 people.',
    expectedPass: false,
    expectedCode: VIOLATION_CODES.SCOPE_INFLATION,
    description: 'Inflated team size (35 people claimed vs 12 people verified)'
  },
  {
    id: 'new-employer',
    text: 'Led a team of 12 people at Aramco.',
    expectedPass: false,
    expectedCode: VIOLATION_CODES.UNKNOWN_EMPLOYER,
    description: 'Unverified employer not in candidate dossier (Aramco)'
  },
  {
    id: 'spelled-number',
    text: 'led a team of thirty people.',
    expectedPass: false,
    expectedCode: VIOLATION_CODES.SCOPE_INFLATION,
    description: 'Number written as words (thirty people = 30 > 12 verified baseline)'
  },
  {
    id: 'transplant',
    text: 'At Contoso Retail I managed an annual budget of SAR 2.5 million.',
    expectedPass: false,
    expectedCode: VIOLATION_CODES.TRANSPLANTED_EMPLOYER,
    description: 'Fact transplant: budget verified at Northwind Logistics claimed under Contoso Retail'
  },
  {
    id: 'clean-exact-team',
    text: 'At Northwind Logistics I led a team of 12 people.',
    expectedPass: true,
    description: 'Exact truthful restatement of verified CLM-NW-01 leadership scope'
  },
  {
    id: 'clean-exact-budget',
    text: 'At Northwind Logistics I managed an annual budget of SAR 2.5 million.',
    expectedPass: true,
    description: 'Exact truthful restatement of verified CLM-NW-02 budget metric'
  },
  {
    id: 'clean-spelled-number',
    text: 'At Northwind Logistics I led a team of twelve people.',
    expectedPass: true,
    description: 'Truthful statement with number written as word (twelve = 12 verified)'
  },
  {
    id: 'clean-second-employer',
    text: 'At Contoso Retail I developed retail inventory sync pipeline in Go.',
    expectedPass: true,
    description: 'Truthful statement of verified CLM-CO-01 role and tool at Contoso Retail'
  },
  {
    id: 'clean-qualitative-budget',
    text: 'Led platform engineering and managed annual infrastructure expenditure at Northwind Logistics.',
    expectedPass: true,
    description: 'Truthful qualitative summary of budget and platform responsibilities'
  },
  {
    id: 'clean-qualitative-team',
    text: 'Guided team delivery and platform architecture across logistics services at Northwind Logistics.',
    expectedPass: true,
    description: 'Truthful qualitative summary of leadership and architecture responsibilities'
  }
];

suite.test('All 4 held-out fabrication probes are detected with correct violation codes', assert => {
  const fabrications = HELD_OUT_CASES.filter(c => !c.expectedPass);
  assert.equal(fabrications.length, 4, 'Must evaluate 4 fabrication cases');

  for (const c of fabrications) {
    const res = verifyDraftAgainstDossier(heldOutDossier, c.text);
    assert.equal(res.passed, false, `Fabrication "${c.id}" must be rejected`);
    assert.ok(res.violations.length > 0, `Violations must be reported for "${c.id}"`);
    assert.ok(
      res.violations.some(v => v.code === c.expectedCode),
      `Expected violation ${c.expectedCode} for "${c.id}", got: ${JSON.stringify(res.violations)}`
    );
  }
});

suite.test('All 6 held-out clean drafts pass verification with zero false blocks', assert => {
  const cleanCases = HELD_OUT_CASES.filter(c => c.expectedPass);
  assert.equal(cleanCases.length, 6, 'Must evaluate 6 clean cases');

  for (const c of cleanCases) {
    const res = verifyDraftAgainstDossier(heldOutDossier, c.text);
    assert.equal(
      res.passed,
      true,
      `Clean draft "${c.id}" must pass verification, but was blocked with: ${JSON.stringify(res.violations)}`
    );
    assert.equal(res.violations.length, 0, `Clean draft "${c.id}" must have 0 violations`);
  }
});

suite.test('Individual held-out cases execute correctly through ClaimVerifier.verifySentence', assert => {
  for (const c of HELD_OUT_CASES) {
    const res = ClaimVerifier.verifySentence(c.text, heldOutDossier);
    assert.equal(
      res.passed,
      c.expectedPass,
      `verifySentence mismatch for "${c.id}": expected passed=${c.expectedPass}, got passed=${res.passed}`
    );
  }
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true });
}
