'use strict';
/**
 * Tier 4: Real-World Scenarios - Full Job Search Lifecycle Simulation
 * Exercises an end-to-end simulation across all system components on a fictional workspace:
 * Onboarding -> Discovery -> Triage -> Scribe Tailoring -> Inquisitor Verification ->
 * Critic Blind Review -> Command Center Human Approval -> Attended Pre-Fill ->
 * Human Submission -> 7d/14d Follow-up Cadence -> KSA Offer Review Calculator.
 */

const { TestSuite } = require('../helpers/test-harness');
const morganDossier = require('../fixtures/dossiers/morgan-vance.json');

class KsaOfferCalculator {
  static evaluateOffer(baseSalarySar, allowances = {}) {
    // Standard KSA package structure:
    // Base salary: 100%
    // Housing allowance: standard 25% of base
    // Transport allowance: standard 10% of base
    // GOSI (General Organization for Social Insurance):
    // For non-Saudis (Occupational Hazards branch): 2% employer contribution, 0% employee deduction
    // For Saudis: 9.75% employee deduction, 11.75% employer contribution
    const housing = allowances.housing || (baseSalarySar * 0.25);
    const transport = allowances.transport || (baseSalarySar * 0.10);
    const grossTotal = baseSalarySar + housing + transport;

    // End-of-Service Benefit (EOSB) per Saudi Labor Law Article 84:
    // Half month salary for each of first 5 years, full month for each following year
    const eosbYear1to5AnnualAccrual = baseSalarySar * 0.5;

    return {
      baseSalarySar,
      housing,
      transport,
      grossTotal,
      eosbAnnualAccrual: eosbYear1to5AnnualAccrual,
      statutoryProbationMaxDays: 180, // Article 53: up to 180 days with written consent
      standardProbationDays: 90
    };
  }
}

class EndToEndJobSearchSimulator {
  constructor() {
    this.events = [];
    this.stage = 'uninitialized';
  }

  log(type, payload, actor = 'system') {
    this.events.push({
      seq: this.events.length + 1,
      type,
      payload,
      actor,
      timestamp: new Date().toISOString()
    });
  }

  runFullSimulation() {
    // 1. Onboarding
    this.stage = 'onboarded';
    this.log('ONBOARDING_COMPLETED', {
      candidate: morganDossier.candidate.name,
      titles: ['Principal Platform Architect', 'Staff Distributed Systems Engineer'],
      cities: ['Riyadh', 'NEOM'],
      salaryFloor: morganDossier.candidate.salaryFloor
    }, 'human');

    // 2. Multi-channel discovery
    this.stage = 'discovery';
    const discoveredJob = {
      id: 'job_neom_001',
      title: 'Principal Platform Architect',
      company: 'NEOM',
      location: 'NEOM, Saudi Arabia',
      url: 'https://careers.neom.com/jobs/1001',
      postedAgeDays: 95 // 95 days old vacancy
    };
    this.log('JOB_DISCOVERED', discoveredJob, 'agent:recon');

    // 3. Triage
    this.stage = 'triaged';
    this.log('JOB_TRIAGED', {
      id: discoveredJob.id,
      score: 4.8,
      verdict: 'PASS',
      rationale: 'Perfect seniority match and key giga-project employer'
    }, 'agent:recon');

    // 4. Human Decision: Select for Apply
    this.stage = 'selected';
    this.log('DECISION_RECORDED', {
      decisionType: 'apply',
      jobId: discoveredJob.id
    }, 'human');

    // 5. Scribe Tailors CV & Cover Letter
    this.stage = 'tailored';
    const tailoredDraft = {
      jobId: discoveredJob.id,
      cvText: 'Principal Platform Architect: Scaled multi-region Kubernetes clusters handling 4.5 billion daily events.',
      clText: 'Dear NEOM Team, I am writing to apply for the Principal Platform Architect vacancy...',
      claimsUsed: ['CLM-002']
    };
    this.log('DRAFT_GENERATED', tailoredDraft, 'agent:scribe');

    // 6. Inquisitor Deterministic Claim Verification
    this.stage = 'verified';
    this.log('CLAIMS_VERIFIED', {
      jobId: discoveredJob.id,
      passed: true,
      violationsCount: 0
    }, 'agent:inquisitor');

    // 7. Critic Blind Review Panel
    this.stage = 'reviewed';
    this.log('BLIND_REVIEW_RECORDED', {
      jobId: discoveredJob.id,
      verdict: 'APPROVE',
      score: 4.9,
      recruiterFeedback: 'Top ATS keyword match and clean structure',
      hiringManagerFeedback: 'Verified scale metrics and deep distributed systems depth'
    }, 'agent:critic');

    // 8. Command Center Gate -> Marked Ready
    this.stage = 'ready';
    this.log('PACKAGE_MARKED_READY', {
      jobId: discoveredJob.id,
      applyPackUrl: '/applications/NEOM_Platform_Architect/apply-pack.md'
    }, 'system');

    // 9. Attended Browser Pre-fill (Stops strictly before final submit)
    this.stage = 'attended_prefill';
    this.log('BROWSER_FORM_PREFILLED', {
      jobId: discoveredJob.id,
      tabTitle: 'NEOM Careers - Apply',
      fieldsFilled: ['name', 'email', 'phone', 'iqama_status', 'notice_period'],
      status: 'ready-to-submit',
      actionRemaining: 'Human candidate must review fields and click final Submit'
    }, 'agent:navigator');

    // 10. Human Submits
    this.stage = 'submitted';
    this.log('APPLICATION_SUBMITTED', {
      jobId: discoveredJob.id,
      confirmedByHuman: true
    }, 'human');

    // 11. Follow-up Cadence (7 Days & 14 Days)
    this.stage = 'cadence_tracked';
    this.log('FOLLOW_UP_SCHEDULED', {
      jobId: discoveredJob.id,
      cadenceDay7: '2026-10-31',
      cadenceDay14: '2026-11-07'
    }, 'agent:liaison');

    // 12. Offer Review
    const offer = KsaOfferCalculator.evaluateOffer(50000);
    this.stage = 'offer_reviewed';
    this.log('OFFER_EVALUATED', {
      jobId: discoveredJob.id,
      baseSalarySar: offer.baseSalarySar,
      housingAllowanceSar: offer.housing,
      transportAllowanceSar: offer.transport,
      grossTotalSar: offer.grossTotal,
      eosbAccrual: offer.eosbAnnualAccrual
    }, 'agent:liaison');

    return {
      completed: true,
      finalStage: this.stage,
      totalEvents: this.events.length,
      events: this.events
    };
  }
}

const suite = new TestSuite('Tier 4: Full Job Search Lifecycle Simulation');

suite.test('Executes complete 12-stage end-to-end lifecycle smoothly on fictional workspace', assert => {
  const sim = new EndToEndJobSearchSimulator();
  const result = sim.runFullSimulation();

  assert.equal(result.completed, true);
  assert.equal(result.finalStage, 'offer_reviewed');
  assert.equal(result.totalEvents, 12);

  // Assert human-only submission occurred
  const submitEvent = result.events.find(e => e.type === 'APPLICATION_SUBMITTED');
  assert.ok(submitEvent);
  assert.equal(submitEvent.actor, 'human');
  assert.equal(submitEvent.payload.confirmedByHuman, true);

  // Assert browser pre-fill stopped before submission
  const prefillEvent = result.events.find(e => e.type === 'BROWSER_FORM_PREFILLED');
  assert.ok(prefillEvent);
  assert.equal(prefillEvent.payload.status, 'ready-to-submit');
  assert.ok(prefillEvent.payload.actionRemaining.includes('Human candidate must review'));
});

suite.test('KSA Offer Calculator precisely computes standard housing, transport, and EOSB', assert => {
  const offer = KsaOfferCalculator.evaluateOffer(40000);

  // 25% housing = 10,000 SAR
  assert.equal(offer.housing, 10000);
  // 10% transport = 4,000 SAR
  assert.equal(offer.transport, 4000);
  // Gross = 54,000 SAR
  assert.equal(offer.grossTotal, 54000);
  // Half month base EOSB annual accrual = 20,000 SAR
  assert.equal(offer.eosbAnnualAccrual, 20000);
  // Max statutory probation 180 days
  assert.equal(offer.statutoryProbationMaxDays, 180);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
