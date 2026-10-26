'use strict';
/**
 * JobHunt Crew — M4 Iteration 3 Adversarial Empirical Challenge Suite
 *
 * Exhaustively stress-tests:
 * 1. Zero Age Penalty Invariant (vacancies 0d to 1,000d identical, age closure rejected).
 * 2. KSA Saudization & Scam Sentinel (restricted roles score 0 / FAIL, scam patterns flagged).
 * 3. Closing-Soon Priority Boost (+0.5 boost within 7d, clamped at 5.0, closed vacancies ineligible).
 * 4. Rate Limiting & Negative Boundary (negative Retry-After -> null, token bucket capacity respected).
 */

const { TestSuite } = require('../helpers/test-harness');
const { JobScorer, TriageScorer } = require('../../lib/discovery/job-scorer');
const { KsaCountryPack, ScamDetector, IqamaTransferEngine } = require('../../lib/discovery/ksa-pack');
const {
  DomainTokenBucketRateLimiter,
  parseRetryAfter,
  computeExponentialBackoff,
  DEFAULT_DOMAIN_PROFILES
} = require('../../lib/discovery/rate-limiter');
const { GuardrailEngine } = require('../../lib/guardrails/engine');

const suite = new TestSuite('M4 Iteration 3 Adversarial Empirical Challenge Suite');

// ============================================================================
// 1. ZERO AGE PENALTY INVARIANT ACROSS 0d TO 1,000d & AGE CLOSURE REJECTION
// ============================================================================

suite.test('1.1 Zero Age Penalty: Open vacancies aged 0d to 1,000d receive strictly identical scores across multiple candidate profiles', assert => {
  const ages = [0, 1, 3, 7, 14, 30, 45, 60, 90, 120, 180, 240, 365, 500, 730, 1000];

  const profiles = [
    {
      name: 'Lateral Match at NEOM',
      jobTemplate: { title: 'Principal Platform Architect', company: 'NEOM', location: 'Riyadh', isOpen: true },
      preferences: { targetTitles: ['Principal Platform Architect'], targetCities: ['Riyadh'], companyWatchlist: ['NEOM'] },
      skills: ['Node.js', 'Docker', 'Kubernetes', 'Cloud']
    },
    {
      name: 'Tech Lead at Tamara with Partial Match',
      jobTemplate: { title: 'Senior Backend Engineer', company: 'Tamara', location: 'Riyadh', isOpen: true, description: 'Requires Node.js, PostgreSQL, Docker, AWS, Redis' },
      preferences: { targetTitles: ['Software Engineer'], targetCities: ['Riyadh'], companyWatchlist: ['Tamara'] },
      skills: ['Node.js', 'PostgreSQL', 'Docker', 'AWS', 'Redis']
    },
    {
      name: 'Junior Role with No Preferences',
      jobTemplate: { title: 'Junior Frontend Developer', company: 'Generic Corp', location: 'Jeddah', isOpen: true },
      preferences: {},
      skills: []
    },
    {
      name: 'Marginal Match with Distant City',
      jobTemplate: { title: 'Database Administrator', company: 'Salla', location: 'Makkah', isOpen: true },
      preferences: { targetTitles: ['DevOps Engineer'], targetCities: ['Riyadh'], companyWatchlist: ['Salla'] },
      skills: ['Linux']
    }
  ];

  for (const prof of profiles) {
    const baseJob = { ...prof.jobTemplate, postedAgeDays: 0 };
    const baseResult = JobScorer.scoreVacancy(baseJob, prof.preferences, prof.skills);

    for (const age of ages) {
      const agedJob = { ...prof.jobTemplate, postedAgeDays: age };
      const agedResult = JobScorer.scoreVacancy(agedJob, prof.preferences, prof.skills);

      // Score must be strictly identical
      assert.equal(agedResult.score, baseResult.score, `[${prof.name}] Score at age ${age}d (${agedResult.score}) must match age 0d (${baseResult.score})`);
      assert.equal(agedResult.compositeScore, baseResult.compositeScore, `[${prof.name}] Composite at age ${age}d must match age 0d`);
      assert.equal(agedResult.verdict, baseResult.verdict, `[${prof.name}] Verdict at age ${age}d must match age 0d`);
      assert.equal(agedResult.status, baseResult.status, `[${prof.name}] Status at age ${age}d must match age 0d`);
      assert.equal(agedResult.shortlisted, baseResult.shortlisted, `[${prof.name}] Shortlisted at age ${age}d must match age 0d`);

      // Dimension breakdown must match exactly
      assert.deepEqual(agedResult.dimensions, baseResult.dimensions, `[${prof.name}] Dimensions at age ${age}d must match age 0d`);

      // Age badge must be informational only
      assert.ok(agedResult.ageBadge.includes(`${age}d ago`), `[${prof.name}] Badge must display posted days`);
    }
  }
});

suite.test('1.2 Zero Age Penalty: Vacancy with postedDate timestamp calculates identical score as explicit postedAgeDays', assert => {
  const jobExplicit = {
    title: 'Staff Security Engineer',
    company: 'Public Investment Fund',
    location: 'Riyadh',
    postedAgeDays: 90,
    isOpen: true
  };
  const resultExplicit = JobScorer.scoreVacancy(jobExplicit);

  // Job with equivalent ISO date 90 days ago
  const date90dAgo = new Date(Date.now() - 90 * 86400000).toISOString();
  const jobDate = {
    title: 'Staff Security Engineer',
    company: 'Public Investment Fund',
    location: 'Riyadh',
    postedDate: date90dAgo,
    isOpen: true
  };
  const resultDate = JobScorer.scoreVacancy(jobDate);

  assert.equal(resultDate.score, resultExplicit.score, 'Scores calculated from postedDate and postedAgeDays must match');
  assert.equal(resultDate.verdict, resultExplicit.verdict);
});

suite.test('1.3 Age Closure Rejection: JobScorer and GuardrailEngine reject any age-based closure attempt unconditionally', assert => {
  const ancientJob = { id: 'job_ancient_1000', title: 'VP Engineering', postedAgeDays: 1000, isOpen: true };

  // JobScorer.canCloseVacancy boundary checks
  assert.equal(JobScorer.canCloseVacancy(ancientJob, { type: 'posting_age', days: 1000 }), false);
  assert.equal(JobScorer.canCloseVacancy(ancientJob, { type: 'age_limit', days: 60 }), false);
  assert.equal(JobScorer.canCloseVacancy(ancientJob, { type: 'days_old', days: 30 }), false);
  assert.equal(JobScorer.canCloseVacancy(ancientJob, { type: 'age', days: 90 }), false);
  assert.equal(JobScorer.canCloseVacancy(ancientJob, null), false);
  assert.equal(JobScorer.canCloseVacancy(ancientJob, {}), false);

  // Legitimate closure with evidence succeeds
  assert.equal(JobScorer.canCloseVacancy(ancientJob, { type: 'http_404', proof: 'HTTP 404 Not Found' }), true);
  assert.equal(JobScorer.canCloseVacancy(ancientJob, { type: 'http_410', proof: 'HTTP 410 Gone' }), true);
  assert.equal(JobScorer.canCloseVacancy(ancientJob, { type: 'explicit_closure_notice', proof: 'Application deadline passed' }), true);
  assert.equal(JobScorer.canCloseVacancy(ancientJob, { type: 'position_filled', proof: 'Hiring completed' }), true);

  // GuardrailEngine.validateClosure boundary checks
  assert.throws(() => {
    GuardrailEngine.validateClosure(ancientJob.id, 'Vacancy is 120 days old', 'posting_age', '120 days old');
  }, /GUARDRAIL_VIOLATION.*posting age/i);

  assert.throws(() => {
    GuardrailEngine.validateClosure({ type: 'posting_age', days: 120, proof: 'Old requisition' });
  }, /GUARDRAIL_VIOLATION.*posting age/i);

  assert.throws(() => {
    GuardrailEngine.validateClosure({ type: 'stale', reason: 'older than 30 days', proof: 'stale listing' });
  }, /GUARDRAIL_VIOLATION.*posting age/i);

  // Legitimate closure through GuardrailEngine
  assert.ok(GuardrailEngine.validateClosure(ancientJob.id, 'Removed from careers board', 'HTTP_404_OR_JOB_REMOVED', '404 from ATS API'));
  assert.ok(GuardrailEngine.validateClosure(ancientJob.id, 'Candidate hired', 'EXPLICIT_NOTICE_NO_LONGER_ACCEPTING', 'Banner displayed'));
});

// ============================================================================
// 2. KSA SAUDIZATION & SCAM SENTINEL HARDENING
// ============================================================================

suite.test('2.1 KSA Saudization: Explicit English and Arabic phrasing results in score 0.0 and FAIL for non-Saudi candidates', assert => {
  const restrictedPhrases = [
    // English phrasing
    'This position is open for Saudi nationals only',
    'Candidate requirement: Saudi citizens only',
    'Role is strictly for Saudis only',
    'Position reserved for Saudi nationals',
    'Due to saudization regulations, only Saudi applicants will be considered',
    // Arabic phrasing
    'هذه الوظيفة مخصصة للسعوديين فقط',
    'الوظيفة للسعوديين والسعوديات فقط',
    'يشترط أن يكون المتقدم سعودي الجنسية',
    'وظيفة مسعودة بالكامل بنسبة 100%',
    'حصر الوظيفة على المواطنين'
  ];

  for (const phrase of restrictedPhrases) {
    const job = {
      id: 'job_saudization_test',
      title: 'Senior Solutions Architect',
      company: 'Riyad Bank',
      location: 'Riyadh',
      isOpen: true,
      description: `Join our team. Requirements: ${phrase}`
    };

    // Non-Saudi (Transferable Iqama)
    const resultIqama = JobScorer.scoreVacancy(job, { candidateStatus: 'Transferable Iqama' });
    assert.equal(resultIqama.score, 0.0, `Restricted role ("${phrase}") must yield score 0.0 for Iqama candidate`);
    assert.equal(resultIqama.verdict, 'FAIL');
    assert.equal(resultIqama.status, 'FAIL');
    assert.equal(resultIqama.shortlisted, false);
    assert.equal(resultIqama.knockout, 'SAUDIZATION_RESTRICTED');

    // Saudi National candidate is eligible and receives priority
    const resultSaudi = JobScorer.scoreVacancy(job, { candidateStatus: 'Saudi National' });
    assert.ok(resultSaudi.score >= 3.0, `Restricted role must be eligible for Saudi National (score=${resultSaudi.score})`);
    assert.equal(resultSaudi.verdict, 'PASS');
  }
});

suite.test('2.2 KSA Saudization: 100% HRSD Localized professions trigger automatic knockout for non-Saudi candidates', assert => {
  const localizedRoles = [
    { title: 'Human Resources Director', company: 'ROSHN' },
    { title: 'HR Officer', company: 'Almarai' },
    { title: 'Government Relations Officer (GRO)', company: 'Diriyah Company' },
    { title: 'معقب علاقات حكومية', company: 'STC' },
    { title: 'Procurement Clerk', company: 'SABIC' },
    { title: 'مندوب مشتريات', company: 'New Murabba' },
    { title: 'Front Desk Receptionist', company: 'Red Sea Global' },
    { title: 'حارس أمن', company: 'Qiddiya' }
  ];

  for (const role of localizedRoles) {
    const job = {
      title: role.title,
      company: role.company,
      location: 'Riyadh',
      isOpen: true
    };

    const res = JobScorer.scoreVacancy(job, { candidateStatus: 'Transferable Iqama' });
    assert.equal(res.score, 0.0, `Localized profession "${role.title}" must yield score 0.0`);
    assert.equal(res.verdict, 'FAIL');
    assert.equal(res.status, 'FAIL');
    assert.equal(res.shortlisted, false);
    assert.equal(res.knockout, 'SAUDIZATION_RESTRICTED');
  }
});

suite.test('2.3 Scam Sentinel: Detects upfront fees, untraceable payments, WhatsApp/Telegram only, and cold offers', assert => {
  const scamScenarios = [
    {
      name: 'Upfront Visa Processing Fee (Single critical indicator)',
      text: 'Congratulations! Send a refundable visa deposit of 450 USD to secure your appointment.',
      expectScam: true,
      minScore: 45,
      expectedIndicator: 'UPFRONT_FEE_DEMAND'
    },
    {
      name: 'Western Union / Crypto rails (Single critical indicator)',
      text: 'Please transfer the document attestation fee via Western Union or USDT Bitcoin wallet.',
      expectScam: true,
      minScore: 40,
      expectedIndicator: 'UNTRACEABLE_PAYMENT_CHANNEL'
    },
    {
      name: 'Unconditional Cold Offer + WhatsApp Recruitment (Compound scam >= 40)',
      text: 'Congratulations! Direct hiring notice: Unconditional job offer enclosed without interview. Contact via WhatsApp only: +966500000000.',
      expectScam: true,
      minScore: 45,
      expectedIndicator: 'UNSOLICITED_COLD_OFFER'
    },
    {
      name: 'Free Webmail Enterprise Impersonation + Cold Offer',
      text: 'Selected without interview at NEOM. Official appointment letter enclosed.',
      metadata: { senderEmail: 'careers-neom@gmail.com', companyName: 'NEOM' },
      expectScam: true,
      minScore: 55,
      expectedIndicator: 'SPOOFED_LOOKALIKE_DOMAIN'
    },
    {
      name: 'Informal WhatsApp-Only Application Channel (Flags indicator with risk score 25)',
      text: 'Send your CV to WhatsApp +966500000000.',
      expectScam: false, // Score 25 (threshold 40)
      minScore: 25,
      expectedIndicator: 'UNOFFICIAL_COMMUNICATION_CHANNEL'
    }
  ];

  for (const scenario of scamScenarios) {
    const evalResult = ScamDetector.evaluate(scenario.text, scenario.metadata || {});
    assert.equal(evalResult.isColdOfferScamRisk, scenario.expectScam, `[${scenario.name}] Scam risk mismatch`);
    assert.ok(evalResult.riskScore >= scenario.minScore, `[${scenario.name}] Risk score must be >= ${scenario.minScore} (got ${evalResult.riskScore})`);
    assert.ok(evalResult.indicators.some(i => i.type === scenario.expectedIndicator), `[${scenario.name}] Missing indicator ${scenario.expectedIndicator}`);

    // Verify compliance evaluation
    const compliance = KsaCountryPack.evaluateCompliance(scenario.text, 'Transferable Iqama', scenario.metadata || {});
    if (scenario.expectScam) {
      assert.equal(compliance.eligible, false, `[${scenario.name}] Compliance must be ineligible`);
      assert.equal(compliance.isColdOfferScamRisk, true);
    }
  }

  // Verify that jobs with scam descriptions fail triage in JobScorer
  const scamJob1 = {
    title: 'Senior Architect',
    company: 'NEOM',
    location: 'Riyadh',
    isOpen: true,
    description: 'Congratulations! Selected without interview. Please transfer 500 SAR visa processing fee via Western Union.'
  };
  const triageRes1 = JobScorer.scoreVacancy(scamJob1);
  assert.equal(triageRes1.score, 0.0, 'Scam job with fee and WU must yield score 0.0');
  assert.equal(triageRes1.verdict, 'FAIL');
  assert.equal(triageRes1.status, 'FAIL');
  assert.equal(triageRes1.shortlisted, false);
  assert.equal(triageRes1.knockout, 'COMPLIANCE_INELIGIBLE');

  const scamJob2 = {
    title: 'Executive VP',
    company: 'Red Sea Global',
    location: 'Tabuk',
    isOpen: true,
    description: 'Unconditional job offer attached. Contact via WhatsApp only: +966500000000.'
  };
  const triageRes2 = JobScorer.scoreVacancy(scamJob2);
  assert.equal(triageRes2.score, 0.0, 'Scam job with cold offer + WhatsApp must yield score 0.0');
  assert.equal(triageRes2.verdict, 'FAIL');
  assert.equal(triageRes2.status, 'FAIL');
  assert.equal(triageRes2.shortlisted, false);
  assert.equal(triageRes2.knockout, 'COMPLIANCE_INELIGIBLE');
});

// ============================================================================
// 3. CLOSING-SOON PRIORITY BOOST & CLAMPING INVARIANTS
// ============================================================================

suite.test('3.1 Closing-Soon: Genuine +0.5 priority boost applied when deadline is within 7 days', assert => {
  const unboostedJob = {
    title: 'Senior DevOps Architect',
    company: 'Public Investment Fund',
    location: 'Riyadh',
    isOpen: true
  };
  const unboostedResult = JobScorer.scoreVacancy(unboostedJob);

  // Job with deadline in 3 days (well within 7d window)
  const deadlineIn3Days = new Date(Date.now() + 3 * 86400000).toISOString();
  const closingSoonJob = {
    ...unboostedJob,
    deadlineAt: deadlineIn3Days
  };
  const boostedResult = JobScorer.scoreVacancy(closingSoonJob);

  assert.equal(boostedResult.closingSoon, true, 'Job closing in 3d must be marked closingSoon');
  assert.equal(boostedResult.urgencyFlag, 'CLOSING_SOON');
  assert.equal(boostedResult.priorityBadge, 'Closing Soon');
  assert.ok(boostedResult.daysToClose >= 2.8 && boostedResult.daysToClose <= 3.1, 'daysToClose must be ~3.0');

  // Verify the genuine +0.5 boost
  const expectedBoostedScore = Number(Math.min(5.0, unboostedResult.score + 0.5).toFixed(1));
  assert.equal(boostedResult.score, expectedBoostedScore, `Score must reflect genuine +0.5 boost (${unboostedResult.score} -> ${expectedBoostedScore})`);
});

suite.test('3.2 Closing-Soon: Score strictly clamped at 5.0 (cannot exceed maximum rubric score)', assert => {
  // Construct a near-perfect job that hits 4.8 or 5.0 before boost
  const topTierJob = {
    title: 'Principal Platform Architect',
    company: 'NEOM',
    location: 'Riyadh',
    isOpen: true,
    deadlineAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    description: 'Requires Node.js, Kubernetes, Docker, Python, AWS, Microservices, Architecture'
  };
  const preferences = {
    targetTitles: ['Principal Platform Architect'],
    targetCities: ['Riyadh'],
    companyWatchlist: ['NEOM']
  };
  const candidateSkills = ['Node.js', 'Kubernetes', 'Docker', 'Python', 'AWS', 'Microservices'];

  const result = JobScorer.scoreVacancy(topTierJob, preferences, candidateSkills);
  assert.equal(result.closingSoon, true);
  assert.ok(result.score <= 5.0, `Score must be clamped at 5.0 (got ${result.score})`);
  assert.equal(result.score, 5.0, 'Top tier job with urgency boost must clamp at exactly 5.0');
});

suite.test('3.3 Closing-Soon: Deadlines > 7 days or expired deadlines do NOT receive priority boost', assert => {
  const baseJob = {
    title: 'Cloud Security Architect',
    company: 'STC',
    location: 'Riyadh',
    isOpen: true
  };
  const baseResult = JobScorer.scoreVacancy(baseJob);

  // 1. Deadline in 14 days
  const futureJob = {
    ...baseJob,
    deadlineAt: new Date(Date.now() + 14 * 86400000).toISOString()
  };
  const futureResult = JobScorer.scoreVacancy(futureJob);
  assert.equal(futureResult.closingSoon, false, 'Deadline in 14d must not trigger closingSoon');
  assert.equal(futureResult.score, baseResult.score, 'Deadline in 14d must receive zero boost');

  // 2. Expired deadline (2 days ago)
  const expiredJob = {
    ...baseJob,
    deadlineAt: new Date(Date.now() - 2 * 86400000).toISOString()
  };
  const expiredResult = JobScorer.scoreVacancy(expiredJob);
  assert.equal(expiredResult.closingSoon, false, 'Expired deadline must not trigger closingSoon');
  assert.equal(expiredResult.score, baseResult.score, 'Expired deadline must receive zero boost');
});

suite.test('3.4 Closing-Soon: Closed vacancies (isOpen === false) are strictly ineligible for priority escalation', assert => {
  const closedJob = {
    title: 'Principal Security Architect',
    company: 'Public Investment Fund',
    location: 'Riyadh',
    isOpen: false, // Closed requisition
    deadlineAt: new Date(Date.now() + 1 * 86400000).toISOString(),
    urgent: true,
    closingSoon: true
  };

  const result = JobScorer.scoreVacancy(closedJob);
  assert.equal(result.isOpen, false);
  assert.equal(result.closingSoon, false, 'Closed vacancies cannot receive closing-soon boost');
  assert.equal(result.urgencyFlag, null);
  assert.equal(result.priorityBadge, null);
});

// ============================================================================
// 4. RATE LIMITING & NEGATIVE BOUNDARY / CAPACITY RESPECT
// ============================================================================

suite.test('4.1 parseRetryAfter: Negative values and malformed boundaries return strictly null per RFC 7231', assert => {
  // Negative values must return null
  assert.equal(parseRetryAfter('-1'), null);
  assert.equal(parseRetryAfter('-5'), null);
  assert.equal(parseRetryAfter('-60'), null);
  assert.equal(parseRetryAfter('-0.5'), null);
  assert.equal(parseRetryAfter(-1), null);
  assert.equal(parseRetryAfter(-120), null);
  assert.equal(parseRetryAfter(-Infinity), null);

  // Non-numeric / empty / null / undefined must return null
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('   '), null);
  assert.equal(parseRetryAfter('invalid-string'), null);
  assert.equal(parseRetryAfter(NaN), null);

  // Positive integer seconds return milliseconds
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter('120'), 120000);
  assert.equal(parseRetryAfter(10), 10000);

  // Valid RFC 1123 HTTP-Date in future
  const futureHttpDate = new Date(Date.now() + 5000).toUTCString();
  const dateResult = parseRetryAfter(futureHttpDate);
  assert.ok(typeof dateResult === 'number' && dateResult > 0 && dateResult <= 5500);

  // Expired RFC 1123 HTTP-Date in past returns 0
  const pastHttpDate = new Date(Date.now() - 5000).toUTCString();
  assert.equal(parseRetryAfter(pastHttpDate), 0);
});

suite.test('4.2 Token Bucket: Bucket capacity is strictly respected and never overflows under refill', assert => {
  const limiter = new DomainTokenBucketRateLimiter();

  // Test Greenhouse: capacity = 10
  const ghDomain = 'boards-api.greenhouse.io';
  const ghBucket = limiter.getBucket(ghDomain);
  assert.equal(ghBucket.capacity, 10, 'Greenhouse capacity must be 10');
  assert.equal(ghBucket.tokens, 10, 'Initial tokens must equal capacity');

  // Simulate long elapsed time (10,000 seconds)
  ghBucket.lastRefill = Date.now() - 10000000;
  limiter.refill(ghBucket);
  assert.equal(ghBucket.tokens, 10, 'Tokens after long elapsed time must remain clamped to capacity (10)');

  // Draining bucket: acquire 10 tokens
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.tryAcquire(ghDomain, 1), true, `Token acquisition #${i + 1} must succeed`);
  }
  assert.equal(ghBucket.tokens, 0, 'Tokens after 10 acquisitions must be 0');

  // 11th acquisition must fail immediately without tokens
  assert.equal(limiter.tryAcquire(ghDomain, 1), false, 'Acquisition on depleted bucket must return false');

  // Test LinkedIn: capacity = 1, maxConcurrency = 1
  const liDomain = 'linkedin.com';
  const liBucket = limiter.getBucket(liDomain);
  assert.equal(liBucket.capacity, 1, 'LinkedIn capacity must be 1');
  assert.equal(limiter.tryAcquire(liDomain, 1), true);
  assert.equal(limiter.tryAcquire(liDomain, 1), false);
});

suite.test('4.3 Token Bucket: Concurrent acquire calls serialize sequentially without thundering herd or token leakage', async assert => {
  const customLimiter = new DomainTokenBucketRateLimiter([
    { pattern: /test-domain\.com/, capacity: 2, refillRate: 10.0, maxConcurrency: 1 } // 10 tokens/sec = 100ms per token
  ]);

  const domain = 'test-domain.com';
  const bucket = customLimiter.getBucket(domain);
  bucket.tokens = 0; // force immediate deficit
  bucket.lastRefill = Date.now();

  const start = Date.now();
  let t1 = 0;
  let t2 = 0;
  let t3 = 0;

  // Fire 3 concurrent acquires and record their completion timestamps
  const p1 = customLimiter.acquire(domain, 1).then(waitMs => {
    t1 = Date.now() - start;
    return waitMs;
  });
  const p2 = customLimiter.acquire(domain, 1).then(waitMs => {
    t2 = Date.now() - start;
    return waitMs;
  });
  const p3 = customLimiter.acquire(domain, 1).then(waitMs => {
    t3 = Date.now() - start;
    return waitMs;
  });

  await Promise.all([p1, p2, p3]);
  const elapsed = Date.now() - start;

  // Verify sequential execution (not thundering herd where all resolve simultaneously at ~100ms)
  assert.ok(elapsed >= 250, `Concurrent acquires must serialize sequentially (elapsed=${elapsed}ms >= 250ms)`);
  assert.ok(t1 >= 70, `Caller 1 must wait for first token refill (t1=${t1}ms >= 70ms)`);
  assert.ok(t2 >= t1 + 70, `Caller 2 must resolve after Caller 1 refills and drains (t2=${t2}ms >= t1+70ms)`);
  assert.ok(t3 >= t2 + 70, `Caller 3 must resolve after Caller 2 refills and drains (t3=${t3}ms >= t2+70ms)`);
});

suite.test('1.4 Zero Age Penalty: Negative postedAgeDays, invalid dates, and degenerate job objects fail safely without crashes', assert => {
  // 1. Negative postedAgeDays (-10d)
  const negJob = { title: 'Cloud Architect', company: 'NEOM', postedAgeDays: -10, isOpen: true };
  const zeroJob = { title: 'Cloud Architect', company: 'NEOM', postedAgeDays: 0, isOpen: true };
  const negRes = JobScorer.scoreVacancy(negJob);
  const zeroRes = JobScorer.scoreVacancy(zeroJob);
  assert.equal(negRes.score, zeroRes.score, 'Negative postedAgeDays must score identically to age 0d');
  assert.equal(negRes.verdict, zeroRes.verdict);

  // 2. Invalid date string
  const badDateJob = { title: 'Cloud Architect', company: 'NEOM', postedDate: 'not-a-valid-date-timestamp', isOpen: true };
  const badDateRes = JobScorer.scoreVacancy(badDateJob);
  assert.equal(badDateRes.score, zeroRes.score, 'Malformed date string must default safely to age 0d');

  // 3. Null / empty job object
  const nullRes = JobScorer.scoreVacancy(null);
  assert.equal(nullRes.score, 0.0, 'Null job must yield score 0.0');
  assert.equal(nullRes.verdict, 'FAIL');
  assert.equal(nullRes.isOpen, false);
  assert.equal(nullRes.ageBadge, 'Closed');

  // Degenerate empty object does not throw unhandled exception
  const emptyRes = JobScorer.scoreVacancy({});
  assert.ok(typeof emptyRes.score === 'number', 'Empty job object must return valid score');
  assert.equal(emptyRes.isOpen, true);
});

suite.test('2.4 KSA Work Authorization: In-Kingdom Transferable Iqama vs offshore visa sponsorship rules', assert => {
  // In-Kingdom transferable Iqama required
  const iqamaRequiredJob = 'We are seeking candidates currently resident in KSA with valid and transferable Iqama. Local transfer only.';
  const transferEval = IqamaTransferEngine.evaluate(iqamaRequiredJob, 'Transferable Iqama');
  assert.equal(transferEval.eligible, true);
  assert.equal(transferEval.requiresTransferableIqama, true);

  // Offshore candidate requiring visa sponsorship for in-Kingdom transfer only role
  const offshoreEval = IqamaTransferEngine.evaluate(iqamaRequiredJob, 'Requires Visa Sponsorship');
  assert.equal(offshoreEval.eligible, false);
  assert.ok(offshoreEval.reason.includes('Transferable Iqama'));

  // Saudi National candidate is always eligible regardless of Iqama transfer wording
  const saudiEval = IqamaTransferEngine.evaluate(iqamaRequiredJob, 'Saudi National');
  assert.equal(saudiEval.eligible, true);
  assert.equal(saudiEval.requiresTransferableIqama, false);
});

suite.test('3.5 Closing-Soon: Boundary edge conditions (invalid date string, deadline passed by 1s, explicit urgency flags)', assert => {
  const baseJob = { title: 'Platform Engineer', company: 'Tamara', isOpen: true };
  const baseScore = JobScorer.scoreVacancy(baseJob).score;

  // 1. Invalid date string does not throw and does not trigger boost
  const invalidDateJob = { ...baseJob, deadlineAt: 'unparseable-date-2026' };
  const invalidRes = JobScorer.scoreVacancy(invalidDateJob);
  assert.equal(invalidRes.closingSoon, false);
  assert.equal(invalidRes.score, baseScore);

  // 2. Deadline passed by 1 second does not trigger boost
  const pastJob = { ...baseJob, deadlineAt: new Date(Date.now() - 1000).toISOString() };
  const pastRes = JobScorer.scoreVacancy(pastJob);
  assert.equal(pastRes.closingSoon, false);
  assert.equal(pastRes.score, baseScore);

  // 3. Explicit boolean urgency flags (urgent: true) on open job trigger boost
  const explicitUrgentJob = { ...baseJob, urgent: true };
  const urgentRes = JobScorer.scoreVacancy(explicitUrgentJob);
  assert.equal(urgentRes.closingSoon, true);
  assert.equal(urgentRes.score, Number(Math.min(5.0, baseScore + 0.5).toFixed(1)));
});

suite.test('4.4 parseRetryAfter: Extreme whitespace, decimals, and boundary conditions', assert => {
  // Whitespace with negative number
  assert.equal(parseRetryAfter('   -42   '), null);
  assert.equal(parseRetryAfter('   -0.1   '), null);

  // Decimals in positive seconds (e.g. 1.5s -> 1500ms)
  assert.equal(parseRetryAfter('1.5'), 1500);
  assert.equal(parseRetryAfter('0.25'), 250);

  // Extreme strings
  assert.equal(parseRetryAfter('null'), null);
  assert.equal(parseRetryAfter('undefined'), null);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT'), 0); // historical date in past returns 0
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true });
}

