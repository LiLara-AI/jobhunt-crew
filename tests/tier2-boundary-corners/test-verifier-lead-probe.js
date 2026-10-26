'use strict';
/**
 * Tier 2: Boundary & Corner Cases — Lead Probe Held-Out Verifier Evaluation Suite
 *
 * Permanent, rigorous held-out test suite evaluating the failure categories
 * identified by the Lead Agent and Explorer Investigation:
 * 1. Multi-word noun phrase count inflation (digits and normalized number words).
 * 2. Universal Numeric Token Verification (every quantity must equal verified baseline for employer).
 * 3. Unsupported workflow orchestrators and programming languages absent from dossier.
 * 4. Technical version/standard masking (OAuth 2.0, HTTP/2, Layer 7, ISO 27001, SHA-256, ARM64, ordinals, dates).
 * 5. Changed comparative before/after values and title inflation.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const { TestSuite } = require('../helpers/test-harness');
const { verifyDraftAgainstDossier, ClaimVerifier, VIOLATION_CODES } = require('../../lib/honest-cv/verify-claims');

const suite = new TestSuite('Tier 2: Lead Agent Held-Out Verifier Evaluation Suite');

// Reference candidate dossier with ground-truth verified claims and skills
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
// TEST CASES: Fabricated Probes across all Target Categories
// -----------------------------------------------------------------------------
const FABRICATED_PROBES = [
  // --- Category 1: Multi-word noun phrase count inflation (digits) ---
  {
    id: 'cat1-inflated-ai-ml-projects',
    category: 1,
    categoryName: 'Multi-word count inflation (digits)',
    text: 'Delivered 15 AI and machine learning projects at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated count of multi-word phrase with conjunction (15 projects vs 10 verified)'
  },
  {
    id: 'cat1-inflated-large-scale-projects',
    category: 1,
    categoryName: 'Multi-word count inflation (digits)',
    text: 'Delivered 15 large scale distributed systems projects at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated count with technical modifier words (15 projects vs 10 verified)'
  },
  {
    id: 'cat1-inflated-projects-plain',
    category: 1,
    categoryName: 'Multi-word count inflation (digits)',
    text: 'Delivered 25 client projects at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated projects count (25 projects claimed vs 10 verified)'
  },
  {
    id: 'cat1-inflated-accounts',
    category: 1,
    categoryName: 'Multi-word count inflation (digits)',
    text: 'Managed 50 enterprise client accounts at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated client accounts count (50 accounts claimed vs 15 verified)'
  },
  {
    id: 'cat1-inflated-sites',
    category: 1,
    categoryName: 'Multi-word count inflation (digits)',
    text: 'Deployed infrastructure across 12 data center sites at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated sites count (12 data center sites claimed vs 4 verified)'
  },
  {
    id: 'cat1-inflated-clusters',
    category: 1,
    categoryName: 'Multi-word count inflation (digits)',
    text: 'Operated and maintained 80 production clusters at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated clusters count (80 clusters claimed vs 25 verified)'
  },
  {
    id: 'cat1-inflated-sla-hours',
    category: 1,
    categoryName: 'Multi-word count inflation (digits)',
    text: 'Enforced 72 hours critical incident resolution SLA across core services at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Inflated/altered SLA duration (72 hours claimed vs 6 hours verified)'
  },

  // --- Category 2: Numbers written as words in multi-word noun phrases ---
  {
    id: 'cat2-word-ai-ml-projects',
    category: 2,
    categoryName: 'Numbers written as words in multi-word phrases',
    text: 'Delivered fifteen AI and machine learning projects at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Word number count inflation in multi-word phrase (fifteen = 15 projects vs 10 verified)'
  },
  {
    id: 'cat2-word-count-deliverables',
    category: 2,
    categoryName: 'Numbers written as words in multi-word phrases',
    text: 'Delivered thirty-five major client deliverables at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Spelled-out number count inflation (thirty-five = 35 deliverables vs 10 verified)'
  },
  {
    id: 'cat2-word-pipeline-currency',
    category: 2,
    categoryName: 'Numbers written as words in multi-word phrases',
    text: 'Managed a twelve million dollar pipeline at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Spelled-out currency inflation (twelve million dollar = $12M vs $3M verified budget)'
  },
  {
    id: 'cat2-word-clusters',
    category: 2,
    categoryName: 'Numbers written as words in multi-word phrases',
    text: 'Deployed applications across forty-five production clusters at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Spelled-out cluster count inflation (forty-five = 45 clusters vs 25 verified)'
  },
  {
    id: 'cat2-word-sites',
    category: 2,
    categoryName: 'Numbers written as words in multi-word phrases',
    text: 'Expanded cloud operations across eight regional sites at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC, VIOLATION_CODES.SCOPE_INFLATION],
    description: 'Spelled-out site count inflation (eight = 8 sites vs 4 verified)'
  },

  // --- Category 3: Universal Numeric Token Verification ---
  {
    id: 'cat3-unverified-number-at-employer',
    category: 3,
    categoryName: 'Universal Numeric Token Verification',
    text: 'Implemented 18 core services during tenure at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION],
    description: 'Number 18 does not appear in any claim or verified tenure for Meridian Tech'
  },
  {
    id: 'cat3-changed-after-days',
    category: 3,
    categoryName: 'Universal Numeric Token Verification',
    text: 'Reduced customer onboarding turnaround from 14 days to 1 day at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Altered end value in turnaround reduction (from 14 days to 1 day vs verified 4 days)'
  },
  {
    id: 'cat3-changed-before-days',
    category: 3,
    categoryName: 'Universal Numeric Token Verification',
    text: 'Reduced customer onboarding turnaround from 30 days to 4 days at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Altered starting value in turnaround reduction (from 30 days to 4 days vs verified 14 days)'
  },
  {
    id: 'cat3-changed-after-pct',
    category: 3,
    categoryName: 'Universal Numeric Token Verification',
    text: 'Decreased deployment failure rate from 35% to 1% at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Altered end percentage in failure rate reduction (from 35% to 1% vs verified 5%)'
  },
  {
    id: 'cat3-changed-before-pct',
    category: 3,
    categoryName: 'Universal Numeric Token Verification',
    text: 'Decreased deployment failure rate from 60% to 5% at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Altered starting percentage in failure rate reduction (from 60% to 5% vs verified 35%)'
  },
  {
    id: 'cat3-changed-after-latency',
    category: 3,
    categoryName: 'Universal Numeric Token Verification',
    text: 'Reduced cache synchronization latency from 250ms to 15ms at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.METRIC_INFLATION, VIOLATION_CODES.UNTAGGED_METRIC],
    description: 'Altered end latency in reduction (from 250ms to 15ms vs verified 45ms)'
  },

  // --- Category 4: Unsupported Workflow Orchestrators ---
  {
    id: 'cat4-unsupported-airflow',
    category: 4,
    categoryName: 'Unsupported Workflow Orchestrators',
    text: 'Engineered core systems using Airflow at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Workflow orchestrator Airflow is not documented in candidate dossier'
  },
  {
    id: 'cat4-unsupported-temporal',
    category: 4,
    categoryName: 'Unsupported Workflow Orchestrators',
    text: 'Orchestrated distributed stateful workflows with Temporal at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Workflow orchestrator Temporal is not documented in candidate dossier'
  },
  {
    id: 'cat4-unsupported-prefect',
    category: 4,
    categoryName: 'Unsupported Workflow Orchestrators',
    text: 'Managed data engineering flow schedules using Prefect at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Workflow orchestrator Prefect is not documented in candidate dossier'
  },
  {
    id: 'cat4-unsupported-dagster',
    category: 4,
    categoryName: 'Unsupported Workflow Orchestrators',
    text: 'Implemented asset-based data pipelines using Dagster at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Workflow orchestrator Dagster is not documented in candidate dossier'
  },
  {
    id: 'cat4-unsupported-step-functions',
    category: 4,
    categoryName: 'Unsupported Workflow Orchestrators',
    text: 'Built serverless orchestration workflows using AWS Step Functions at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Workflow orchestrator Step Functions is not documented in candidate dossier'
  },
  {
    id: 'cat4-unsupported-airbyte',
    category: 4,
    categoryName: 'Unsupported Workflow Orchestrators',
    text: 'Configured automated ELT data ingestion using Airbyte at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Data integration tool Airbyte is not documented in candidate dossier'
  },

  // --- Category 5: Unsupported Programming Languages ---
  {
    id: 'cat5-unsupported-ruby',
    category: 5,
    categoryName: 'Unsupported Programming Languages',
    text: 'Developed backend microservices using Ruby on Rails at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Language Ruby on Rails is not documented in candidate dossier'
  },
  {
    id: 'cat5-unsupported-csharp',
    category: 5,
    categoryName: 'Unsupported Programming Languages',
    text: 'Migrated enterprise services to C# and .NET Core at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Language C# is not documented in candidate dossier'
  },
  {
    id: 'cat5-unsupported-cpp',
    category: 5,
    categoryName: 'Unsupported Programming Languages',
    text: 'Engineered high-frequency low-latency modules in C++ at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Language C++ is not documented in candidate dossier'
  },
  {
    id: 'cat5-unsupported-java',
    category: 5,
    categoryName: 'Unsupported Programming Languages',
    text: 'Maintained enterprise backend services written in Java at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Language Java is not documented in candidate dossier'
  },
  {
    id: 'cat5-unsupported-php',
    category: 5,
    categoryName: 'Unsupported Programming Languages',
    text: 'Refactored customer portal backend written in PHP at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Language PHP is not documented in candidate dossier'
  },
  {
    id: 'cat5-unsupported-dart',
    category: 5,
    categoryName: 'Unsupported Programming Languages',
    text: 'Built client companion application in Dart at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Language Dart is not documented in candidate dossier'
  },
  {
    id: 'cat5-unsupported-julia',
    category: 5,
    categoryName: 'Unsupported Programming Languages',
    text: 'Developed quantitative analytics routines in Julia at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Language Julia is not documented in candidate dossier'
  },
  {
    id: 'cat5-unsupported-clojure',
    category: 5,
    categoryName: 'Unsupported Programming Languages',
    text: 'Architected immutable state transition engine in Clojure at Horizon Systems.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Language Clojure is not documented in candidate dossier'
  },
  {
    id: 'cat5-unsupported-perl',
    category: 5,
    categoryName: 'Unsupported Programming Languages',
    text: 'Automated infrastructure migration scripts with Perl at Meridian Tech.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.UNSUPPORTED_TOOL],
    description: 'Language Perl is not documented in candidate dossier'
  },

  // --- Category 6: Title inflation ---
  {
    id: 'cat6-inflated-vp',
    category: 6,
    categoryName: 'Title inflation',
    text: 'As VP of Engineering at Meridian Tech, I directed the engineering organization.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.SCOPE_INFLATION, 'ROLE_INFLATION', 'TITLE_INFLATION'],
    description: 'Claiming unverified executive title (VP of Engineering vs verified Senior Software Engineer)'
  },
  {
    id: 'cat6-inflated-head',
    category: 6,
    categoryName: 'Title inflation',
    text: 'As Head of Infrastructure at Horizon Systems, I led company-wide operations.',
    expectedPass: false,
    expectedCodes: [VIOLATION_CODES.SCOPE_INFLATION, 'ROLE_INFLATION', 'TITLE_INFLATION'],
    description: 'Claiming unverified leadership title (Head of Infrastructure vs verified Lead Infrastructure Architect)'
  }
];

// -----------------------------------------------------------------------------
// TEST CASES: Clean Controls with Verified Facts (Zero False Blocks Target)
// -----------------------------------------------------------------------------
const CLEAN_CONTROLS = [
  // --- Category 1 Controls (Exact verified counts in multi-word phrases) ---
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
    id: 'clean-cat2-word-exact-accounts',
    category: 2,
    text: 'Managed fifteen key client accounts at Meridian Tech.',
    expectedPass: true,
    description: 'Truthful statement with spelled-out number (fifteen = 15 accounts verified)'
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

  // --- Category 5 Controls (Technical standards, ordinals, and dates masking) ---
  {
    id: 'clean-cat5-standards-oauth-http',
    category: 5,
    text: 'Architected OAuth 2.0 and HTTP/2 ingress gateway on Layer 7 at Meridian Tech.',
    expectedPass: true,
    description: 'Technical standards OAuth 2.0, HTTP/2, Layer 7 must be masked safely'
  },
  {
    id: 'clean-cat5-standards-iso-sha-arm',
    category: 5,
    text: 'Implemented ISO 27001 compliance and SHA-256 token hashing on ARM64 nodes at Meridian Tech.',
    expectedPass: true,
    description: 'Technical standards ISO 27001, SHA-256, ARM64 must be masked safely'
  },
  {
    id: 'clean-cat5-ordinal-dates',
    category: 5,
    text: 'Served as 1st employee in the platform team starting on May 15, 2017 at Meridian Tech.',
    expectedPass: true,
    description: 'Ordinal 1st and date May 15, 2017 must be masked without false inflation'
  },

  // --- Category 6 Controls (Exact verified titles and tenure) ---
  {
    id: 'clean-cat6-exact-title-meridian',
    category: 6,
    text: 'As Senior Software Engineer at Meridian Tech, delivered key services.',
    expectedPass: true,
    description: 'Exact truthful statement citing verified employer title Senior Software Engineer'
  },
  {
    id: 'clean-cat6-exact-title-horizon',
    category: 6,
    text: 'Served as Lead Infrastructure Architect at Horizon Systems managing cloud platforms.',
    expectedPass: true,
    description: 'Exact truthful statement citing verified employer title Lead Infrastructure Architect'
  }
];

// -----------------------------------------------------------------------------
// TEST SUITE DEFINITIONS
// -----------------------------------------------------------------------------

suite.test('All fabricated probes across target categories must be caught (passed: false)', assert => {
  assert.ok(FABRICATED_PROBES.length >= 25, `Must have at least 25 fabricated test cases, got: ${FABRICATED_PROBES.length}`);

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

suite.test('All clean controls must pass with zero violations (passed: true, 0 violations)', assert => {
  assert.ok(CLEAN_CONTROLS.length >= 15, `Must have at least 15 clean controls, got: ${CLEAN_CONTROLS.length}`);

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
