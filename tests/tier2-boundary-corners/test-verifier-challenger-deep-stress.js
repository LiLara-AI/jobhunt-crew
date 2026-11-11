'use strict';
/**
 * JobHunt Crew — Tier 2: Adversarial Challenger Empirical Stress Suite
 * Author: challenger_m3_r4_1 (Empirical Challenger)
 * Location: tests/tier2-boundary-corner/test-verifier-challenger-deep-stress.js
 *
 * Empirical adversarial stress testing across all 5 failure categories:
 * 1. Generic count inflation (projects, deliverables, clusters, accounts, SLA hours)
 * 2. Word numbers across generic noun phrases
 * 3. Comparative before/after alterations ("from X to Y", "to Y from X")
 * 4. Novel unsupported tools (ScyllaDB, ClickHouse, FastAPI, Vue, Django, Haskell, Salesforce, etc.)
 * 5. Title inflation at real employers
 */

const { TestSuite } = require('../helpers/test-harness');
const { verifyDraftAgainstDossier, ClaimVerifier, VIOLATION_CODES } = require('../../lib/honest-cv/verify-claims');

const suite = new TestSuite('Tier 2: Adversarial Challenger Empirical Stress Suite');

// Ground-truth candidate dossier (matches leadProbeDossier)
const referenceDossier = {
  candidate: {
    name: 'Jordan Rivera',
    currentTitle: 'Lead Infrastructure Architect',
    salaryFloor: { currency: 'USD', minimumBase: 160000, targetTotal: 220000 }
  },
  employers: [
    {
      id: 'emp_meridian',
      name: 'Meridian Tech',
      isCurrent: false,
      title: 'Senior Software Engineer',
      startYear: 2017,
      endYear: 2021
    },
    {
      id: 'emp_horizon',
      name: 'Horizon Systems',
      isCurrent: true,
      title: 'Lead Infrastructure Architect',
      startYear: 2021,
      endYear: null
    }
  ],
  claims: [
    {
      id: 'CLM-MD-01',
      employerId: 'emp_meridian',
      category: 'delivery',
      text: 'Delivered 10 enterprise software projects and managed 15 key client accounts at Meridian Tech.',
      metrics: ['10 enterprise software projects', '15 key client accounts', '10 projects', '15 accounts'],
      tools: ['TypeScript', 'Node.js', 'PostgreSQL'],
      role: 'Senior Software Engineer'
    },
    {
      id: 'CLM-MD-02',
      employerId: 'emp_meridian',
      category: 'optimization',
      text: 'Reduced customer onboarding turnaround from 14 days to 4 days at Meridian Tech.',
      metrics: ['from 14 days to 4 days', '14 days', '4 days'],
      tools: ['Node.js', 'PostgreSQL'],
      role: 'Senior Software Engineer'
    },
    {
      id: 'CLM-HZ-01',
      employerId: 'emp_horizon',
      category: 'infrastructure',
      text: 'Operated and maintained 25 production Kubernetes clusters deployed across 4 data center sites at Horizon Systems.',
      metrics: ['25 production Kubernetes clusters', '4 data center sites', '25 clusters', '4 sites'],
      tools: ['Kubernetes', 'Docker', 'AWS', 'Terraform'],
      role: 'Lead Infrastructure Architect'
    },
    {
      id: 'CLM-HZ-02',
      employerId: 'emp_horizon',
      category: 'budget',
      text: 'Managed a $3 million annual infrastructure budget and maintained cloud platforms at Horizon Systems.',
      metrics: ['$3 million', '$3,000,000', '3 million dollars'],
      tools: ['AWS', 'Terraform', 'Prometheus'],
      role: 'Lead Infrastructure Architect'
    },
    {
      id: 'CLM-HZ-03',
      employerId: 'emp_horizon',
      category: 'reliability',
      text: 'Decreased deployment failure rate from 35% to 5% and reduced cache synchronization latency from 250ms to 45ms at Horizon Systems.',
      metrics: ['from 35% to 5%', '35%', '5%', 'from 250ms to 45ms', '250ms', '45ms'],
      tools: ['Redis', 'Kafka', 'Go'],
      role: 'Lead Infrastructure Architect'
    },
    {
      id: 'CLM-HZ-04',
      employerId: 'emp_horizon',
      category: 'operations',
      text: 'Enforced 6 hours critical incident resolution SLA across core services at Horizon Systems.',
      metrics: ['6 hours SLA', '6 hours'],
      tools: ['Prometheus', 'Grafana'],
      role: 'Lead Infrastructure Architect'
    }
  ],
  skills: {
    languages: ['TypeScript', 'JavaScript', 'Go', 'Python', 'SQL'],
    frameworks: ['Node.js', 'Express', 'React'],
    infrastructure: ['AWS', 'Kubernetes', 'Docker', 'Terraform'],
    databases: ['PostgreSQL', 'Redis'],
    architecturalDomains: ['Distributed Systems', 'Event-Driven Architecture', 'Cloud Infrastructure']
  },
  degrees: [
    {
      degree: 'B.Sc. in Computer Science',
      institution: 'University of Washington',
      year: 2016
    }
  ],
  certifications: [
    {
      name: 'AWS Certified Solutions Architect',
      issuer: 'Amazon Web Services',
      year: 2020
    }
  ]
};

// ============================================================================
// 1. ADVERSARIAL STRESS VERIFICATION (Fixed in Iteration 5)
// ============================================================================

suite.test('Adversarial Verification 1 (Cat 4): Django & MongoDB are caught and do not collide with Go', (assert) => {
  const djangoRes = ClaimVerifier.verifySentence('Developed internal back-office applications using Django at Meridian Tech.', referenceDossier);
  const mongoRes = ClaimVerifier.verifySentence('Stored application state in MongoDB at Meridian Tech.', referenceDossier);

  assert.equal(djangoRes.passed, false, 'Django must be caught as unsupported tool');
  assert.ok(
    djangoRes.violations.some(v => v.code === VIOLATION_CODES.UNSUPPORTED_TOOL && v.tool === 'django'),
    'Must report UNSUPPORTED_TOOL for Django'
  );

  assert.equal(mongoRes.passed, false, 'MongoDB must be caught as unsupported tool');
  assert.ok(
    mongoRes.violations.some(v => v.code === VIOLATION_CODES.UNSUPPORTED_TOOL && v.tool === 'mongodb'),
    'Must report UNSUPPORTED_TOOL for MongoDB'
  );
});

suite.test('Adversarial Verification 2 (Cat 5): Title inflation variants are caught across prefixes and fronted titles', (assert) => {
  const titleProbes = [
    { text: 'Promoted to VP of Engineering at Meridian Tech.', title: 'VP of Engineering', employer: 'Meridian Tech' },
    { text: 'VP of Engineering at Meridian Tech, directing platform strategy.', title: 'VP of Engineering', employer: 'Meridian Tech' },
    { text: 'Promoted to Head of Engineering at Meridian Tech.', title: 'Head of Engineering', employer: 'Meridian Tech' },
    { text: 'Head of Engineering at Meridian Tech, leading all teams.', title: 'Head of Engineering', employer: 'Meridian Tech' },
    { text: 'I was VP of Engineering at Meridian Tech.', title: 'VP of Engineering', employer: 'Meridian Tech' }
  ];

  for (const p of titleProbes) {
    const res = ClaimVerifier.verifySentence(p.text, referenceDossier);
    assert.equal(res.passed, false, `Title inflation probe must be caught: "${p.text}"`);
    assert.ok(
      res.violations.some(v => v.code === VIOLATION_CODES.SCOPE_INFLATION || v.code === VIOLATION_CODES.TITLE_INFLATION),
      `Must report title/scope inflation for "${p.text}"`
    );
  }
});

suite.test('Adversarial Verification 3 (Cat 1 & 2): Hyphenated counts are recognized and verified', (assert) => {
  const hyphenProbes = [
    'Enforced 48-hour SLA at Horizon Systems.',
    'Delivered 30-deliverable program at Meridian Tech.',
    'Managed an 80-account client portfolio at Meridian Tech.',
    'Maintained a 50-cluster Kubernetes infrastructure at Horizon Systems.'
  ];

  for (const text of hyphenProbes) {
    const res = ClaimVerifier.verifySentence(text, referenceDossier);
    assert.equal(res.passed, false, `Hyphenated count probe must be caught: "${text}"`);
    assert.ok(
      res.violations.some(v => v.code === VIOLATION_CODES.METRIC_INFLATION || v.code === VIOLATION_CODES.SCOPE_INFLATION),
      `Must report metric or scope inflation for "${text}"`
    );
  }
});

suite.test('Adversarial Verification 4 (Cat 3): Comparative alterations with adverb qualifiers are caught', (assert) => {
  const compProbes = [
    'Cut turnaround from 14 days down to just 1 day at Meridian Tech.',
    'Cut turnaround from 14 days to under 2 days at Meridian Tech.'
  ];

  for (const text of compProbes) {
    const res = ClaimVerifier.verifySentence(text, referenceDossier);
    assert.equal(res.passed, false, `Comparative alteration probe must be caught: "${text}"`);
    assert.ok(
      res.violations.some(v => v.code === VIOLATION_CODES.METRIC_INFLATION || v.code === VIOLATION_CODES.UNTAGGED_METRIC),
      `Must report metric inflation for "${text}"`
    );
  }
});

// ============================================================================
// 2. ADVERSARIAL CASES CURRENTLY CAUGHT (Baseline robustness checks)
// ============================================================================

suite.test('Baseline Robustness: Standard adversarial fabrications are caught', (assert) => {
  const caughtProbes = [
    { cat: 1, text: 'Delivered 30 enterprise deliverables at Meridian Tech.' },
    { cat: 1, text: 'Managed 80 client accounts at Meridian Tech.' },
    { cat: 1, text: 'Maintained 50 production clusters at Horizon Systems.' },
    { cat: 1, text: 'Enforced 48 hours incident resolution SLA at Horizon Systems.' },
    { cat: 2, text: 'Managed seventy client accounts at Meridian Tech.' },
    { cat: 2, text: 'Delivered thirty deliverables across key clients at Meridian Tech.' },
    { cat: 2, text: 'Maintained fifty clusters in production at Horizon Systems.' },
    { cat: 2, text: 'Enforced twenty-four hours SLA at Horizon Systems.' },
    { cat: 3, text: 'Reduced latency from 180ms to 20ms at Horizon Systems.' },
    { cat: 3, text: 'Cut customer onboarding turnaround from 14 days to 1 day at Meridian Tech.' },
    { cat: 3, text: 'Decreased deployment failure rate from 35% to 1% at Horizon Systems.' },
    { cat: 4, text: 'Built high-throughput distributed caching using ScyllaDB at Horizon Systems.' },
    { cat: 4, text: 'Aggregated real-time analytics events in ClickHouse at Horizon Systems.' },
    { cat: 4, text: 'Implemented microservice endpoints using FastAPI at Meridian Tech.' },
    { cat: 4, text: 'Built customer onboarding frontend with Vue at Meridian Tech.' },
    { cat: 4, text: 'Engineered mission-critical microservices in Haskell at Horizon Systems.' },
    { cat: 4, text: 'Synchronized customer accounts with Salesforce at Meridian Tech.' },
    { cat: 5, text: 'Served as VP of Cloud at Horizon Systems leading enterprise infrastructure.' },
    { cat: 5, text: 'Worked as Head of Engineering at Meridian Tech overseeing all technical teams.' },
    { cat: 5, text: 'Appointed as Chief Technology Officer at Meridian Tech directing company vision.' }
  ];

  for (const p of caughtProbes) {
    const res = ClaimVerifier.verifySentence(p.text, referenceDossier);
    assert.equal(res.passed, false, `Expected probe to be caught: "${p.text}"`);
  }
});

// ============================================================================
// 3. CLEAN CONTROLS VERIFICATION (Ensure zero false blocks)
// ============================================================================

suite.test('Clean Controls: Verified facts and truthful down-scoping pass with zero violations', (assert) => {
  const cleanControls = [
    'Delivered 10 enterprise software projects at Meridian Tech.',
    'Managed 15 key client accounts at Meridian Tech.',
    'Maintained 25 production Kubernetes clusters at Horizon Systems.',
    'Deployed infrastructure across 4 data center sites at Horizon Systems.',
    'Enforced 6 hours critical incident resolution SLA at Horizon Systems.',
    'Managed 8 client accounts during my initial tenure at Meridian Tech.',
    'Maintained 15 production Kubernetes clusters during platform expansion at Horizon Systems.',
    'Delivered ten enterprise software projects at Meridian Tech.',
    'Managed fifteen key client accounts at Meridian Tech.',
    'Operated twenty-five production Kubernetes clusters at Horizon Systems.',
    'Managed a three million dollar annual infrastructure budget at Horizon Systems.',
    'Reduced customer onboarding turnaround from 14 days to 4 days at Meridian Tech.',
    'Decreased deployment failure rate from 35% to 5% at Horizon Systems.',
    'Reduced cache synchronization latency from 250ms to 45ms at Horizon Systems.',
    'Developed scalable backend services in TypeScript and Node.js at Meridian Tech.',
    'Built event streaming pipelines using Go and Kafka at Horizon Systems.',
    'Served as Senior Software Engineer at Meridian Tech developing backend services.',
    'Served as Lead Infrastructure Architect at Horizon Systems overseeing cloud platforms.'
  ];

  for (const text of cleanControls) {
    const res = ClaimVerifier.verifySentence(text, referenceDossier);
    assert.equal(res.passed, true, `Clean control must pass: "${text}". Got violations: ${JSON.stringify(res.violations)}`);
    assert.equal(res.violations.length, 0, `Clean control must have 0 violations: "${text}"`);
  }
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

suite.referenceDossier = referenceDossier;
module.exports = suite;
