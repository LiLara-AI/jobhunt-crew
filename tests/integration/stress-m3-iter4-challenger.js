'use strict';
/**
 * JobHunt Crew — Milestone M3 Iteration 4 Adversarial Challenger Stress Suite
 * Author: challenger_m3_r4_2 (Empirical Challenger)
 * Location: tests/integration/stress-m3-iter4-challenger.js
 *
 * Dedicated empirical stress harness covering:
 * 1. Clean control robustness across multiple candidate dossiers (Morgan Vance, Alex Rivera,
 *    Jordan Rivera, and inline custom candidate dossiers). Ensures zero false blocks.
 * 2. Career span grounding and boundary enforcement across varied phrasings
 *    ("Over 12 years of hands-on platform engineering experience", "10 years in distributed systems",
 *    "9 years in software engineering"). Verifies truthful claims pass and inflated tenures fail.
 * 3. Hyphenated technical compound resilience:
 *    Ensures number words in "zero-downtime", "zero-copy", "zero-trust", "two-phase commit",
 *    "one-way hash", "three-tier architecture" are never misparsed as quantitative metric claims.
 * 4. Markdown table formatting and comma-separated metrics serialization/verification:
 *    Ensures "$480,000", "14,000 RPS", "50,000 metrics/sec" survive round-trip markdown
 *    table parsing without token fragmentation, and correctly verify through verifyDraft.
 */

const { TestSuite } = require('../helpers/test-harness');
const { CareerDossier } = require('../../lib/honest-cv/dossier');
const { ClaimVerifier, verifyDraftAgainstDossier, extractEntities, VIOLATION_CODES } = require('../../lib/honest-cv/verify-claims');

const morganVanceDossier = require('../fixtures/dossiers/morgan-vance.json');
const alexRiveraDossier = require('../fixtures/dossiers/alex-rivera.json');

const suite = new TestSuite('Milestone M3 Iteration 4 Adversarial Stress Suite (challenger_m3_r4_2)');

// Custom inline dossier for testing a 3rd distinct domain (Cloud Security Director)
const customSecurityDossier = {
  candidate: {
    name: 'Samira Patel',
    currentTitle: 'Cloud Security Director',
    summary: 'Cloud security leader with 11+ years of experience securing high-scale cloud platforms and zero-trust environments.',
    salaryFloor: { currency: 'USD', minimumBase: 190000, targetTotal: 260000, disclosurePolicy: 'mandatory_only' }
  },
  employers: [
    {
      id: 'emp_shield',
      name: 'Shield Networks',
      isCurrent: true,
      title: 'Cloud Security Director',
      location: 'Dubai, UAE',
      startYear: 2020,
      endYear: null
    },
    {
      id: 'emp_cybercore',
      name: 'CyberCore Systems',
      isCurrent: false,
      title: 'Senior Security Architect',
      location: 'London, UK',
      startYear: 2015,
      endYear: 2020
    }
  ],
  claims: [
    {
      id: 'CLM-SEC-01',
      employerId: 'emp_shield',
      category: 'security',
      text: 'Led enterprise zero-trust security rollout across 40 cloud accounts and 150 Kubernetes clusters with zero security incidents.',
      metrics: ['40 cloud accounts', '150 clusters', 'zero security incidents', '40 accounts', '150 clusters'],
      tools: ['Kubernetes', 'AWS', 'Terraform', 'Istio'],
      role: 'Cloud Security Director'
    },
    {
      id: 'CLM-SEC-02',
      employerId: 'emp_shield',
      category: 'cost',
      text: 'Negotiated enterprise cloud security tooling spend saving $320,000 annually across 12 vendor contracts.',
      metrics: ['$320,000', '12 vendor contracts', '12 contracts'],
      tools: ['AWS', 'Splunk'],
      role: 'Cloud Security Director'
    },
    {
      id: 'CLM-SEC-03',
      employerId: 'emp_cybercore',
      category: 'compliance',
      text: 'Delivered ISO 27001 and SOC 2 Type II compliance audits across 6 regional data centers over 18 months.',
      metrics: ['6 regional data centers', '6 data centers', '18 months'],
      tools: ['Python', 'Docker'],
      role: 'Senior Security Architect'
    }
  ],
  skills: {
    languages: ['Python', 'Go', 'SQL'],
    infrastructure: ['AWS', 'Kubernetes', 'Docker', 'Terraform'],
    architecturalDomains: ['Cloud Security', 'Zero-Trust Architecture', 'Security Compliance']
  },
  certifications: [
    { name: 'CISSP', issuer: 'ISC2', year: 2018 }
  ]
};

// ============================================================================
// TEST 1: Clean Control Robustness Across Multiple Dossiers
// ============================================================================
suite.test('Clean Controls: Verified statements across 3 distinct dossiers pass with 0 false blocks', assert => {
  const cleanTestCases = [
    // Morgan Vance controls
    {
      dossier: morganVanceDossier,
      candidate: 'Morgan Vance',
      text: 'Reduced core event-processing p99 latency from 180ms to 42ms through Kafka topic repartitioning and zero-copy deserialization in Go at Apex Cloud Technologies.'
    },
    {
      dossier: morganVanceDossier,
      candidate: 'Morgan Vance',
      text: 'Architected multi-region Kubernetes cluster hosting 120+ microservices processing 4.5 billion events daily across 3 availability zones at Apex Cloud Technologies.'
    },
    {
      dossier: morganVanceDossier,
      candidate: 'Morgan Vance',
      text: 'Cut AWS cloud compute and storage expenditure by 34% annually ($480,000 saved) through autoscaling spot fleet orchestration and ARM64 migration at Apex Cloud Technologies.'
    },
    {
      dossier: morganVanceDossier,
      candidate: 'Morgan Vance',
      text: 'Maintained 99.99% availability for payment gateway ledger handling GBP 140 million annual transaction volume at Strata Data Systems.'
    },
    {
      dossier: morganVanceDossier,
      candidate: 'Morgan Vance',
      text: 'Developed high-throughput telemetry ingestion backend in C++ and Python streaming 50,000 telemetry metrics per second at Nova Soft Labs.'
    },
    {
      dossier: morganVanceDossier,
      candidate: 'Morgan Vance',
      text: 'Enforced zero-trust service mesh using Istio mTLS across 600 production pods at Apex Cloud Technologies.'
    },
    // Alex Rivera controls
    {
      dossier: alexRiveraDossier,
      candidate: 'Alex Rivera',
      text: 'Redesigned mobile checkout web flow in Next.js reducing checkout drop-off by 19% across 2.2 million monthly active shoppers at Bazaar Retail Systems.'
    },
    {
      dossier: alexRiveraDossier,
      candidate: 'Alex Rivera',
      text: 'Built real-time inventory reservation service handling 14,000 peak requests per second during promotional flash sales at Bazaar Retail Systems.'
    },
    {
      dossier: alexRiveraDossier,
      candidate: 'Alex Rivera',
      text: 'Optimized Core Web Vitals across 80 storefront templates, decreasing Largest Contentful Paint (LCP) from 3.8s to 1.1s at Oasis Digital Commerce.'
    },
    {
      dossier: alexRiveraDossier,
      candidate: 'Alex Rivera',
      text: 'Established enterprise design system component library in React adopted by 5 engineering squads, accelerating sprint delivery by 25% at Oasis Digital Commerce.'
    },
    // Samira Patel (Custom) controls
    {
      dossier: customSecurityDossier,
      candidate: 'Samira Patel',
      text: 'Led enterprise zero-trust security rollout across 40 cloud accounts and 150 Kubernetes clusters at Shield Networks.'
    },
    {
      dossier: customSecurityDossier,
      candidate: 'Samira Patel',
      text: 'Negotiated enterprise cloud security tooling spend saving $320,000 annually across 12 vendor contracts at Shield Networks.'
    },
    {
      dossier: customSecurityDossier,
      candidate: 'Samira Patel',
      text: 'Delivered ISO 27001 and SOC 2 Type II compliance audits across 6 regional data centers over 18 months at CyberCore Systems.'
    }
  ];

  for (const tc of cleanTestCases) {
    const res = ClaimVerifier.verifySentence(tc.text, tc.dossier);
    assert.equal(
      res.passed,
      true,
      `Clean control for ${tc.candidate} must pass verification: "${tc.text}", got violations: ${JSON.stringify(res.violations)}`
    );
    assert.equal(res.violations.length, 0, `Clean control must have 0 violations: "${tc.text}"`);

    // Verify through top-level helper as well
    const topRes = verifyDraftAgainstDossier(tc.dossier, tc.text);
    assert.equal(topRes.passed, true, `Top-level verifyDraftAgainstDossier must pass for ${tc.candidate}`);
  }
});

// ============================================================================
// TEST 2: Career Span Grounding & Tenure Boundary Enforcement
// ============================================================================
suite.test('Career Span Grounding: Truthful career span assertions pass, while unverified tenures are rejected', assert => {
  // Truthful career span statements that must PASS
  const truthfulSpans = [
    { dossier: morganVanceDossier, text: 'Over 12 years of hands-on platform engineering experience.' },
    { dossier: morganVanceDossier, text: '10 years in distributed systems scaling infrastructure.' },
    { dossier: morganVanceDossier, text: 'Distributed systems engineer with 12+ years of experience.' },
    { dossier: morganVanceDossier, text: 'Over 8 years of distributed systems engineering.' },
    { dossier: morganVanceDossier, text: '5 years of platform architecture experience.' },
    { dossier: alexRiveraDossier, text: 'Full-stack engineer with 9 years of experience specializing in TypeScript.' },
    { dossier: alexRiveraDossier, text: '8 years of web engineering experience.' },
    { dossier: alexRiveraDossier, text: '4 years of experience building e-commerce backends.' },
    { dossier: customSecurityDossier, text: 'Cloud security leader with 11+ years of experience securing cloud platforms.' },
    { dossier: customSecurityDossier, text: 'Over 10 years of cloud security architecture experience.' },
    { dossier: customSecurityDossier, text: '7 years of enterprise security leadership.' }
  ];

  for (const tc of truthfulSpans) {
    const res = ClaimVerifier.verifySentence(tc.text, tc.dossier);
    assert.equal(
      res.passed,
      true,
      `Truthful career span must pass: "${tc.text}", got violations: ${JSON.stringify(res.violations)}`
    );
    assert.equal(res.violations.length, 0, `Career span must produce 0 violations: "${tc.text}"`);
  }

  // Fabricated tenure statements that MUST FAIL
  const fabricatedSpans = [
    {
      dossier: morganVanceDossier,
      text: 'Over 25 years of hands-on platform engineering experience.',
      expectedCode: VIOLATION_CODES.METRIC_INFLATION,
      description: 'Tenure claim (25 years) exceeds Morgan Vance career span (2013-present = ~13 years)'
    },
    {
      dossier: morganVanceDossier,
      text: '30 years of distributed systems experience in the software industry.',
      expectedCode: VIOLATION_CODES.METRIC_INFLATION,
      description: 'Tenure claim (30 years) exceeds verified career span'
    },
    {
      dossier: alexRiveraDossier,
      text: 'Over 18 years of experience building e-commerce platforms.',
      expectedCode: VIOLATION_CODES.METRIC_INFLATION,
      description: 'Tenure claim (18 years) exceeds Alex Rivera career span (2018-present = ~8-9 years)'
    },
    {
      dossier: customSecurityDossier,
      text: 'Over 20 years of enterprise cloud security experience.',
      expectedCode: VIOLATION_CODES.METRIC_INFLATION,
      description: 'Tenure claim (20 years) exceeds Samira Patel career span (2015-present = ~11 years)'
    }
  ];

  for (const tc of fabricatedSpans) {
    const res = ClaimVerifier.verifySentence(tc.text, tc.dossier);
    assert.equal(
      res.passed,
      false,
      `Fabricated tenure must fail: "${tc.text}" (${tc.description})`
    );
    assert.ok(
      res.violations.some(v => v.code === tc.expectedCode || v.code === VIOLATION_CODES.SCOPE_INFLATION),
      `Expected violation code ${tc.expectedCode} for "${tc.text}", got: ${JSON.stringify(res.violations)}`
    );
  }
});

// ============================================================================
// TEST 3: Hyphenated Technical Compounds & Spelled Number Words
// ============================================================================
suite.test('Hyphenated Technical Compounds: "zero-downtime", "zero-copy", "zero-trust", "two-phase", "one-way" never trigger false blocks', assert => {
  const technicalCompoundCases = [
    {
      dossier: morganVanceDossier,
      text: 'Architected zero-downtime database migration across core services at Strata Data Systems.',
      description: 'Compound "zero-downtime" should not be treated as a zero-metric violation'
    },
    {
      dossier: morganVanceDossier,
      text: 'Implemented zero-copy serialization in Go for high throughput event processing at Apex Cloud Technologies.',
      description: 'Compound "zero-copy" should not be extracted as numerical claim'
    },
    {
      dossier: morganVanceDossier,
      text: 'Enforced zero-trust architecture across production environments using Istio at Apex Cloud Technologies.',
      description: 'Compound "zero-trust" should not be parsed as numerical zero'
    },
    {
      dossier: morganVanceDossier,
      text: 'Engineered two-phase commit protocol across distributed datastores at Strata Data Systems.',
      description: 'Compound "two-phase" should not be extracted as an inflated 2-phase count'
    },
    {
      dossier: morganVanceDossier,
      text: 'Applied one-way hash functions for secure token verification in Go at Apex Cloud Technologies.',
      description: 'Compound "one-way" should not be treated as a metric inflation'
    },
    {
      dossier: morganVanceDossier,
      text: 'Deployed two-tier caching topology using Redis and local memory at Strata Data Systems.',
      description: 'Compound "two-tier" should not trigger count inflation'
    },
    {
      dossier: morganVanceDossier,
      text: 'Designed three-tier architecture for cloud applications at Apex Cloud Technologies.',
      description: 'Compound "three-tier" should not trigger count inflation'
    },
    {
      dossier: customSecurityDossier,
      text: 'Implemented zero-trust network access (ZTNA) and one-way cryptographic tokens at Shield Networks.',
      description: 'Compounds "zero-trust" and "one-way" in custom security dossier'
    }
  ];

  for (const tc of technicalCompoundCases) {
    const res = ClaimVerifier.verifySentence(tc.text, tc.dossier);
    assert.equal(
      res.passed,
      true,
      `Hyphenated technical compound must not cause false block (${tc.description}): "${tc.text}", got violations: ${JSON.stringify(res.violations)}`
    );
    assert.equal(res.violations.length, 0, `Violations must be empty for "${tc.text}"`);

    // Verify entities extraction does not report spurious counts for these terms
    const ent = extractEntities(tc.text);
    const spuriousCounts = ent.counts.filter(c => /^(copy|downtime|trust|phase|way|tier)$/i.test(c.baseUnit));
    assert.equal(
      spuriousCounts.length,
      0,
      `Entities extraction produced spurious count entities: ${JSON.stringify(spuriousCounts)} from "${tc.text}"`
    );
  }
});

// ============================================================================
// TEST 4: Markdown Table Serialization & Comma-Separated Metrics Round-Trip
// ============================================================================
suite.test('Table Formatting: Comma-separated numbers ($480,000, 14,000 RPS, 50,000 metrics/sec) serialize/deserialize without fragmentation', assert => {
  // Test Morgan Vance Dossier table round-trip
  const mvDossier = new CareerDossier(morganVanceDossier);
  const mvMarkdown = mvDossier.toMarkdown();
  assert.ok(mvMarkdown.includes('| Claim ID | Employer | Category | Status | Verified Metrics | Verified Tools | Verification Evidence |'),
    'Markdown must contain Claim Verification Appendix table header');
  assert.ok(mvMarkdown.includes('`$480,000 saved`'), 'Markdown table must contain backticked $480,000 metric');
  assert.ok(mvMarkdown.includes('`50,000 metrics/sec`'), 'Markdown table must contain backticked 50,000 metrics/sec metric');

  const mvParsed = CareerDossier.fromMarkdown(mvMarkdown);
  const mvClmCost = mvParsed.claims.find(c => c.id === 'CLM-003');
  assert.ok(mvClmCost, 'CLM-003 must be deserialized from Markdown table');
  assert.deepEqual(
    mvClmCost.metrics,
    ['34%', '$480,000 saved'],
    'CLM-003 metrics must not be fragmented by embedded commas'
  );

  const mvClmTelemetry = mvParsed.claims.find(c => c.id === 'CLM-008');
  assert.ok(mvClmTelemetry, 'CLM-008 must be deserialized from Markdown table');
  assert.deepEqual(
    mvClmTelemetry.metrics,
    ['50,000 metrics/sec'],
    'CLM-008 metrics must preserve "50,000 metrics/sec" without splitting on comma'
  );

  // Test Alex Rivera Dossier table round-trip
  const arDossier = new CareerDossier(alexRiveraDossier);
  const arMarkdown = arDossier.toMarkdown();
  assert.ok(arMarkdown.includes('`14,000 RPS`'), 'Alex Rivera table must include 14,000 RPS');

  const arParsed = CareerDossier.fromMarkdown(arMarkdown);
  const arClmScale = arParsed.claims.find(c => c.id === 'ALX-002');
  assert.ok(arClmScale, 'ALX-002 must be deserialized from Markdown table');
  assert.deepEqual(
    arClmScale.metrics,
    ['14,000 RPS'],
    'ALX-002 metrics must preserve "14,000 RPS" without splitting on comma'
  );

  // Test non-backticked raw Markdown table parsing (robustness test)
  const rawTableMarkdown = `
# Career Dossier — Jordan Rivera

## 1. Professional Summary
Experienced architect.

## 2. Career Target & Compensation Policy
- **Current Title**: Lead Architect
- **Location**: Remote
- **Work Authorization**: Citizen
- **Notice Period**: 30 Days

## 3. Verified Work Experience

### Horizon Systems (2021 – Present)
**Lead Architect** · Remote
- [CLM-H1] Operated production clusters.

## 4. Education & Certifications
None documented.

## 5. Structured Skills Taxonomy
- **Languages**: Go, Python

---

## 6. Claim Verification Appendix

| Claim ID | Employer | Category | Status | Verified Metrics | Verified Tools | Verification Evidence |
|---|---|---|---|---|---|---|
| \`[CLM-H1]\` | \`emp_horizon\` | infra | ✅ VERIFIED | $2,500,000, 14,000 RPS, 50,000 metrics/sec | Go, Python | Verified via CV |
`;

  const parsedRaw = CareerDossier.fromMarkdown(rawTableMarkdown);
  const parsedClm = parsedRaw.claims.find(c => c.id === 'CLM-H1');
  assert.ok(parsedClm, 'CLM-H1 must be parsed from non-backticked table');
  assert.deepEqual(
    parsedClm.metrics,
    ['$2,500,000', '14,000 RPS', '50,000 metrics/sec'],
    'Non-backticked table metrics must not be fragmented at internal comma separators'
  );
});

// ============================================================================
// TEST 5: Document Drafts Containing Markdown Tables
// ============================================================================
suite.test('Draft Tables: ClaimVerifier.verifyDraft verifies drafts containing Markdown tables with comma-separated numbers', assert => {
  // Clean draft document formatted with Markdown tables
  const cleanDocumentWithTable = [
    '# Candidate Experience Highlights',
    '',
    '## Key Achievements at Apex Cloud Technologies',
    '',
    '| Impact Category | Verified Metric | Implementation Details |',
    '|---|---|---|',
    '| Cost Optimization | $480,000 saved | Cut AWS compute and storage expenditure by 34% annually at Apex Cloud Technologies |',
    '| Scale & Reliability | 4.5 billion daily | Hosted 120+ microservices on Kubernetes across 3 availability zones at Apex Cloud Technologies |',
    '| Security Compliance | 600 production pods | Enforced zero-trust service mesh using Istio mTLS at Apex Cloud Technologies |',
    '',
    '## Previous Contributions at Strata Data Systems',
    '',
    '| Project | Scale | Technical Approach |',
    '|---|---|---|',
    '| Payment Ledger | GBP 140 million | Maintained 99.99% availability for payment gateway ledger at Strata Data Systems |',
    '| Service Observability | 45 services | Implemented distributed tracing using OpenTelemetry and Jaeger at Strata Data Systems |'
  ].join('\n');

  const cleanDraftResult = ClaimVerifier.verifyDraft(morganVanceDossier, cleanDocumentWithTable);
  assert.equal(
    cleanDraftResult.passed,
    true,
    `Clean table draft must pass verification, got violations: ${JSON.stringify(cleanDraftResult.violations)}`
  );
  assert.equal(cleanDraftResult.violations.length, 0, 'Clean table draft must produce 0 violations');

  // Adversarial draft document containing an inflated metric inside a table cell
  const fabricatedTableDocument = [
    '# Candidate Experience Highlights',
    '',
    '| Impact Category | Metric | Details |',
    '|---|---|---|',
    '| Cost Optimization | $950,000 saved | Cut AWS compute expenditure by 34% at Apex Cloud Technologies |',
    '| Scale & Throughput | 80,000 RPS | Handled flash sales at Bazaar Retail Systems |'
  ].join('\n');

  const fabDraftResult = ClaimVerifier.verifyDraft(morganVanceDossier, fabricatedTableDocument);
  assert.equal(
    fabDraftResult.passed,
    false,
    'Fabricated metric inside markdown table cell must be rejected'
  );
  assert.ok(
    fabDraftResult.violations.some(v => v.code === VIOLATION_CODES.METRIC_INFLATION),
    `Table cell fabrication must be flagged as METRIC_INFLATION, got: ${JSON.stringify(fabDraftResult.violations)}`
  );
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(stats => {
    process.exit(stats.failed === 0 ? 0 : 1);
  });
}
