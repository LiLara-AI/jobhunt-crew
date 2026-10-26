'use strict';
/**
 * Tier 2: Boundary & Corner Cases — Truthful Down-Scoping & Boundary Challenger Suite
 * Author: challenger_m3_r7_2 (Truthful Down-Scoping & Boundary Conditions Challenger)
 * Milestone: M3 Iteration 7 Gate Panel
 *
 * Empirical adversarial stress testing targeting:
 * 1. Scale unit down-scoping (1 cluster when 25, 8 accounts when 10, 3 microservices when 12) -> PASS
 * 2. Scale unit inflation (26 clusters when 25, 11 accounts when 10, 13 microservices when 12) -> FAIL
 * 3. Headcount down-scoping (5 engineers when 12, 1 engineer when 12, 11 engineers when 12) -> PASS
 * 4. Headcount inflation (13 engineers when 12, 15 engineers when 12) -> FAIL
 * 5. Decimal unit latency (0.042s, 42ms, 42 milliseconds when 42ms verified) -> PASS
 * 6. Latency inflation (0.041s, 41ms, 41 milliseconds, 0.010s, 10ms when 42ms verified) -> FAIL
 * 7. Multi-word & spelled-out down-scoping ("one cluster", "eight accounts", "three microservices", "five engineers") -> PASS
 * 8. Spelled-out word inflation ("twenty-six clusters", "eleven accounts", "fifteen engineers") -> FAIL
 * 9. Combined down-scoping in a single sentence (3 microservices across 5 clusters while managing 4 accounts) -> PASS
 * 10. Mixed truthful down-scoping + inflation in a single sentence -> FAIL (flags inflated metric)
 * 11. Duration non-scale unit boundary (claiming 2 days when 4 days verified is unverified duration reduction) -> FAIL
 * 12. Golden Corpus real dossiers (Morgan Vance, Alex Rivera) down-scoping & inflation checks -> VERIFIED
 */

const assert = require('assert');
const { TestSuite } = require('../helpers/test-harness');
const { ClaimVerifier, VIOLATION_CODES } = require('../../lib/honest-cv/verify-claims');
const { dossiers } = require('../fixtures/golden-corpus/corpus');

const suite = new TestSuite('Tier 2: Truthful Down-Scoping & Boundary Challenger Suite');

// Targeted evaluation dossier with baseline ground truths matching dispatch prompt
const challengerDossier = {
  candidate: {
    name: 'Morgan Vance',
    currentTitle: 'Principal Platform Architect',
    salaryFloor: { currency: 'USD', minimumBase: 160000, targetTotal: 220000 }
  },
  employers: [
    {
      id: 'emp_horizon',
      name: 'Horizon Systems',
      title: 'Principal Platform Architect',
      startYear: 2021,
      endYear: null,
      isCurrent: true
    },
    {
      id: 'emp_meridian',
      name: 'Meridian Tech',
      title: 'Senior Software Engineer',
      startYear: 2017,
      endYear: 2021,
      isCurrent: false
    },
    {
      id: 'emp_apex',
      name: 'Apex Cloud Technologies',
      title: 'Infrastructure Architect',
      startYear: 2014,
      endYear: 2017,
      isCurrent: false
    }
  ],
  claims: [
    {
      id: 'CLM-01',
      employerId: 'emp_horizon',
      category: 'infrastructure',
      text: 'Maintained 25 Kubernetes clusters and led a team of 12 engineers at Horizon Systems.',
      metrics: ['25 Kubernetes clusters', '25 clusters', '12 engineers'],
      tools: ['Kubernetes', 'Docker', 'Go'],
      role: 'Principal Platform Architect'
    },
    {
      id: 'CLM-02',
      employerId: 'emp_meridian',
      category: 'delivery',
      text: 'Managed 10 client accounts and developed 12 microservices at Meridian Tech.',
      metrics: ['10 client accounts', '10 accounts', '12 microservices'],
      tools: ['Node.js', 'PostgreSQL', 'Go'],
      role: 'Senior Software Engineer'
    },
    {
      id: 'CLM-03',
      employerId: 'emp_apex',
      category: 'performance',
      text: 'Reduced core event latency to 42ms in Go at Apex Cloud Technologies.',
      metrics: ['42ms', '42 milliseconds'],
      tools: ['Go', 'Kafka'],
      role: 'Infrastructure Architect'
    },
    {
      id: 'CLM-04',
      employerId: 'emp_meridian',
      category: 'optimization',
      text: 'Decreased customer onboarding turnaround from 14 days to 4 days at Meridian Tech.',
      metrics: ['from 14 days to 4 days', '14 days', '4 days'],
      tools: ['Node.js'],
      role: 'Senior Software Engineer'
    }
  ],
  skills: {
    languages: ['Go', 'Node.js', 'TypeScript', 'SQL'],
    infrastructure: ['Kubernetes', 'Docker'],
    databases: ['PostgreSQL']
  }
};

// -----------------------------------------------------------------------------
// 1. SCALE UNITS DOWN-SCOPING (Must PASS with zero violations)
// -----------------------------------------------------------------------------
suite.test('Scale Units Down-Scoping: truthful subsets pass with zero violations', (assert) => {
  const downscopedCases = [
    {
      desc: 'Claiming 1 cluster when 25 verified',
      text: 'Operated 1 Kubernetes cluster at Horizon Systems.'
    },
    {
      desc: 'Claiming 8 accounts when 10 verified',
      text: 'Managed 8 client accounts during initial rollout at Meridian Tech.'
    },
    {
      desc: 'Claiming 3 microservices when 12 verified',
      text: 'Architected 3 microservices in Go at Meridian Tech.'
    },
    {
      desc: 'Claiming 5 clusters when 25 verified',
      text: 'Maintained 5 production clusters at Horizon Systems.'
    },
    {
      desc: 'Claiming 2 accounts when 10 verified',
      text: 'Managed 2 client accounts at Meridian Tech.'
    },
    {
      desc: 'Claiming 11 microservices when 12 verified',
      text: 'Engineered 11 microservices at Meridian Tech.'
    }
  ];

  for (const tc of downscopedCases) {
    const res = ClaimVerifier.verifySentence(tc.text, challengerDossier);
    assert.equal(res.passed, true, `Expected PASS for: ${tc.desc} ("${tc.text}"). Got violations: ${JSON.stringify(res.violations)}`);
    assert.equal(res.violations.length, 0, `Expected 0 violations for: ${tc.desc}`);
  }
});

// -----------------------------------------------------------------------------
// 2. SCALE UNITS INFLATION (Must FAIL with METRIC_INFLATION/SCOPE_INFLATION)
// -----------------------------------------------------------------------------
suite.test('Scale Units Inflation: quantities exceeding baseline are blocked', (assert) => {
  const inflatedCases = [
    {
      desc: 'Claiming 26 clusters when 25 verified',
      text: 'Operated 26 Kubernetes clusters at Horizon Systems.'
    },
    {
      desc: 'Claiming 11 accounts when 10 verified',
      text: 'Managed 11 client accounts at Meridian Tech.'
    },
    {
      desc: 'Claiming 13 microservices when 12 verified',
      text: 'Architected 13 microservices at Meridian Tech.'
    },
    {
      desc: 'Claiming 50 clusters when 25 verified',
      text: 'Maintained 50 clusters at Horizon Systems.'
    },
    {
      desc: 'Claiming 20 accounts when 10 verified',
      text: 'Managed 20 accounts at Meridian Tech.'
    }
  ];

  for (const tc of inflatedCases) {
    const res = ClaimVerifier.verifySentence(tc.text, challengerDossier);
    assert.equal(res.passed, false, `Expected FAIL for inflated case: ${tc.desc} ("${tc.text}")`);
    const hasInflation = res.violations.some(v =>
      v.code === VIOLATION_CODES.METRIC_INFLATION || v.code === VIOLATION_CODES.SCOPE_INFLATION
    );
    assert.equal(hasInflation, true, `Must flag METRIC_INFLATION or SCOPE_INFLATION for: ${tc.desc}. Got: ${JSON.stringify(res.violations)}`);
  }
});

// -----------------------------------------------------------------------------
// 3. HEADCOUNT DOWN-SCOPING (Must PASS with zero violations)
// -----------------------------------------------------------------------------
suite.test('Headcount Down-Scoping: truthful team subsets pass with zero violations', (assert) => {
  const headcountDownscoped = [
    {
      desc: 'Claiming 5 engineers when 12 verified',
      text: 'Led a squad of 5 engineers at Horizon Systems.'
    },
    {
      desc: 'Claiming 1 engineer when 12 verified',
      text: 'Mentored 1 engineer at Horizon Systems.'
    },
    {
      desc: 'Claiming 8 engineers when 12 verified',
      text: 'Managed 8 engineers at Horizon Systems.'
    },
    {
      desc: 'Claiming 11 engineers when 12 verified',
      text: 'Directed 11 engineers at Horizon Systems.'
    }
  ];

  for (const tc of headcountDownscoped) {
    const res = ClaimVerifier.verifySentence(tc.text, challengerDossier);
    assert.equal(res.passed, true, `Expected PASS for headcount down-scoping: ${tc.desc} ("${tc.text}"). Got violations: ${JSON.stringify(res.violations)}`);
    assert.equal(res.violations.length, 0, `Expected 0 violations for: ${tc.desc}`);
  }
});

// -----------------------------------------------------------------------------
// 4. HEADCOUNT INFLATION (Must FAIL with SCOPE_INFLATION)
// -----------------------------------------------------------------------------
suite.test('Headcount Inflation: team size exceeding baseline is strictly blocked', (assert) => {
  const headcountInflated = [
    {
      desc: 'Claiming 15 engineers when 12 verified',
      text: 'Led a team of 15 engineers at Horizon Systems.'
    },
    {
      desc: 'Claiming 13 engineers when 12 verified',
      text: 'Managed 13 engineers at Horizon Systems.'
    },
    {
      desc: 'Claiming 25 engineers when 12 verified',
      text: 'Directed 25 engineers at Horizon Systems.'
    }
  ];

  for (const tc of headcountInflated) {
    const res = ClaimVerifier.verifySentence(tc.text, challengerDossier);
    assert.equal(res.passed, false, `Expected FAIL for headcount inflation: ${tc.desc} ("${tc.text}")`);
    const hasScopeInflation = res.violations.some(v => v.code === VIOLATION_CODES.SCOPE_INFLATION);
    assert.equal(hasScopeInflation, true, `Must flag SCOPE_INFLATION for: ${tc.desc}. Got: ${JSON.stringify(res.violations)}`);
  }
});

// -----------------------------------------------------------------------------
// 5. DECIMAL UNIT LATENCY CONVERSION (Must PASS with zero violations)
// -----------------------------------------------------------------------------
suite.test('Decimal Unit Latency: equivalent representations pass with zero violations', (assert) => {
  const latencyValidCases = [
    {
      desc: 'Decimal seconds: 0.042s = 42ms verified',
      text: 'Reduced event latency to 0.042s in Go at Apex Cloud Technologies.'
    },
    {
      desc: 'Standard milliseconds: 42ms',
      text: 'Reduced event latency to 42ms in Go at Apex Cloud Technologies.'
    },
    {
      desc: 'Spelled-out milliseconds: 42 milliseconds',
      text: 'Reduced event latency to 42 milliseconds in Go at Apex Cloud Technologies.'
    },
    {
      desc: 'Decimal seconds with word unit: 0.042 seconds',
      text: 'Reduced event latency to 0.042 seconds in Go at Apex Cloud Technologies.'
    }
  ];

  for (const tc of latencyValidCases) {
    const res = ClaimVerifier.verifySentence(tc.text, challengerDossier);
    assert.equal(res.passed, true, `Expected PASS for latency representation: ${tc.desc} ("${tc.text}"). Got violations: ${JSON.stringify(res.violations)}`);
    assert.equal(res.violations.length, 0, `Expected 0 violations for: ${tc.desc}`);
  }
});

// -----------------------------------------------------------------------------
// 6. LATENCY INFLATION (Must FAIL with METRIC_INFLATION)
// -----------------------------------------------------------------------------
suite.test('Latency Inflation: unverified lower latency claims are strictly blocked', (assert) => {
  const latencyInflatedCases = [
    {
      desc: 'Boundary decimal seconds: 0.041s vs 42ms verified',
      text: 'Reduced event latency to 0.041s in Go at Apex Cloud Technologies.'
    },
    {
      desc: 'Boundary milliseconds: 41ms vs 42ms verified',
      text: 'Reduced event latency to 41ms in Go at Apex Cloud Technologies.'
    },
    {
      desc: 'Boundary spelled-out unit: 41 milliseconds vs 42ms verified',
      text: 'Reduced event latency to 41 milliseconds in Go at Apex Cloud Technologies.'
    },
    {
      desc: 'Severe decimal seconds: 0.010s vs 42ms verified',
      text: 'Reduced event latency to 0.010s in Go at Apex Cloud Technologies.'
    },
    {
      desc: 'Severe milliseconds: 10ms vs 42ms verified',
      text: 'Reduced event latency to 10ms in Go at Apex Cloud Technologies.'
    },
    {
      desc: 'Severe decimal seconds: 0.005s vs 42ms verified',
      text: 'Reduced event latency to 0.005s in Go at Apex Cloud Technologies.'
    }
  ];

  for (const tc of latencyInflatedCases) {
    const res = ClaimVerifier.verifySentence(tc.text, challengerDossier);
    assert.equal(res.passed, false, `Expected FAIL for latency inflation: ${tc.desc} ("${tc.text}")`);
    const hasMetricInflation = res.violations.some(v => v.code === VIOLATION_CODES.METRIC_INFLATION);
    assert.equal(hasMetricInflation, true, `Must flag METRIC_INFLATION for: ${tc.desc}. Got: ${JSON.stringify(res.violations)}`);
  }
});

// -----------------------------------------------------------------------------
// 7. SPELLED-OUT WORD NUMBERS & HYPHENATED COUNTS (Down-scoping vs Inflation)
// -----------------------------------------------------------------------------
suite.test('Spelled-out words and hyphenated counts: down-scoping passes, inflation fails', (assert) => {
  const wordDownscoped = [
    {
      desc: 'Spelled-out: one cluster when 25 verified',
      text: 'Operated one Kubernetes cluster at Horizon Systems.'
    },
    {
      desc: 'Spelled-out: eight accounts when 10 verified',
      text: 'Managed eight client accounts at Meridian Tech.'
    },
    {
      desc: 'Spelled-out: three microservices when 12 verified',
      text: 'Architected three microservices at Meridian Tech.'
    },
    {
      desc: 'Spelled-out: five engineers when 12 verified',
      text: 'Led a squad of five engineers at Horizon Systems.'
    },
    {
      desc: 'Spelled-out: two accounts when 10 verified',
      text: 'Managed two client accounts at Meridian Tech.'
    },
    {
      desc: 'Spelled-out: four microservices when 12 verified',
      text: 'Built four microservices in Go at Meridian Tech.'
    }
  ];

  for (const tc of wordDownscoped) {
    const res = ClaimVerifier.verifySentence(tc.text, challengerDossier);
    assert.equal(res.passed, true, `Expected PASS for word/hyphen down-scoping: ${tc.desc} ("${tc.text}"). Got violations: ${JSON.stringify(res.violations)}`);
    assert.equal(res.violations.length, 0, `Expected 0 violations for: ${tc.desc}`);
  }

  const wordInflated = [
    {
      desc: 'Spelled-out: twenty-six clusters when 25 verified',
      text: 'Operated twenty-six Kubernetes clusters at Horizon Systems.'
    },
    {
      desc: 'Spelled-out: eleven accounts when 10 verified',
      text: 'Managed eleven client accounts at Meridian Tech.'
    },
    {
      desc: 'Spelled-out: fifteen engineers when 12 verified',
      text: 'Led a squad of fifteen engineers at Horizon Systems.'
    }
  ];

  for (const tc of wordInflated) {
    const res = ClaimVerifier.verifySentence(tc.text, challengerDossier);
    assert.equal(res.passed, false, `Expected FAIL for word inflation: ${tc.desc} ("${tc.text}")`);
  }
});

// -----------------------------------------------------------------------------
// 8. COMPLEX COMBINATORIAL SENTENCES (Multi-metric down-scoping vs partial inflation)
// -----------------------------------------------------------------------------
suite.test('Combinatorial multi-metric sentences: all-downscoped passes, partial-inflation fails', (assert) => {
  // Candidate dossier with multi-metric baseline
  const multiDossier = {
    candidate: { name: 'Jordan Rivera' },
    employers: [
      { id: 'emp_1', name: 'Nexus Core', startYear: 2020, endYear: null, isCurrent: true }
    ],
    claims: [
      {
        id: 'CLM-NX-01',
        employerId: 'emp_1',
        category: 'delivery',
        text: 'Maintained 12 microservices across 25 clusters while managing 10 client accounts at Nexus Core.',
        metrics: ['12 microservices', '25 clusters', '10 client accounts'],
        tools: ['Go', 'Kubernetes'],
        role: 'Lead Architect'
      }
    ],
    skills: { languages: ['Go'], infrastructure: ['Kubernetes'] }
  };

  // All 3 metrics down-scoped: 3 microservices, 5 clusters, 4 accounts -> PASS
  const allDownscoped = 'Maintained 3 microservices across 5 clusters while managing 4 client accounts at Nexus Core.';
  const resAll = ClaimVerifier.verifySentence(allDownscoped, multiDossier);
  assert.equal(resAll.passed, true, `All down-scoped metrics must PASS. Got: ${JSON.stringify(resAll.violations)}`);
  assert.equal(resAll.violations.length, 0);

  // Mixed: 3 microservices (down-scoped), 4 accounts (down-scoped), but 26 clusters (INFLATED) -> FAIL
  const partialInflated = 'Maintained 3 microservices across 26 clusters while managing 4 client accounts at Nexus Core.';
  const resPartial = ClaimVerifier.verifySentence(partialInflated, multiDossier);
  assert.equal(resPartial.passed, false, 'Sentence with even one inflated metric must FAIL');
  assert.ok(resPartial.violations.some(v => v.code === VIOLATION_CODES.METRIC_INFLATION || v.code === VIOLATION_CODES.SCOPE_INFLATION));
  // Verify that the detected violation points to 26 clusters
  const clusterViolation = resPartial.violations.find(v => /26/.test(v.detected || v.details || ''));
  assert.ok(clusterViolation, 'Violation must specifically detect the inflated "26 clusters"');
});

// -----------------------------------------------------------------------------
// 9. DURATION NON-SCALE UNIT BOUNDARY (Duration is not a scale unit)
// -----------------------------------------------------------------------------
suite.test('Duration non-scale units: claiming lower duration without backing claim fails', (assert) => {
  // Baseline is 14 days to 4 days turnaround.
  // Claiming 4 days turnaround matches verified baseline -> PASS
  const validDuration = 'Reduced customer onboarding turnaround to 4 days at Meridian Tech.';
  const resValid = ClaimVerifier.verifySentence(validDuration, challengerDossier);
  assert.equal(resValid.passed, true, `Valid baseline duration must PASS. Got: ${JSON.stringify(resValid.violations)}`);

  // Claiming 2 days turnaround (unverified performance leap) -> MUST FAIL (duration does not down-scope!)
  const unverifiedLowerDuration = 'Reduced customer onboarding turnaround to 2 days at Meridian Tech.';
  const resInvalid = ClaimVerifier.verifySentence(unverifiedLowerDuration, challengerDossier);
  assert.equal(resInvalid.passed, false, 'Claiming unverified faster duration (2 days vs 4 days) must FAIL');
});

// -----------------------------------------------------------------------------
// 10. REAL GOLDEN CORPUS DOSSIER DOWN-SCOPING & INFLATION
// -----------------------------------------------------------------------------
suite.test('Golden Corpus Morgan Vance & Alex Rivera: down-scoping passes, inflation fails', (assert) => {
  const morgan = dossiers['morgan-vance'];
  const alex = dossiers['alex-rivera'];

  // Morgan Vance CLM-002: 120+ microservices, 3 availability zones
  // Down-scope to 50 microservices -> PASS
  const morganDownscoped = 'Architected multi-region Kubernetes platform hosting 50 microservices in Go at Apex Cloud Technologies.';
  const resMorganDown = ClaimVerifier.verifySentence(morganDownscoped, morgan);
  assert.equal(resMorganDown.passed, true, `Morgan down-scoped microservices must PASS. Got: ${JSON.stringify(resMorganDown.violations)}`);

  // Morgan Vance CLM-004: 8 senior and staff engineers
  // Down-scope to 4 engineers -> PASS
  const morganMentored = 'Mentored 4 senior engineers at Apex Cloud Technologies.';
  const resMorganMentored = ClaimVerifier.verifySentence(morganMentored, morgan);
  assert.equal(resMorganMentored.passed, true, `Morgan down-scoped headcount must PASS. Got: ${JSON.stringify(resMorganMentored.violations)}`);

  // Morgan Vance CLM-004: inflate to 15 engineers -> FAIL
  const morganInflatedHc = 'Mentored 15 senior engineers at Apex Cloud Technologies.';
  const resMorganInflatedHc = ClaimVerifier.verifySentence(morganInflatedHc, morgan);
  assert.equal(resMorganInflatedHc.passed, false, 'Morgan inflated headcount must FAIL');

  // Alex Rivera ALX-003: 80 storefront templates
  // Down-scope to 20 templates -> PASS
  const alexDownscoped = 'Optimized Core Web Vitals across 20 storefront templates at Oasis Digital Commerce.';
  const resAlexDown = ClaimVerifier.verifySentence(alexDownscoped, alex);
  assert.equal(resAlexDown.passed, true, `Alex down-scoped templates must PASS. Got: ${JSON.stringify(resAlexDown.violations)}`);

  // Alex Rivera ALX-003: inflate to 95 templates -> FAIL
  const alexInflated = 'Optimized Core Web Vitals across 95 storefront templates at Oasis Digital Commerce.';
  const resAlexInflated = ClaimVerifier.verifySentence(alexInflated, alex);
  assert.equal(resAlexInflated.passed, false, 'Alex inflated templates must FAIL');
});

// -----------------------------------------------------------------------------
// 11. FULL DRAFT DOCUMENT INTERFACE (ClaimVerifier.verifyDraft)
// -----------------------------------------------------------------------------
suite.test('Full Draft Verification: clean down-scoped document passes, inflated document fails', (assert) => {
  const cleanDownscopedDraft = `
Jordan Rivera — Lead Infrastructure Architect

Professional Experience:
Horizon Systems (2021 - Present)
- Operated 1 Kubernetes cluster in Go at Horizon Systems.
- Led a squad of 5 engineers delivering core infrastructure.

Meridian Tech (2017 - 2021)
- Managed 8 client accounts during initial rollout at Meridian Tech.
- Architected 3 microservices in Node.js and PostgreSQL.

Apex Cloud Technologies (2014 - 2017)
- Reduced event latency to 0.042s in Go at Apex Cloud Technologies.
  `;

  const cleanResult = ClaimVerifier.verifyDraft(challengerDossier, cleanDownscopedDraft);
  assert.equal(cleanResult.passed, true, `Full clean down-scoped draft must PASS. Violations: ${JSON.stringify(cleanResult.violations)}`);
  assert.equal(cleanResult.violations.length, 0);

  const inflatedDraft = `
Jordan Rivera — Lead Infrastructure Architect

Professional Experience:
Horizon Systems (2021 - Present)
- Operated 26 Kubernetes clusters at Horizon Systems.
- Led a squad of 15 engineers delivering core infrastructure.
  `;

  const inflatedResult = ClaimVerifier.verifyDraft(challengerDossier, inflatedDraft);
  assert.equal(inflatedResult.passed, false, 'Draft with inflated metrics must FAIL');
  assert.ok(inflatedResult.violations.length >= 2, 'Must report violations for both 26 clusters and 15 engineers');
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
