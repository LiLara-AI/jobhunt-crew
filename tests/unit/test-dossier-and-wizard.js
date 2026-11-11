'use strict';

/**
 * Unit Test: Candidate Dossier & Single-Question Intake Wizard
 *
 * Verifies:
 * 1. CareerDossier schema validation, employer binding, and claim lookup.
 * 2. Hard gating on unconfirmed [CONFIRM] claims via assertCanGenerate.
 * 3. Bi-directional JSON and Markdown serialization roundtrips.
 * 4. IntakeWizard turn-by-turn state machine (Q1 through Q10).
 * 5. TitleFinder verbatim quotes across Lateral, Stretch, and Pivot tiers.
 * 6. Deterministic WorkspaceBuilder output files and ledger record.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const { CareerDossier } = require('../../lib/honest-cv/dossier');
const { IntakeWizard, TitleFinder, WorkspaceBuilder } = require('../../lib/honest-cv/intake-wizard');
const morganFixture = require('../fixtures/dossiers/morgan-vance.json');
const alexFixture = require('../fixtures/dossiers/alex-rivera.json');

const suite = new TestSuite('M3: Candidate Dossier & Intake Wizard');

suite.test('CareerDossier successfully validates standard candidate fixtures', assert => {
  const dossier1 = new CareerDossier(morganFixture);
  assert.equal(dossier1.candidate.name, 'Dr. Morgan Vance');
  assert.equal(dossier1.claims.length, 10);
  assert.equal(dossier1.employers.length, 3);

  const dossier2 = new CareerDossier(alexFixture);
  assert.equal(dossier2.candidate.name, 'Alex Rivera');
  assert.equal(dossier2.claims.length, 4);
});

suite.test('CareerDossier rejects claims referencing unknown employerId', assert => {
  const badData = JSON.parse(JSON.stringify(morganFixture));
  badData.claims.push({
    id: 'CLM-BAD',
    employerId: 'emp_unknown_enterprise',
    category: 'fake',
    text: 'Fabricated claim',
    metrics: [],
    tools: [],
    role: 'None'
  });

  assert.throws(() => new CareerDossier(badData), /DOSSIER_VALIDATION_ERROR/);
});

suite.test('CareerDossier hard gates document generation when unconfirmed claims exist', assert => {
  const dossier = new CareerDossier(morganFixture);

  // All verified initially
  assert.equal(dossier.hasUnconfirmedClaims(), false);
  let initialPass = true;
  try { dossier.assertCanGenerate(['CLM-001', 'CLM-002']); } catch (e) { initialPass = false; }
  assert.ok(initialPass, 'assertCanGenerate should not throw initially');

  // Tag a claim for confirmation
  dossier.tagClaimForConfirmation('CLM-001', 'Confirm p99 latency reduction measurement source');
  assert.equal(dossier.hasUnconfirmedClaims(), true);
  assert.equal(dossier.getClaim('CLM-001').status, 'CONFIRM');

  // Gating must block document generation referencing unconfirmed claim
  assert.throws(() => dossier.assertCanGenerate(['CLM-001']), /DOSSIER_GUARDRAIL_VIOLATION/);

  // Global gating must also block when claimsUsed is omitted
  assert.throws(() => dossier.assertCanGenerate(), /DOSSIER_GUARDRAIL_VIOLATION/);

  // Confirming the claim clears the gate
  dossier.confirmClaim('CLM-001', 'Kafka Grafana dashboard metrics Q3 2022');
  assert.equal(dossier.hasUnconfirmedClaims(), false);
  assert.equal(dossier.getClaim('CLM-001').status, 'VERIFIED');
  let confirmedPass = true;
  try { dossier.assertCanGenerate(['CLM-001']); } catch (e) { confirmedPass = false; }
  assert.ok(confirmedPass, 'assertCanGenerate should not throw after confirmation');
});

suite.test('CareerDossier bi-directionally serializes to Markdown and back', assert => {
  const dossier = new CareerDossier({
    ...morganFixture,
    skills: {
      languages: ['Go', 'Rust', 'Python'],
      frameworks: ['gRPC', 'RabbitMQ'],
      infrastructure: ['Kubernetes', 'AWS', 'Docker'],
      databases: ['PostgreSQL', 'Redis'],
      architecturalDomains: ['Distributed Systems', 'Event-Driven Architecture']
    }
  });
  const md = dossier.toMarkdown();

  assert.ok(md.includes('# Career Dossier — Dr. Morgan Vance'));
  assert.ok(md.includes('## 6. Claim Verification Appendix'));
  assert.ok(md.includes('[CLM-001]'));

  const parsed = CareerDossier.fromMarkdown(md);
  assert.equal(parsed.candidate.name, 'Dr. Morgan Vance');
  assert.equal(parsed.claims.length, 10);
  assert.equal(parsed.employers.length, 3);
  assert.equal(parsed.degrees.length, dossier.degrees.length, 'Degrees must be preserved');
  assert.equal(parsed.certifications.length, dossier.certifications.length, 'Certifications must be preserved');
  assert.equal(parsed.skills.frameworks.length, dossier.skills.frameworks.length, 'Frameworks must be preserved');
  assert.equal(parsed.skills.databases.length, dossier.skills.databases.length, 'Databases must be preserved');
  assert.equal(parsed.skills.architecturalDomains.length, dossier.skills.architecturalDomains.length, 'Architectural domains preserved');
  assert.equal(parsed.degrees[0].thesis, dossier.degrees[0].thesis, 'Thesis must be preserved');
});

suite.test('CareerDossier exportForBlindReview completely scrubs PII and internal claim tags', assert => {
  const dossier = new CareerDossier(morganFixture);
  const scrubbed = dossier.exportForBlindReview();

  const scrubbedStr = JSON.stringify(scrubbed).toLowerCase();
  assert.equal(scrubbedStr.includes('morgan vance'), false);
  assert.equal(scrubbedStr.includes('morgan.vance@example.org'), false);
  assert.equal(scrubbedStr.includes('+966 50 000 0000'), false);
  assert.equal(scrubbedStr.includes('clm-001'), false);
  assert.equal(scrubbedStr.includes('clm-002'), false);
});

suite.test('TitleFinder extracts Lateral, Stretch, and Pivot tiers quoting verbatim CV lines', assert => {
  const recs = TitleFinder.generateRecommendations(morganFixture);
  assert.ok(recs.length >= 6);

  const lateral = recs.filter(r => r.tier === 'lateral');
  const stretch = recs.filter(r => r.tier === 'stretch');
  const pivot = recs.filter(r => r.tier === 'pivot');

  assert.ok(lateral.length >= 2);
  assert.ok(stretch.length >= 1);
  assert.ok(pivot.length >= 1);

  assert.equal(lateral[0].recommended, true);
  assert.equal(stretch[0].recommended, false);
  assert.ok(lateral[0].verbatimQuote.length > 20);
});

suite.test('IntakeWizard executes 10-turn monotonic state machine and builds workspace', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-wizard-test-'));

  try {
    const wizard = new IntakeWizard({
      workspaceDir: tmpDir,
      autoLoad: false
    });

    // Q1: Connectors
    let step = wizard.getCurrentStep();
    assert.equal(step.id, 'Q1_CONNECTORS');
    step = wizard.submitAnswer('all_connected');

    // Q2: CV Ingestion
    assert.equal(step.id, 'Q2_CV_INGESTION');
    step = wizard.submitAnswer(JSON.stringify(morganFixture));

    // Q3: Title Recommendations
    assert.equal(step.id, 'Q3_TITLE_RECOMMENDATIONS');
    assert.ok(step.choices.length >= 6);
    step = wizard.submitAnswer(['Principal Platform Architect', 'Lead Distributed Systems Engineer']);

    // Q4: Countries
    assert.equal(step.id, 'Q4_TARGET_COUNTRIES');
    step = wizard.submitAnswer(['Saudi Arabia', 'UAE']);

    // Q5: Cities & Work Modes
    assert.equal(step.id, 'Q5_CITIES_AND_WORK_MODE');
    step = wizard.submitAnswer({ cities: ['Riyadh', 'NEOM'], workModes: ['Hybrid', 'Remote'] });

    // Q6: Compensation & Policy
    assert.equal(step.id, 'Q6_COMPENSATION_AND_POLICY');
    step = wizard.submitAnswer({
      currency: 'SAR',
      minimumBase: 45000,
      targetTotal: 60000,
      disclosurePolicy: 'mandatory_only'
    });

    // Q7: Authorization & Knockouts
    assert.equal(step.id, 'Q7_AUTHORIZATION_AND_KNOCKOUTS');
    step = wizard.submitAnswer({
      workAuthorization: 'Transferable Iqama',
      noticePeriodDays: 30,
      excludedIndustries: ['consumer_products']
    });

    // Q8: Job Boards & Watchlist
    assert.equal(step.id, 'Q8_JOB_BOARDS_AND_WATCHLIST');
    step = wizard.submitAnswer({
      boards: [{ id: 'linkedin', readiness: 'signed_in' }],
      watchlist: ['NEOM', 'PIF', 'STC']
    });

    // Q9: Schedule & Automation
    assert.equal(step.id, 'Q9_SCHEDULE_AND_AUTOMATION');
    step = wizard.submitAnswer({
      startHour: 8,
      timezone: 'Asia/Riyadh',
      autoPrep: false
    });

    // Q10: Workspace Build
    assert.equal(step.id, 'Q10_WORKSPACE_BUILD');
    step = wizard.submitAnswer('build_now');

    assert.equal(wizard.isComplete(), true);

    // Build workspace files
    const result = await wizard.buildWorkspace(tmpDir);
    assert.equal(result.success, true);

    assert.ok(fs.existsSync(path.join(tmpDir, 'dossier.json')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'CareerDossier.md')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'search-config.json')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.crew', 'editorial-rules.json')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'editorial-rules.md')));

    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'search-config.json'), 'utf8'));
    assert.equal(cfg.targetLocations.countries[0], 'Saudi Arabia');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true }).then(result => {
    if (result.failed > 0) process.exitCode = 1;
  }).catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
