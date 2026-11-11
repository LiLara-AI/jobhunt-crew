'use strict';
/**
 * Tier 2: Boundary & Corner Cases — Lead Probe Held-Out Verifier Evaluation Suite
 *
 * Permanent, rigorous held-out test suite authoring for Milestone M3.
 * Evaluates the 5 failure categories identified by the Lead Agent:
 * 1. Generic count inflation (projects, deliverables, sites, clients, clusters, accounts, years, days, hours, etc.)
 * 2. Numbers written as words in non-team noun phrases / "<number> million dollar ..."
 * 3. Changed before/after values ("from X to Y" with altered X or Y)
 * 4. Unsupported tools/skills not in dossier skills or claims
 * 5. Title inflation (claiming senior/executive titles at real employers not listed in employer titles)
 *
 * Requirements:
 * - At least 15 fabricated test cases across the 5 categories (all must be caught, passed: false)
 * - At least 8 clean controls with verified facts (all must pass, passed: true, 0 violations)
 * - Exits 0 if all assertions hold; exits 1 if any failure occurs.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const { TestSuite } = require('../helpers/test-harness');
const { verifyDraftAgainstDossier, ClaimVerifier, VIOLATION_CODES } = require('../../lib/honest-cv/verify-claims');

const suite = new TestSuite('Tier 2: Lead Agent Held-Out Verifier Evaluation Suite');

// Self-contained reference candidate dossier with ground-truth verified claims
const leadProbeDossier = {
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

// -----------------------------------------------------------------------------
// TEST CASES: 24 Fabricated Probes across the 5 Lead Agent Failure Categories
// -----------------------------------------------------------------------------
const FABRICATED_PROBES = [
  // --- Category 1: Generic count inflation (5 cases) ---
  {
    id: 'cat1-inflated-projects',
    category: 1,
    categoryName: 'Generic count inflation',
    text: 'Delivered 25 client projects at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated projects count (25 projects claimed vs 10 verified)'
  },
  {
    id: 'cat1-inflated-accounts',
    category: 1,
    categoryName: 'Generic count inflation',
    text: 'Managed 50 enterprise client accounts at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated client accounts count (50 accounts claimed vs 15 verified)'
  },
  {
    id: 'cat1-inflated-sites',
    category: 1,
    categoryName: 'Generic count inflation',
    text: 'Deployed infrastructure across 12 data center sites at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated sites count (12 data center sites claimed vs 4 verified)'
  },
  {
    id: 'cat1-inflated-clusters',
    category: 1,
    categoryName: 'Generic count inflation',
    text: 'Operated and maintained 80 production clusters at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated clusters count (80 clusters claimed vs 25 verified)'
  },
  {
    id: 'cat1-inflated-sla-hours',
    category: 1,
    categoryName: 'Generic count inflation',
    text: 'Enforced 72 hours critical incident resolution SLA across core services at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Inflated/altered SLA duration (72 hours claimed vs 6 hours verified)'
  },

  // --- Category 2: Numbers written as words in non-team noun phrases (4 cases) ---
  {
    id: 'cat2-word-count-deliverables',
    category: 2,
    categoryName: 'Numbers written as words in generic phrases',
    text: 'Delivered thirty-five major client deliverables at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Spelled-out number count inflation (thirty-five = 35 deliverables vs 10 verified)'
  },
  {
    id: 'cat2-word-pipeline-currency',
    category: 2,
    categoryName: 'Numbers written as words in generic phrases',
    text: 'Managed a twelve million dollar pipeline at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Spelled-out currency inflation (twelve million dollar = $12M vs $3M verified budget)'
  },
  {
    id: 'cat2-word-clusters',
    category: 2,
    categoryName: 'Numbers written as words in generic phrases',
    text: 'Deployed applications across forty-five production clusters at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Spelled-out cluster count inflation (forty-five = 45 clusters vs 25 verified)'
  },
  {
    id: 'cat2-word-sites',
    category: 2,
    categoryName: 'Numbers written as words in generic phrases',
    text: 'Expanded cloud operations across eight regional sites at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Spelled-out site count inflation (eight = 8 sites vs 4 verified)'
  },

  // --- Category 3: Changed before/after values (5 cases) ---
  {
    id: 'cat3-changed-after-days',
    category: 3,
    categoryName: 'Changed before/after values',
    text: 'Reduced customer onboarding turnaround from 14 days to 1 day at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Altered end value in turnaround reduction (from 14 days to 1 day vs verified 4 days)'
  },
  {
    id: 'cat3-changed-before-days',
    category: 3,
    categoryName: 'Changed before/after values',
    text: 'Reduced customer onboarding turnaround from 30 days to 4 days at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Altered starting value in turnaround reduction (from 30 days to 4 days vs verified 14 days)'
  },
  {
    id: 'cat3-changed-after-pct',
    category: 3,
    categoryName: 'Changed before/after values',
    text: 'Decreased deployment failure rate from 35% to 1% at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Altered end percentage in failure rate reduction (from 35% to 1% vs verified 5%)'
  },
  {
    id: 'cat3-changed-before-pct',
    category: 3,
    categoryName: 'Changed before/after values',
    text: 'Decreased deployment failure rate from 60% to 5% at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Altered starting percentage in failure rate reduction (from 60% to 5% vs verified 35%)'
  },
  {
    id: 'cat3-changed-after-latency',
    category: 3,
    categoryName: 'Changed before/after values',
    text: 'Reduced cache synchronization latency from 250ms to 15ms at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Altered end latency in reduction (from 250ms to 15ms vs verified 45ms)'
  },

  // --- Category 4: Unsupported tools and skills (6 cases) ---
  {
    id: 'cat4-unsupported-haskell',
    category: 4,
    categoryName: 'Unsupported tools/skills',
    text: 'Built distributed streaming microservices using Haskell at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL, 'UNVERIFIED_TECHNOLOGY'],
    description: 'Technology Haskell is not documented in candidate dossier skills or claims'
  },
  {
    id: 'cat4-unsupported-elixir',
    category: 4,
    categoryName: 'Unsupported tools/skills',
    text: 'Architected resilient real-time telecommunications gateway using Elixir and Phoenix at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL, 'UNVERIFIED_TECHNOLOGY'],
    description: 'Technologies Elixir/Phoenix are not documented in candidate dossier'
  },
  {
    id: 'cat4-unsupported-cassandra',
    category: 4,
    categoryName: 'Unsupported tools/skills',
    text: 'Migrated analytics storage layer to Cassandra distributed database at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL, 'UNVERIFIED_TECHNOLOGY'],
    description: 'Database Cassandra is not documented in candidate dossier'
  },
  {
    id: 'cat4-unsupported-salesforce',
    category: 4,
    categoryName: 'Unsupported tools/skills',
    text: 'Integrated customer billing platform with Salesforce CRM at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL, 'UNVERIFIED_TECHNOLOGY'],
    description: 'Platform Salesforce is not documented in candidate dossier'
  },
  {
    id: 'cat4-unsupported-graphql',
    category: 4,
    categoryName: 'Unsupported tools/skills',
    text: 'Developed customer-facing API federation gateway using GraphQL at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL, 'UNVERIFIED_TECHNOLOGY'],
    description: 'API technology GraphQL is not documented in candidate dossier'
  },
  {
    id: 'cat4-unsupported-cockroachdb',
    category: 4,
    categoryName: 'Unsupported tools/skills',
    text: 'Implemented globally distributed relational storage using CockroachDB at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL, 'UNVERIFIED_TECHNOLOGY'],
    description: 'Database CockroachDB is not documented in candidate dossier'
  },

  // --- Category 5: Title inflation (4 cases) ---
  {
    id: 'cat5-inflated-vp',
    category: 5,
    categoryName: 'Title inflation',
    text: 'As VP of Engineering at Meridian Tech, I directed the engineering organization.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.SCOPE_INFLATION, 'ROLE_INFLATION', 'TITLE_INFLATION'],
    description: 'Claiming unverified executive title (VP of Engineering vs verified Senior Software Engineer)'
  },
  {
    id: 'cat5-inflated-head',
    category: 5,
    categoryName: 'Title inflation',
    text: 'As Head of Infrastructure at Horizon Systems, I led company-wide operations.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.SCOPE_INFLATION, 'ROLE_INFLATION', 'TITLE_INFLATION'],
    description: 'Claiming unverified leadership title (Head of Infrastructure vs verified Lead Infrastructure Architect)'
  },
  {
    id: 'cat5-inflated-director',
    category: 5,
    categoryName: 'Title inflation',
    text: 'Served as Director of Software Engineering at Meridian Tech overseeing all squads.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.SCOPE_INFLATION, 'ROLE_INFLATION', 'TITLE_INFLATION'],
    description: 'Claiming unverified title (Director of Software Engineering vs verified Senior Software Engineer)'
  },
  {
    id: 'cat5-inflated-chief-architect',
    category: 5,
    categoryName: 'Title inflation',
    text: 'Acted as Chief Enterprise Architect at Horizon Systems guiding technical strategy.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.SCOPE_INFLATION, 'ROLE_INFLATION', 'TITLE_INFLATION'],
    description: 'Claiming unverified executive title (Chief Enterprise Architect vs verified Lead Infrastructure Architect)'
  }
];

// -----------------------------------------------------------------------------
// TEST CASES: 15 Clean Controls with Verified Facts (Zero False Blocks Target)
// -----------------------------------------------------------------------------
const CLEAN_CONTROLS = [
  // --- Category 1 Controls (Exact verified counts) ---
  {
    id: 'clean-cat1-exact-projects',
    category: 1,
    text: 'Delivered 10 enterprise software projects at Meridian Tech.',
    expectedPass: true,
    description: 'Exact truthful restatement of verified 10 enterprise software projects'
  },
  {
    id: 'clean-cat1-exact-accounts',
    category: 1,
    text: 'Managed 15 key client accounts at Meridian Tech.',
    expectedPass: true,
    description: 'Exact truthful restatement of verified 15 key client accounts'
  },
  {
    id: 'clean-cat1-exact-clusters',
    category: 1,
    text: 'Maintained 25 production Kubernetes clusters at Horizon Systems.',
    expectedPass: true,
    description: 'Exact truthful restatement of verified 25 production Kubernetes clusters'
  },
  {
    id: 'clean-cat1-exact-sites',
    category: 1,
    text: 'Deployed infrastructure across 4 data center sites at Horizon Systems.',
    expectedPass: true,
    description: 'Exact truthful restatement of verified 4 data center sites'
  },

  // --- Category 2 Controls (Spelled-out numbers matching verified facts) ---
  {
    id: 'clean-cat2-word-exact-projects',
    category: 2,
    text: 'Delivered ten enterprise software projects at Meridian Tech.',
    expectedPass: true,
    description: 'Truthful statement with spelled-out number (ten = 10 projects verified)'
  },
  {
    id: 'clean-cat2-word-exact-budget',
    category: 2,
    text: 'Managed a three million dollar annual infrastructure budget at Horizon Systems.',
    expectedPass: true,
    description: 'Truthful statement with spelled-out currency (three million dollar = $3M verified)'
  },
  {
    id: 'clean-cat2-word-exact-sites',
    category: 2,
    text: 'Deployed infrastructure across four data center sites at Horizon Systems.',
    expectedPass: true,
    description: 'Truthful statement with spelled-out number (four = 4 sites verified)'
  },

  // --- Category 3 Controls (Exact verified before/after numbers) ---
  {
    id: 'clean-cat3-exact-before-after-days',
    category: 3,
    text: 'Reduced customer onboarding turnaround from 14 days to 4 days at Meridian Tech.',
    expectedPass: true,
    description: 'Exact truthful restatement of turnaround reduction from 14 days to 4 days'
  },
  {
    id: 'clean-cat3-exact-before-after-pct',
    category: 3,
    text: 'Decreased deployment failure rate from 35% to 5% at Horizon Systems.',
    expectedPass: true,
    description: 'Exact truthful restatement of failure rate decrease from 35% to 5%'
  },
  {
    id: 'clean-cat3-exact-before-after-latency',
    category: 3,
    text: 'Reduced cache synchronization latency from 250ms to 45ms at Horizon Systems.',
    expectedPass: true,
    description: 'Exact truthful restatement of latency reduction from 250ms to 45ms'
  },

  // --- Category 4 Controls (Fully supported tools and skills) ---
  {
    id: 'clean-cat4-supported-go-kafka',
    category: 4,
    text: 'Built event streaming pipeline in Go using Kafka at Horizon Systems.',
    expectedPass: true,
    description: 'Truthful statement with verified tools Go and Kafka present in dossier'
  },
  {
    id: 'clean-cat4-supported-typescript',
    category: 4,
    text: 'Developed backend microservices using TypeScript and Node.js at Meridian Tech.',
    expectedPass: true,
    description: 'Truthful statement with verified tools TypeScript and Node.js in dossier'
  },
  {
    id: 'clean-cat4-supported-terraform-aws',
    category: 4,
    text: 'Provisioned cloud infrastructure on AWS using Terraform at Horizon Systems.',
    expectedPass: true,
    description: 'Truthful statement with verified infrastructure AWS and Terraform in dossier'
  },

  // --- Category 5 Controls (Exact verified titles) ---
  {
    id: 'clean-cat5-exact-title-meridian',
    category: 5,
    text: 'As Senior Software Engineer at Meridian Tech, delivered key services.',
    expectedPass: true,
    description: 'Exact truthful statement citing verified employer title Senior Software Engineer'
  },
  {
    id: 'clean-cat5-exact-title-horizon',
    category: 5,
    text: 'Served as Lead Infrastructure Architect at Horizon Systems managing cloud platforms.',
    expectedPass: true,
    description: 'Exact truthful statement citing verified employer title Lead Infrastructure Architect'
  }
];

// -----------------------------------------------------------------------------
// TEST SUITE DEFINITIONS
// -----------------------------------------------------------------------------

suite.test('All 24 fabricated probes across the 5 categories must be caught (passed: false)', assert => {
  assert.ok(FABRICATED_PROBES.length >= 15, `Must have at least 15 fabricated test cases, got: ${FABRICATED_PROBES.length}`);

  // Ensure all 5 categories have at least 2 test cases
  for (let cat = 1; cat <= 5; cat++) {
    const casesInCat = FABRICATED_PROBES.filter(c => c.category === cat);
    assert.ok(casesInCat.length >= 2, `Category ${cat} must have at least 2 test cases, got ${casesInCat.length}`);
  }

  const failures = [];
  for (const probe of FABRICATED_PROBES) {
    const res = ClaimVerifier.verifySentence(probe.text, leadProbeDossier);
    if (res.passed) {
      failures.push({
        id: probe.id,
        category: probe.category,
        text: probe.text,
        description: probe.description,
        reason: 'Expected passed=false, but ClaimVerifier returned passed=true'
      });
      continue;
    }

    if (!res.violations || res.violations.length === 0) {
      failures.push({
        id: probe.id,
        category: probe.category,
        text: probe.text,
        reason: 'Reported passed=false but returned 0 violation records'
      });
      continue;
    }

    const matchedExpectedCode = res.violations.some(v => probe.expectedCodes.includes(v.code));
    if (!matchedExpectedCode) {
      failures.push({
        id: probe.id,
        category: probe.category,
        text: probe.text,
        reason: `Violation codes [${res.violations.map(v => v.code).join(', ')}] did not match any of [${probe.expectedCodes.join(', ')}]`
      });
    }
  }

  assert.equal(
    failures.length,
    0,
    `${failures.length} fabricated probe(s) failed verification:\n` +
      failures.map(f => `  - [Cat ${f.category}] ${f.id}: ${f.reason} (text: "${f.text}")`).join('\n')
  );
});

suite.test('All 15 clean controls must pass with zero violations (passed: true, 0 violations)', assert => {
  assert.ok(CLEAN_CONTROLS.length >= 8, `Must have at least 8 clean controls, got: ${CLEAN_CONTROLS.length}`);

  const falseBlocks = [];
  for (const control of CLEAN_CONTROLS) {
    const res = ClaimVerifier.verifySentence(control.text, leadProbeDossier);
    if (!res.passed || (res.violations && res.violations.length > 0)) {
      falseBlocks.push({
        id: control.id,
        category: control.category,
        text: control.text,
        violations: res.violations
      });
    }
  }

  assert.equal(
    falseBlocks.length,
    0,
    `${falseBlocks.length} clean control(s) were falsely blocked:\n` +
      falseBlocks.map(b => `  - [Cat ${b.category}] ${b.id}: violations=${JSON.stringify(b.violations)} (text: "${b.text}")`).join('\n')
  );
});

suite.test('All test cases execute consistently through ClaimVerifier.verifyDraft document interface', assert => {
  for (const probe of FABRICATED_PROBES) {
    const draftRes = ClaimVerifier.verifyDraft(leadProbeDossier, probe.text);
    assert.equal(
      draftRes.passed,
      false,
      `verifyDraft must reject fabrication "${probe.id}": "${probe.text}"`
    );
    assert.ok(
      draftRes.violations.length > 0,
      `verifyDraft must produce violation records for "${probe.id}"`
    );
  }

  for (const control of CLEAN_CONTROLS) {
    const draftRes = ClaimVerifier.verifyDraft(leadProbeDossier, control.text);
    assert.equal(
      draftRes.passed,
      true,
      `verifyDraft must pass clean control "${control.id}": "${control.text}", got violations: ${JSON.stringify(draftRes.violations)}`
    );
    assert.equal(
      draftRes.violations.length,
      0,
      `verifyDraft must have 0 violations for clean control "${control.id}"`
    );
  }
});

suite.test('Top-level verifyDraftAgainstDossier helper handles both string and case object formats', assert => {
  // Test with string input
  const cleanStrRes = verifyDraftAgainstDossier(leadProbeDossier, CLEAN_CONTROLS[0].text);
  assert.equal(cleanStrRes.passed, true, 'String clean input must pass');

  // Test with object draftText input
  const fabObjRes = verifyDraftAgainstDossier(leadProbeDossier, { draftText: FABRICATED_PROBES[0].text });
  assert.equal(fabObjRes.passed, false, 'Object fabrication input must fail');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(stats => {
    process.exit(stats.failed === 0 ? 0 : 1);
  });
}
