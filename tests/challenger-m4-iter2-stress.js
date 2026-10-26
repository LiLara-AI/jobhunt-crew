'use strict';
/**
 * Challenger M4 Iteration 2: Empirical Stress Test Harness
 *
 * Subsystems verified:
 * 1. JobScorer & TriageScorer Genuine Calculation & Knockout Boundary Testing
 * 2. Closing-Soon Priority Escalation Empirical Stress (1d-30d, clamp at 5.0, closed job invariance)
 * 3. Zero Age Penalty Invariant Stress Across 0d-1000d & Evidence-Based Closure Guard
 * 4. Arabic Linguistic Morphology & Scam Sentinel Probes
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { JobScorer, TriageScorer } = require('../lib/discovery/job-scorer');
const { ArabicQueryNormalizer, ScamDetector, KsaCountryPack } = require('../lib/discovery/ksa-pack');
const { GuardrailEngine } = require('../lib/guardrails/engine');

let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

function check(desc, fn) {
  totalChecks++;
  try {
    fn();
    passedChecks++;
    console.log(`  [PASS] ${desc}`);
  } catch (err) {
    failedChecks++;
    console.error(`  [FAIL] ${desc}: ${err.message}`);
  }
}

console.log('======================================================================');
console.log('CHALLENGER M4 ITERATION 2: EMPIRICAL STRESS TEST SUITE');
console.log('======================================================================\n');

// ============================================================================
// 1. JOBSCORER GENUINE CALCULATION & KNOCKOUT BOUNDARY TESTING
// ============================================================================
console.log('>>> SECTION 1: JobScorer Genuine Calculation & Knockout Boundaries');

// 1.1 Source Code / AST Integrity: No hardcoded return shortcuts
check('Source inspection: job-scorer.js contains no hardcoded bypass branch', () => {
  const code = fs.readFileSync(path.join(__dirname, '../lib/discovery/job-scorer.js'), 'utf8');
  assert.ok(!code.includes('if (!preferences || Object.keys(preferences).length === 0)'), 'Must not have empty-preferences bypass');
  assert.ok(!code.includes('score: 4.0,\n        status: \'PASS\''), 'Must not have hardcoded 4.0 bypass');
  assert.ok(code.includes('return JobScorer.scoreVacancy(job, this.preferences, this.candidateSkills);'), 'JobScorer delegates properly');
  assert.ok(code.includes('return JobScorer.scoreVacancy(job, preferences, skills);'), 'TriageScorer delegates unconditionally');
});

// 1.2 Senior Engineering Role with Empty Preferences: Genuine 4.2 score
const neomArchitectJob = {
  id: 'neom-arch-1',
  title: 'Principal Platform Architect',
  company: 'NEOM',
  location: 'NEOM, Saudi Arabia',
  isOpen: true,
  postedAgeDays: 0
};

check('JobScorer.scoreVacancy: NEOM Architect with {} yields genuine score 4.2, PASS, shortlisted', () => {
  const res = JobScorer.scoreVacancy(neomArchitectJob, {});
  assert.strictEqual(res.score, 4.2, `Expected 4.2, got ${res.score}`);
  assert.strictEqual(res.compositeScore, 4.2);
  assert.strictEqual(res.status, 'shortlisted');
  assert.strictEqual(res.verdict, 'PASS');
  assert.strictEqual(res.shortlisted, true);
  assert.strictEqual(res.isOpen, true);
  // Verify genuine dimension values
  assert.strictEqual(res.dimensions.titleMatch, 4.0);
  assert.strictEqual(res.dimensions.locationMatch, 4.0);
  assert.strictEqual(res.dimensions.techStackMatch, 3.5);
  assert.strictEqual(res.dimensions.seniorityMatch, 5.0);
  assert.strictEqual(res.dimensions.watchlistTier, 5.0);
  // Verify weighted math: (4.0*0.25) + (4.0*0.20) + (3.5*0.25) + (5.0*0.15) + (5.0*0.15) = 4.175 -> 4.2
  const calc = (4.0 * 0.25) + (4.0 * 0.20) + (3.5 * 0.25) + (5.0 * 0.15) + (5.0 * 0.15);
  assert.strictEqual(Number(calc.toFixed(1)), 4.2);
});

check('TriageScorer.scoreVacancy: NEOM Architect with {} yields identical genuine score 4.2', () => {
  const res = TriageScorer.scoreVacancy(neomArchitectJob, {});
  assert.strictEqual(res.score, 4.2);
  assert.strictEqual(res.status, 'shortlisted');
  assert.strictEqual(res.verdict, 'PASS');
  assert.strictEqual(res.shortlisted, true);
});

// 1.3 Ineligible roles: Barista, cashier, driver, localized HR director
check('Knockout: Barista with Saudization yields score 0, verdict FAIL, status FAIL, shortlisted false', () => {
  const job = {
    title: 'Barista',
    company: 'Local Roastery',
    location: 'Riyadh',
    description: 'Specialty coffee barista. Open only for Saudi nationals.',
    isOpen: true
  };
  const res = JobScorer.scoreVacancy(job, {});
  assert.strictEqual(res.score, 0);
  assert.strictEqual(res.verdict, 'FAIL');
  assert.strictEqual(res.status, 'FAIL');
  assert.strictEqual(res.shortlisted, false);
  assert.strictEqual(res.knockout, 'SAUDIZATION_RESTRICTED');
});

check('Knockout: Cashier with Arabic Saudization (للسعوديين فقط) yields score 0 and FAIL', () => {
  const job = {
    title: 'Cashier / كاشير',
    company: 'Hypermarket',
    location: 'Jeddah',
    description: 'وظيفة كاشير للسعوديين فقط دوام كامل',
    isOpen: true
  };
  const res = JobScorer.scoreVacancy(job, {});
  assert.strictEqual(res.score, 0);
  assert.strictEqual(res.verdict, 'FAIL');
  assert.strictEqual(res.status, 'FAIL');
  assert.strictEqual(res.shortlisted, false);
  assert.strictEqual(res.knockout, 'SAUDIZATION_RESTRICTED');
});

check('Knockout: Delivery Driver with Saudization yields score 0 and FAIL', () => {
  const job = {
    title: 'Delivery Driver',
    company: 'QuickFleet Logistics',
    location: 'Dammam',
    description: 'سائق توصيل - يشترط أن يكون المتقدم سعودي الجنسية',
    isOpen: true
  };
  const res = JobScorer.scoreVacancy(job, {});
  assert.strictEqual(res.score, 0);
  assert.strictEqual(res.verdict, 'FAIL');
  assert.strictEqual(res.status, 'FAIL');
  assert.strictEqual(res.shortlisted, false);
  assert.strictEqual(res.knockout, 'SAUDIZATION_RESTRICTED');
});

check('Knockout: HRSD 100% Localized Role (Human Resources Director) yields score 0 and FAIL', () => {
  const job = {
    title: 'Human Resources Director',
    company: 'NEOM',
    location: 'NEOM',
    isOpen: true
  };
  const res = JobScorer.scoreVacancy(job, {});
  assert.strictEqual(res.score, 0);
  assert.strictEqual(res.verdict, 'FAIL');
  assert.strictEqual(res.status, 'FAIL');
  assert.strictEqual(res.shortlisted, false);
  assert.strictEqual(res.knockout, 'SAUDIZATION_RESTRICTED');
});

check('Knockout: HRSD Localized Role (Government Relations Officer / معقب) yields score 0 and FAIL', () => {
  const job = {
    title: 'Government Relations Officer (GRO)',
    company: 'Aramco',
    location: 'Dhahran',
    isOpen: true
  };
  const res = JobScorer.scoreVacancy(job, {});
  assert.strictEqual(res.score, 0);
  assert.strictEqual(res.verdict, 'FAIL');
  assert.strictEqual(res.status, 'FAIL');
  assert.strictEqual(res.shortlisted, false);
  assert.strictEqual(res.knockout, 'SAUDIZATION_RESTRICTED');
});

// 1.4 Unpaid internships, unknown fake companies, closed jobs
check('Unpaid Internship: Evaluated with genuine rubric (seniority penalty 1.5, score 3.3)', () => {
  const job = {
    title: 'Software Engineering Intern',
    company: 'Small Unknown Corp',
    location: 'Riyadh',
    description: 'Unpaid 3-month summer internship',
    isOpen: true
  };
  const res = JobScorer.scoreVacancy(job, {});
  // seniority = 1.5 (junior/intern)
  assert.strictEqual(res.dimensions.seniorityMatch, 1.5);
  // watchlist = 3.0 (unknown company)
  assert.strictEqual(res.dimensions.watchlistTier, 3.0);
  // composite = 4*0.25 + 4*0.20 + 3.5*0.25 + 1.5*0.15 + 3.0*0.15 = 1 + 0.8 + 0.875 + 0.225 + 0.45 = 3.35 -> 3.3
  assert.strictEqual(res.score, 3.3);
  assert.strictEqual(res.verdict, 'MARGINAL');
  assert.notStrictEqual(res.score, 4.0, 'Must NOT be a hardcoded 4.0 shortcut');
});

check('Unknown company: Scores 3.7 vs Tier 1 enterprise 4.2 (genuine watchlist weighting)', () => {
  const unknownJob = {
    title: 'Principal Platform Architect',
    company: 'CompletelyUnknownStartup123XYZ',
    location: 'NEOM, Saudi Arabia',
    isOpen: true
  };
  const resUnknown = JobScorer.scoreVacancy(unknownJob, {});
  assert.strictEqual(resUnknown.dimensions.watchlistTier, 3.0, 'Unknown company should receive 3.0 watchlist tier');
  assert.strictEqual(resUnknown.score, 3.9);
  assert.ok(resUnknown.score < 4.2, 'Unknown company must score lower than NEOM (4.2)');
});

check('Excluded company knockout: Yields score 0, verdict FAIL, knockout EXCLUDED_COMPANY', () => {
  const res = JobScorer.scoreVacancy(neomArchitectJob, { excludedCompanies: ['NEOM'] });
  assert.strictEqual(res.score, 0);
  assert.strictEqual(res.verdict, 'FAIL');
  assert.strictEqual(res.status, 'FAIL');
  assert.strictEqual(res.shortlisted, false);
  assert.strictEqual(res.knockout, 'EXCLUDED_COMPANY');
});

check('Closed job (isOpen: false): Preserves isOpen=false, receives no closing-soon boost', () => {
  const closedJob = {
    ...neomArchitectJob,
    isOpen: false,
    deadlineAt: new Date(Date.now() + 86400000).toISOString() // 1 day deadline
  };
  const res = JobScorer.scoreVacancy(closedJob, {});
  assert.strictEqual(res.isOpen, false);
  assert.strictEqual(res.closingSoon, false);
  assert.strictEqual(res.priorityBadge, null);
  assert.strictEqual(res.urgencyFlag, null);
  assert.strictEqual(res.score, 4.2); // Not boosted to 4.7
});

// ============================================================================
// 2. CLOSING-SOON PRIORITY ESCALATION EMPIRICAL STRESS
// ============================================================================
console.log('\n>>> SECTION 2: Closing-Soon Priority Escalation Empirical Stress');

const baseOpenJob = {
  title: 'Principal Platform Architect',
  company: 'NEOM',
  location: 'NEOM',
  isOpen: true
};
const baseScore = JobScorer.scoreVacancy(baseOpenJob, {}).score; // 4.2

const deadlineCases = [
  { days: 1.0, shouldBoost: true, label: '1 day' },
  { days: 2.0, shouldBoost: true, label: '2 days' },
  { days: 3.0, shouldBoost: true, label: '3 days' },
  { days: 6.9, shouldBoost: true, label: '6.9 days (just inside 7.0d boundary)' },
  { days: 7.0, shouldBoost: true, label: '7.0 days (exact boundary)' },
  { days: 7.1, shouldBoost: false, label: '7.1 days (just outside 7.0d boundary)' },
  { days: 14.0, shouldBoost: false, label: '14 days' },
  { days: 30.0, shouldBoost: false, label: '30 days' },
  { days: null, shouldBoost: false, label: 'null deadline' }
];

for (const tc of deadlineCases) {
  check(`Closing-soon boundary [${tc.label}]: boost=${tc.shouldBoost}`, () => {
    const deadlineAt = tc.days !== null
      ? new Date(Date.now() + tc.days * 86400000).toISOString()
      : null;
    const job = { ...baseOpenJob, deadlineAt };
    const res = JobScorer.scoreVacancy(job, {});

    if (tc.shouldBoost) {
      assert.strictEqual(res.closingSoon, true, `Should be marked closingSoon for ${tc.label}`);
      assert.strictEqual(res.priorityBadge, 'Closing Soon');
      assert.strictEqual(res.urgencyFlag, 'CLOSING_SOON');
      assert.strictEqual(res.score, 4.7, `Expected boosted score 4.7, got ${res.score}`);
      assert.strictEqual(Number((res.score - baseScore).toFixed(1)), 0.5, 'Exact +0.5 boost');
    } else {
      assert.strictEqual(res.closingSoon, false, `Should NOT be marked closingSoon for ${tc.label}`);
      assert.strictEqual(res.priorityBadge, null);
      assert.strictEqual(res.urgencyFlag, null);
      assert.strictEqual(res.score, baseScore, `Score should remain unboosted (${baseScore})`);
    }
  });
}

check('Closed job with deadline today NEVER receives priority escalation boost', () => {
  const closedUrgentJob = {
    ...baseOpenJob,
    isOpen: false,
    deadlineAt: new Date(Date.now() + 3600000).toISOString() // 1 hour away
  };
  const res = JobScorer.scoreVacancy(closedUrgentJob, {});
  assert.strictEqual(res.isOpen, false);
  assert.strictEqual(res.closingSoon, false, 'Closed job must never be closingSoon=true');
  assert.strictEqual(res.priorityBadge, null);
  assert.strictEqual(res.score, baseScore, 'Closed job must not receive +0.5 boost');
});

check('Score clamping: Job with composite score 4.8 clamps to exactly 5.0 (not 5.3)', () => {
  // Construct a job that calculates to composite exactly 4.8
  const highPrefs = {
    targetTitles: ['Architect'],
    targetCities: ['NEOM'],
    companyWatchlist: ['NEOM']
  };
  const skills = ['Kubernetes', 'Cloud', 'Architecture', 'Kafka', 'Go'];
  const highJobUnboosted = {
    title: 'Principal Software Architect',
    company: 'NEOM',
    location: 'NEOM',
    description: 'Kubernetes Cloud Architecture Kafka Go',
    isOpen: true
  };
  const unboostedRes = JobScorer.scoreVacancy(highJobUnboosted, highPrefs, skills);
  assert.strictEqual(unboostedRes.score, 4.8, `Expected unboosted score 4.8, got ${unboostedRes.score}`);

  // Now add urgent deadline (+0.5 boost): 4.75 + 0.5 = 5.25 -> clamped at 5.0 (NOT 5.3)
  const highJobBoosted = {
    ...highJobUnboosted,
    deadlineAt: new Date(Date.now() + 86400000).toISOString()
  };
  const boostedRes = JobScorer.scoreVacancy(highJobBoosted, highPrefs, skills);
  assert.strictEqual(boostedRes.closingSoon, true);
  assert.strictEqual(boostedRes.score, 5.0, `Score must clamp to 5.0, got ${boostedRes.score}`);
  assert.strictEqual(boostedRes.compositeScore, 5.0);
  assert.notStrictEqual(boostedRes.score, 5.3, 'Must NOT be 5.3; clamping at 5.0 is enforced');
});

// ============================================================================
// 3. ZERO AGE PENALTY INVARIANT STRESS ACROSS 0d-1000d
// ============================================================================
console.log('\n>>> SECTION 3: Zero Age Penalty Invariant Stress (0d - 1000d)');

const stressAges = [0, 1, 15, 30, 45, 60, 90, 120, 180, 365, 730, 1000];

check('Zero Age Penalty Invariant: 100% score equality across all 12 age points', () => {
  const baselineJob = {
    title: 'Principal Platform Architect',
    company: 'NEOM',
    location: 'NEOM, Saudi Arabia',
    postedAgeDays: 0,
    isOpen: true
  };
  const baselineRes = JobScorer.scoreVacancy(baselineJob, {});

  for (const age of stressAges) {
    const agedJob = {
      ...baselineJob,
      postedAgeDays: age
    };
    const agedRes = JobScorer.scoreVacancy(agedJob, {});

    assert.strictEqual(
      agedRes.score,
      baselineRes.score,
      `Score at age ${age}d (${agedRes.score}) must equal baseline (${baselineRes.score})`
    );
    assert.strictEqual(
      agedRes.compositeScore,
      baselineRes.compositeScore,
      `Composite score at age ${age}d must equal baseline`
    );
    assert.strictEqual(
      agedRes.verdict,
      baselineRes.verdict,
      `Verdict at age ${age}d must equal baseline`
    );
    assert.strictEqual(
      agedRes.status,
      baselineRes.status,
      `Status at age ${age}d must equal baseline`
    );
    assert.strictEqual(
      agedRes.shortlisted,
      baselineRes.shortlisted,
      `Shortlist decision at age ${age}d must equal baseline`
    );
    assert.strictEqual(
      agedRes.ageBadge,
      `Open · Posted ${age}d ago`,
      `Age badge must be strictly informational: "Open · Posted ${age}d ago"`
    );
    // Dimension breakdown check
    for (const [dim, val] of Object.entries(baselineRes.dimensions)) {
      assert.strictEqual(agedRes.dimensions[dim], val, `Dimension ${dim} at age ${age}d must match baseline`);
    }
  }
});

check('canCloseVacancy strictly rejects all age-based closure signals', () => {
  const dummy = { title: 'Architect', isOpen: true };
  const rejectedEvidence = [
    { type: 'age' },
    { type: 'age_limit' },
    { type: 'posting_age' },
    { type: 'days_old' },
    { type: 'AGE' },
    { type: 'POSTING_AGE' },
    { type: 'stale' },
    { type: 'older_than_30' },
    { type: 'older_than_60' },
    { type: 'posting_age', days: 1000 }
  ];

  for (const ev of rejectedEvidence) {
    assert.strictEqual(JobScorer.canCloseVacancy(dummy, ev), false);
    assert.strictEqual(TriageScorer.canCloseVacancy(dummy, ev), false);
  }

  // Valid non-age evidence accepted
  const acceptedEvidence = [
    { type: 'http_404', proof: '404' },
    { type: 'http_410', proof: '410' },
    { type: 'explicit_closure_notice', proof: 'Position closed' },
    { type: 'passed_deadline', proof: 'Deadline passed' },
    { type: 'position_filled', proof: 'Hired' }
  ];
  for (const ev of acceptedEvidence) {
    assert.strictEqual(JobScorer.canCloseVacancy(dummy, ev), true);
    assert.strictEqual(TriageScorer.canCloseVacancy(dummy, ev), true);
  }
});

check('GuardrailEngine.validateClosure rejects age penalties with GUARDRAIL_VIOLATION', () => {
  const ageEvidenceList = [
    { type: 'posting_age', proof: 'Older than 90 days', days: 90 },
    { type: 'age_limit', proof: 'Age expired', days: 180 },
    { type: 'stale', proof: 'Stale posting', days: 365 }
  ];

  for (const ev of ageEvidenceList) {
    assert.throws(
      () => GuardrailEngine.validateClosure(ev),
      /GUARDRAIL_VIOLATION.*posting age/i,
      `GuardrailEngine must throw GUARDRAIL_VIOLATION on age evidence: ${JSON.stringify(ev)}`
    );
  }

  // Valid closure passes
  assert.strictEqual(
    GuardrailEngine.validateClosure({ type: 'HTTP_404_OR_JOB_REMOVED', proof: '404' }),
    true
  );
});

// ============================================================================
// 4. ARABIC LINGUISTIC MORPHOLOGY & SCAM SENTINEL PROBES
// ============================================================================
console.log('\n>>> SECTION 4: Arabic Linguistic Morphology & Scam Sentinel Probes');

check('Arabic Morphology: Proclitic prefixes match target root (ال, و, ف, ب, ك, ل, لل, وال, فال, بال, كال)', () => {
  const baseQuery = 'مهندس';
  const prefixVariants = [
    { prefix: 'ال', text: 'المهندس المعماري' },
    { prefix: 'و', text: 'ومشرف ومهندس المشروع' },
    { prefix: 'ف', text: 'فمهندس النظم' },
    { prefix: 'ب', text: 'الاستعانة بمهندس ذكي' },
    { prefix: 'ك', text: 'يعمل كمهندس برمجيات' },
    { prefix: 'ل', text: 'شاغر لمهندس سحابي' },
    { prefix: 'لل', text: 'فرصة للمهندس المبدع' },
    { prefix: 'وال', text: 'المصمم والمهندس' },
    { prefix: 'فال', text: 'المبرمج فالمهندس' },
    { prefix: 'بال', text: 'الالتحاق بالمهندس' },
    { prefix: 'كال', text: 'كالمهندس المحترف' }
  ];

  for (const { prefix, text } of prefixVariants) {
    const matched = ArabicQueryNormalizer.matches(text, baseQuery);
    assert.strictEqual(matched, true, `Prefix "${prefix}" in "${text}" should match "${baseQuery}"`);
  }
});

check('Arabic Morphology: Enclitic suffixes match target root (ين, ون, ات, ان, ة, ية)', () => {
  const baseQuery = 'مهندس';
  const suffixVariants = [
    { suffix: 'ين', text: 'نبحث عن مهندسين سحابيين' },
    { suffix: 'ون', text: 'مهندسون سعوديون' },
    { suffix: 'ات', text: 'توظيف مهندسات في نيوم' },
    { suffix: 'ان', text: 'مطلوب مهندسان' },
    { suffix: 'ة', text: 'مهندسة ذكاء اصطناعي' }
  ];

  for (const { suffix, text } of suffixVariants) {
    const matched = ArabicQueryNormalizer.matches(text, baseQuery);
    assert.strictEqual(matched, true, `Suffix "${suffix}" in "${text}" should match "${baseQuery}"`);
  }

  // Nisba suffix (ية)
  assert.strictEqual(ArabicQueryNormalizer.matches('وظائف برمجية متطورة', 'برمجة'), true);
});

check('Arabic Morphology: Tashkeel diacritics and Tatweel normalization', () => {
  const diacritized = 'مُـهَـنْـدِسٌ'; // Contains tashkeel + tatweel
  const normalized = ArabicQueryNormalizer.normalize(diacritized);
  assert.strictEqual(normalized, 'مهندس', `Expected 'مهندس', got '${normalized}'`);

  const matched = ArabicQueryNormalizer.matches(`مطلوب ${diacritized} أول`, 'مهندس');
  assert.strictEqual(matched, true);

  // Alef variants
  assert.strictEqual(ArabicQueryNormalizer.normalize('إدارة'), 'اداره');
  assert.strictEqual(ArabicQueryNormalizer.normalize('آلات'), 'الات');
  assert.strictEqual(ArabicQueryNormalizer.normalize('أرامكو'), 'ارامكو');
});

check('Scam Sentinel: Upfront fee demands flagged as CRITICAL scam risk', () => {
  const scamSamples = [
    'Applicants must pay a visa processing fee of 500 SAR',
    'Mandatory medical examination fee payable upfront',
    'Deposit required to secure employment visa'
  ];
  for (const sample of scamSamples) {
    const res = ScamDetector.evaluate(sample);
    assert.strictEqual(res.isColdOfferScamRisk, true);
    assert.ok(res.riskScore >= 40);
  }
});

check('Scam Sentinel: Untraceable payment rails flagged as CRITICAL scam risk', () => {
  const scamSamples = [
    'Send onboarding payment via Western Union to the agent',
    'Submit registration deposit in cryptocurrency (Bitcoin or USDT)',
    'Transfer via MoneyGram to complete background check'
  ];
  for (const sample of scamSamples) {
    const res = ScamDetector.evaluate(sample);
    assert.strictEqual(res.isColdOfferScamRisk, true);
    assert.ok(res.riskScore >= 40);
  }
});

check('Scam Sentinel: Unsolicited cold offers & webmail impersonation flagged', () => {
  const res = ScamDetector.evaluate(
    'Congratulations! Direct hiring without interview for NEOM project.',
    { senderEmail: 'hr-neom-careers@gmail.com', companyName: 'NEOM' }
  );
  assert.strictEqual(res.isColdOfferScamRisk, true);
  assert.ok(res.riskScore >= 50);
  assert.ok(res.indicators.some(i => i.type === 'SPOOFED_LOOKALIKE_DOMAIN'));
  assert.ok(res.indicators.some(i => i.type === 'UNSOLICITED_COLD_OFFER'));
});

// ============================================================================
// SUMMARY
// ============================================================================
console.log('\n======================================================================');
console.log(`TOTAL CHECKS : ${totalChecks} | PASSED: ${passedChecks} | FAILED: ${failedChecks}`);
console.log('======================================================================');

if (failedChecks > 0) {
  process.exit(1);
} else {
  console.log('>>> ALL EMPIRICAL CHALLENGER STRESS CHECKS PASSED (EXIT 0) <<<\n');
  process.exit(0);
}
