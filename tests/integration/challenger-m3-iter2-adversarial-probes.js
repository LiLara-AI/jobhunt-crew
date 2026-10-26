'use strict';

/**
 * Challenger M3 Iteration 2 Adversarial Probes
 *
 * Comprehensive stress harness for lib/honest-cv/verify-claims.js:
 * 1. Raw text strings (no object wrappers, no subtype metadata) for 21 Golden Corpus fabrications
 * 2. Raw text strings for 21 clean drafts (precision check)
 * 3. Latency boundary probes (41ms, 5ms, 20ms, 0.010s, 0.041s, 41 milliseconds)
 * 4. Percentage non-word boundary and out-of-order phrasing probes (75%, 80%)
 * 5. Novel unsupported tools (Snowflake, Apache Flink, TensorFlow, PyTorch, TerraformCloud, Cassandra)
 * 6. Novel ungrounded credentials and degrees (CISSP, CompTIA Security+, Harvard MBA, Stanford M.S., Turing Award)
 * 7. Singular patent claims ("1 patent grant", "1 patent", "patented")
 * 8. Cross-employer transplants without --claim-ids
 * 9. EditorialRuleEngine safety guard enforcement against adversarial injections
 * 10. CLI execution exit codes
 */

const assert = require('assert');
const path = require('path');
const { execSync } = require('child_process');
const { ClaimVerifier, extractEntities } = require('../../lib/honest-cv/verify-claims');
const { EditorialRuleEngine } = require('../../lib/honest-cv/editorial-rules');
const { corpus, dossiers } = require('../fixtures/golden-corpus/corpus');

const ROOT_DIR = path.resolve(__dirname, '../..');
const morganDossier = dossiers['morgan-vance'];
const alexDossier = dossiers['alex-rivera'];

let totalPassed = 0;
let totalFailed = 0;

function runProbe(name, fn) {
  try {
    fn();
    totalPassed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    totalFailed++;
    console.error(`  [FAIL] ${name}: ${err.message}`);
  }
}

console.log('\n=== RUNNING CHALLENGER M3 ITERATION 2 ADVERSARIAL PROBES ===\n');

// ----------------------------------------------------------------------------
// SUITE 1: Raw Text Input (Golden Corpus Fabrications as pure strings)
// ----------------------------------------------------------------------------
console.log('--- Suite 1: Raw Text Input for Golden Corpus Fabrications (No Metadata/Wrapper) ---');

const fabrications = corpus.filter(c => c.type === 'fabrication');
assert.strictEqual(fabrications.length, 21, 'Must have 21 Golden Corpus fabrications');

let caughtRawCount = 0;
for (const fab of fabrications) {
  const candidateDossier = dossiers[fab.candidate];
  const rawString = String(fab.draftText); // pure string, no object wrapper

  runProbe(`Raw text catch: ${fab.id} (${fab.subtype})`, () => {
    // Test verifySentence with raw string
    const sentenceRes = ClaimVerifier.verifySentence(rawString, candidateDossier);
    assert.strictEqual(sentenceRes.passed, false, `verifySentence must fail for ${fab.id}`);
    assert.ok(sentenceRes.violations.length > 0, `verifySentence must report violations for ${fab.id}`);

    // Test verifyDraft with raw string
    const draftRes = ClaimVerifier.verifyDraft(candidateDossier, rawString);
    assert.strictEqual(draftRes.passed, false, `verifyDraft must fail for ${fab.id}`);
    assert.ok(draftRes.violations.length > 0, `verifyDraft must report violations for ${fab.id}`);

    caughtRawCount++;
  });
}

runProbe('100% recall on Golden Corpus fabrications as raw text strings', () => {
  assert.strictEqual(caughtRawCount, 21, `Expected 21/21 caught as raw text, got ${caughtRawCount}`);
});

// ----------------------------------------------------------------------------
// SUITE 2: Raw Text Input for Clean Drafts (Precision Check)
// ----------------------------------------------------------------------------
console.log('\n--- Suite 2: Raw Text Input for Clean Drafts (Zero False Blocks Target) ---');

const cleanDrafts = corpus.filter(c => c.type === 'clean');
assert.strictEqual(cleanDrafts.length, 21, 'Must have 21 Golden Corpus clean drafts');

let falseBlockCount = 0;
for (const clean of cleanDrafts) {
  const candidateDossier = dossiers[clean.candidate];
  const rawString = String(clean.draftText);

  runProbe(`Raw clean draft pass: ${clean.id} (${clean.subtype})`, () => {
    const res = ClaimVerifier.verifyDraft(candidateDossier, rawString);
    if (!res.passed) {
      falseBlockCount++;
      throw new Error(`Clean draft falsely blocked with violations: ${JSON.stringify(res.violations)}`);
    }
    assert.strictEqual(res.passed, true);
    assert.strictEqual(res.violations.length, 0);
  });
}

runProbe('False block rate on clean raw text strings <= 5%', () => {
  const rate = (falseBlockCount / cleanDrafts.length) * 100;
  assert.ok(rate <= 5, `False block rate ${rate}% exceeds 5%`);
  assert.strictEqual(falseBlockCount, 0, 'Target 0 false blocks achieved');
});

// ----------------------------------------------------------------------------
// SUITE 3: Latency Boundary and Unit Conversion Probes
// ----------------------------------------------------------------------------
console.log('\n--- Suite 3: Latency Boundary and Unit Conversion Probes ---');

// Morgan Vance baseline: CLM-001 is 180ms down to 42ms
const latencyProbes = [
  { text: 'Reduced event latency to 42ms in Go at Apex Cloud Technologies.', expectPass: true, label: 'Exact baseline (42ms)' },
  { text: 'Reduced event latency to 41ms in Go at Apex Cloud Technologies.', expectPass: false, label: 'Boundary inflation (41ms vs 42ms baseline)' },
  { text: 'Reduced event latency to 5ms in Go at Apex Cloud Technologies.', expectPass: false, label: 'Severe inflation (5ms vs 42ms baseline)' },
  { text: 'Reduced event latency to 20ms in Go at Apex Cloud Technologies.', expectPass: false, label: 'Moderate inflation (20ms vs 42ms baseline)' },
  { text: 'Reduced event latency to 0.042s in Go at Apex Cloud Technologies.', expectPass: true, label: 'Unit conversion pass (0.042s = 42ms)' },
  { text: 'Reduced event latency to 0.010s in Go at Apex Cloud Technologies.', expectPass: false, label: 'Unit conversion inflation (0.010s = 10ms)' },
  { text: 'Reduced event latency to 0.041s in Go at Apex Cloud Technologies.', expectPass: false, label: 'Unit conversion boundary inflation (0.041s = 41ms)' },
  { text: 'Reduced event latency to 0.005s in Go at Apex Cloud Technologies.', expectPass: false, label: 'Unit conversion severe inflation (0.005s = 5ms)' },
  { text: 'Reduced event latency to 42 milliseconds in Go at Apex Cloud Technologies.', expectPass: true, label: 'Spelled-out unit pass (42 milliseconds)' },
  { text: 'Reduced event latency to 41 milliseconds in Go at Apex Cloud Technologies.', expectPass: false, label: 'Spelled-out unit boundary inflation (41 milliseconds)' },
  { text: 'Reduced event latency to 10 milliseconds in Go at Apex Cloud Technologies.', expectPass: false, label: 'Spelled-out unit inflation (10 milliseconds)' }
];

for (const p of latencyProbes) {
  runProbe(`Latency: ${p.label}`, () => {
    const res = ClaimVerifier.verifyDraft(morganDossier, p.text);
    assert.strictEqual(res.passed, p.expectPass, `Expected passed=${p.expectPass} for "${p.text}"`);
    if (!p.expectPass) {
      assert.ok(res.violations.some(v => v.code === 'METRIC_INFLATION'), 'Violation code must be METRIC_INFLATION');
    }
  });
}

// ----------------------------------------------------------------------------
// SUITE 4: Percentage Boundary and Out-of-Order Phrasing Probes
// ----------------------------------------------------------------------------
console.log('\n--- Suite 4: Percentage Boundary and Out-of-Order Phrasing Probes ---');

const percentageProbes = [
  { text: 'Cut AWS cloud compute and storage expenditure by 75% annually through spot fleet orchestration.', expectPass: false, code: 'METRIC_INFLATION', label: 'GC-F02 raw string (75% expenditure)' },
  { text: 'Achieved 75% cost savings across cloud infrastructure.', expectPass: false, code: 'METRIC_INFLATION', label: 'Non-word boundary 75% cost savings' },
  { text: 'Reduced CI/CD build execution duration by 80% across all platform developer repositories.', expectPass: false, label: 'GC-F13 raw string (80% CI/CD)' },
  { text: 'Across all platform developer repositories, reduced CI/CD build execution duration by 80%.', expectPass: false, label: 'GC-F13 out-of-order variation 1' },
  { text: 'Build execution duration was reduced by 80% for CI/CD across developer repositories.', expectPass: false, label: 'GC-F13 out-of-order variation 2' },
  { text: 'Decreased build duration by 80% across CI/CD platform pipelines.', expectPass: false, label: 'GC-F13 out-of-order variation 3' }
];

for (const p of percentageProbes) {
  runProbe(`Percentage/Order: ${p.label}`, () => {
    const res = ClaimVerifier.verifyDraft(morganDossier, p.text);
    assert.strictEqual(res.passed, p.expectPass, `Expected passed=${p.expectPass} for "${p.text}"`);
    assert.ok(res.violations.length > 0, 'Must have violations');
  });
}

// ----------------------------------------------------------------------------
// SUITE 5: Novel Unsupported Tools & Technologies
// ----------------------------------------------------------------------------
console.log('\n--- Suite 5: Novel Unsupported Tools & Technologies ---');

const toolProbes = [
  { text: 'Built enterprise data warehouse using Snowflake at Apex Cloud Technologies.', tool: 'snowflake', label: 'Snowflake data warehouse' },
  { text: 'Streamed stateful aggregations using Apache Flink at Apex Cloud Technologies.', tool: 'apache flink', label: 'Apache Flink streaming' },
  { text: 'Trained neural network models using TensorFlow at Apex Cloud Technologies.', tool: 'tensorflow', label: 'TensorFlow models' },
  { text: 'Deployed deep learning inference pipelines using PyTorch at Apex Cloud Technologies.', tool: 'pytorch', label: 'PyTorch deep learning' },
  { text: 'Managed cloud infrastructure using TerraformCloud at Apex Cloud Technologies.', tool: 'terraformcloud', label: 'TerraformCloud infra' },
  { text: 'Processed big data using Databricks at Apex Cloud Technologies.', tool: 'databricks', label: 'Databricks processing' },
  { text: 'Engineered pipelines using Apache Beam at Apex Cloud Technologies.', tool: 'apache beam', label: 'Apache Beam pipeline' },
  { text: 'Stored distributed records in Cassandra at Apex Cloud Technologies.', tool: 'cassandra', label: 'Cassandra storage' }
];

for (const p of toolProbes) {
  runProbe(`Unsupported Tool: ${p.label}`, () => {
    const res = ClaimVerifier.verifyDraft(morganDossier, p.text);
    assert.strictEqual(res.passed, false, `Must fail verification for ungrounded tool: ${p.tool}`);
    const v = res.violations.find(viol => viol.code === 'UNSUPPORTED_TOOL');
    assert.ok(v, `Must report UNSUPPORTED_TOOL violation, got: ${JSON.stringify(res.violations)}`);
    assert.strictEqual(v.tool, p.tool);
  });
}

// ----------------------------------------------------------------------------
// SUITE 6: Novel Credentials, Degrees, Awards and Singular Patent
// ----------------------------------------------------------------------------
console.log('\n--- Suite 6: Novel Credentials, Degrees, Awards and Singular Patent ---');

const credProbes = [
  { text: 'Holds CISSP and CompTIA Security+ certifications.', code: 'FABRICATED_CREDENTIAL', label: 'CISSP and CompTIA Security+' },
  { text: 'Certified in CompTIA Security+.', code: 'FABRICATED_CREDENTIAL', label: 'CompTIA Security+ only' },
  { text: 'Honored as a Google Cloud Fellow.', code: 'FABRICATED_CREDENTIAL', label: 'Google Cloud Fellow' },
  { text: 'Earned an MBA from Harvard Business School.', code: 'FABRICATED_DEGREE', label: 'Harvard MBA' },
  { text: 'Completed Master of Science in Artificial Intelligence from Stanford University.', code: 'FABRICATED_DEGREE', label: 'Stanford M.S.' },
  { text: 'Holds an Executive MBA from Wharton.', code: 'FABRICATED_DEGREE', label: 'Wharton Executive MBA' },
  { text: 'Studied distributed systems at MIT.', code: 'FABRICATED_DEGREE', label: 'MIT institution' },
  { text: 'Awarded the ACM Turing Award for contributions to distributed systems.', code: 'FABRICATED_AWARD', label: 'ACM Turing Award' },
  { text: 'Awarded 1 patent grant for distributed consensus.', code: 'FABRICATED_PATENT', label: 'Singular patent grant' },
  { text: 'Holds 1 US patent on asynchronous consensus.', code: 'FABRICATED_PATENT', label: 'Singular US patent' },
  { text: 'Awarded 1 patent.', code: 'FABRICATED_PATENT', label: 'Singular patent bare' },
  { text: 'Invented and patented core protocol.', code: 'AUTHORSHIP_INFLATION', label: 'Invented and patented' }
];

for (const p of credProbes) {
  runProbe(`Credential/Degree/Patent: ${p.label}`, () => {
    const res = ClaimVerifier.verifyDraft(morganDossier, p.text);
    assert.strictEqual(res.passed, false, `Must fail verification for "${p.text}"`);
    assert.ok(res.violations.some(v => v.code === p.code), `Must report ${p.code}, got: ${JSON.stringify(res.violations)}`);
  });
}

// ----------------------------------------------------------------------------
// SUITE 7: Cross-Employer Transplants without --claim-ids
// ----------------------------------------------------------------------------
console.log('\n--- Suite 7: Cross-Employer Transplants without --claim-ids ---');

const transplantProbes = [
  {
    text: 'Maintained 99.99% availability for a payment gateway ledger handling GBP 140 million while at Apex Cloud Technologies.',
    employer: 'Apex Cloud Technologies',
    label: 'Strata CLM-005 fact to Apex'
  },
  {
    text: 'Executed a zero-downtime migration of a legacy billing system over 9 months at Apex Cloud Technologies.',
    employer: 'Apex Cloud Technologies',
    label: 'Strata CLM-006 fact to Apex'
  },
  {
    text: 'Implemented distributed tracing across 45 services using OpenTelemetry and Jaeger at Apex Cloud Technologies.',
    employer: 'Apex Cloud Technologies',
    label: 'Strata CLM-007 fact to Apex'
  },
  {
    text: 'Enforced zero-trust service mesh using Istio mTLS across 600 production pods at Nova Soft Labs.',
    employer: 'Nova Soft Labs',
    label: 'Apex CLM-010 fact to Nova'
  },
  {
    text: 'Developed high-throughput telemetry ingestion backend streaming 50,000 sensor telemetry metrics per second at Strata Data Systems.',
    employer: 'Strata Data Systems',
    label: 'Nova CLM-008 fact to Strata'
  },
  {
    text: 'Authored automated fuzzing and regression test framework increasing unit test coverage from 54% to 88% at Strata Data Systems.',
    employer: 'Strata Data Systems',
    label: 'Nova CLM-009 fact to Strata'
  },
  {
    text: 'Architected multi-region Kubernetes cluster hosting 120+ microservices processing 4.5 billion daily events at Nova Soft Labs.',
    employer: 'Nova Soft Labs',
    label: 'Apex CLM-002 fact to Nova'
  }
];

for (const p of transplantProbes) {
  runProbe(`Transplant (no claim-ids): ${p.label}`, () => {
    const res = ClaimVerifier.verifyDraft(morganDossier, p.text);
    assert.strictEqual(res.passed, false, `Must fail verification for cross-employer transplant: "${p.text}"`);
    const v = res.violations.find(viol => viol.code === 'TRANSPLANTED_EMPLOYER');
    assert.ok(v, `Must report TRANSPLANTED_EMPLOYER violation, got: ${JSON.stringify(res.violations)}`);
    assert.strictEqual(v.employer, p.employer);
  });
}

// ----------------------------------------------------------------------------
// SUITE 8: Editorial Rules Injection & Safety Guard Bypass Stress
// ----------------------------------------------------------------------------
console.log('\n--- Suite 8: Editorial Rules Injection & Safety Guard Bypass Stress ---');

const editorialInjectionProbes = [
  { ruleId: 'R-AD-01', from: '42ms', to: '41ms', label: 'Boundary latency shift 42ms -> 41ms' },
  { ruleId: 'R-AD-02', from: '42ms', to: '5ms', label: 'Severe latency shift 42ms -> 5ms' },
  { ruleId: 'R-AD-03', from: 'Kafka', to: 'Snowflake', label: 'Unsupported tool injection Snowflake' },
  { ruleId: 'R-AD-04', from: 'Kafka', to: 'Apache Flink', label: 'Unsupported tool injection Apache Flink' },
  { ruleId: 'R-AD-05', from: 'CKA', to: 'CISSP', label: 'Credential injection CISSP' },
  { ruleId: 'R-AD-06', from: 'Ph.D.', to: 'Harvard MBA', label: 'Degree injection Harvard MBA' },
  { ruleId: 'R-AD-07', from: 'consensus protocol', to: '1 patent on consensus protocol', label: 'Patent injection 1 patent' }
];

for (const p of editorialInjectionProbes) {
  runProbe(`Editorial Guard: ${p.label}`, () => {
    const engine = new EditorialRuleEngine({ autoLoad: false });
    engine.learnRuleFromCorrection(p.ruleId, p.from, p.to, 'adversarial-probe');

    const baseSentence = `Reduced event latency to ${p.from} using CKA and Ph.D. in consensus protocol at Apex Cloud Technologies.`;
    let threw = false;

    try {
      engine.applyRules(baseSentence, { dossier: morganDossier });
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('EDITORIAL_GUARD_VIOLATION') || err.name === 'EditorialGuardViolation' || err.code === 'EDITORIAL_GUARD_VIOLATION',
        `Error message must indicate guard violation: ${err.message}`);
    }

    assert.ok(threw, `EditorialRuleEngine must throw on rule injecting ungrounded claim: ${p.label}`);
  });
}

// ----------------------------------------------------------------------------
// SUITE 9: Standalone CLI Execution Tests
// ----------------------------------------------------------------------------
console.log('\n--- Suite 9: Standalone CLI Execution Exit Codes ---');

const cliProbes = [
  {
    cmd: `node bin/crew.js claim verify --dossier tests/fixtures/dossiers/morgan-vance.json --draft "Reduced event latency from 180ms to 42ms through Kafka in Go at Apex Cloud Technologies."`,
    expectExit: 0,
    label: 'CLI clean draft exits 0'
  },
  {
    cmd: `node bin/crew.js claim verify --dossier tests/fixtures/dossiers/morgan-vance.json --draft "Cut AWS cloud compute and storage expenditure by 75% annually through spot fleet orchestration."`,
    expectExit: 1,
    label: 'CLI GC-F02 (75%) exits 1'
  },
  {
    cmd: `node bin/crew.js claim verify --dossier tests/fixtures/dossiers/morgan-vance.json --draft "Reduced CI/CD build execution duration by 80% across all platform developer repositories."`,
    expectExit: 1,
    label: 'CLI GC-F13 (80%) exits 1'
  },
  {
    cmd: `node bin/crew.js claim verify --dossier tests/fixtures/dossiers/morgan-vance.json --draft "Reduced event latency from 180ms to 41ms through Kafka in Go at Apex Cloud Technologies."`,
    expectExit: 1,
    label: 'CLI boundary 41ms exits 1'
  },
  {
    cmd: `node bin/crew.js claim verify --dossier tests/fixtures/dossiers/morgan-vance.json --draft "Built enterprise data warehouse using Snowflake at Apex Cloud Technologies."`,
    expectExit: 1,
    label: 'CLI ungrounded tool Snowflake exits 1'
  },
  {
    cmd: `node bin/crew.js claim verify --dossier tests/fixtures/dossiers/morgan-vance.json --draft "Holds CISSP and CompTIA Security+ certifications."`,
    expectExit: 1,
    label: 'CLI ungrounded credential CISSP exits 1'
  },
  {
    cmd: `node bin/crew.js claim verify --dossier tests/fixtures/dossiers/morgan-vance.json --draft "Awarded 1 patent grant for distributed consensus."`,
    expectExit: 1,
    label: 'CLI singular patent exits 1'
  }
];

for (const p of cliProbes) {
  runProbe(`CLI: ${p.label}`, () => {
    let exitCode = 0;
    try {
      execSync(p.cmd, { cwd: ROOT_DIR, stdio: 'pipe' });
    } catch (err) {
      exitCode = err.status;
    }
    assert.strictEqual(exitCode, p.expectExit, `Expected exit code ${p.expectExit}, got ${exitCode}`);
  });
}

// ----------------------------------------------------------------------------
// SUMMARY
// ----------------------------------------------------------------------------
console.log('\n================================================================');
console.log(`CHALLENGER M3 ITERATION 2 PROBE SUMMARY:`);
console.log(`  Passed: ${totalPassed}`);
console.log(`  Failed: ${totalFailed}`);
console.log('================================================================\n');

if (totalFailed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
