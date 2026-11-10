'use strict';
/**
 * Tier 1: Feature Coverage - Multi-Channel Discovery Engine
 *
 * Verifies core discovery subsystems:
 * 1. Domain Token Bucket Rate Limiter & Concurrency Isolation
 * 2. RFC 7231 Retry-After parsing & Exponential Backoff with Jitter
 * 3. executeWithRetry lifecycle, retry exhaustion, and SOURCE_DEGRADED events
 * 4. ArabicQueryNormalizer: Diacritics, Orthography, Light-Stemming, Morphological Search
 * 5. Strict Arabic CV Gating Policy (English Default vs Explicit Mandate)
 * 6. KSA Watchlist Registry & Labor Compliance Sentinel (Saudization & Scam Flags)
 * 7. JobScorer 5-Dimension Rubric, Closing-Soon Boost, and Zero Age Penalty Invariant
 * 8. Attended Browser Sweeps Configuration & Session Rules
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');
const {
  DomainTokenBucketRateLimiter,
  parseRetryAfter,
  computeExponentialBackoff,
  executeWithRetry,
  RateLimitClient
} = require('../../lib/discovery/rate-limiter');
const {
  KsaCountryPack,
  KsaWatchlistRegistry,
  ArabicQueryNormalizer,
  ScamDetector,
  IqamaTransferEngine,
  ArabicCvPolicy,
  KSA_WATCHLIST,
  evaluateKsaCompliance,
  shouldGenerateArabicCv
} = require('../../lib/discovery/ksa-pack');
const { JobScorer, TriageScorer } = require('../../lib/discovery/job-scorer');
const { BrowserSweeps } = require('../../lib/discovery/browser-sweeps');

const suite = new TestSuite('Tier 1: Multi-Channel Discovery Engine');

// ============================================================================
// 1. DOMAIN TOKEN BUCKET RATE LIMITER
// ============================================================================

suite.test('Token bucket rate limiter enforces capacity, depletion, and domain isolation', async assert => {
  const limiter = new DomainTokenBucketRateLimiter([
    { pattern: /test-domain-a\.com/, capacity: 3, refillRate: 50, maxConcurrency: 2 },
    { pattern: /test-domain-b\.com/, capacity: 2, refillRate: 50, maxConcurrency: 1 }
  ]);

  // Initial consumption for Domain A up to capacity
  const c1 = limiter.tryRemoveToken('https://test-domain-a.com/jobs');
  const c2 = limiter.tryRemoveToken('https://test-domain-a.com/jobs');
  const c3 = limiter.tryRemoveToken('https://test-domain-a.com/jobs');
  assert.equal(c1, true, 'First token available');
  assert.equal(c2, true, 'Second token available');
  assert.equal(c3, true, 'Third token available');

  // Fourth token must fail immediately when bucket is empty
  const c4 = limiter.tryRemoveToken('https://test-domain-a.com/jobs');
  assert.equal(c4, false, 'Fourth token rejected when capacity reached');

  // Domain B must remain untouched (isolated state)
  const b1 = limiter.tryRemoveToken('https://test-domain-b.com/postings');
  assert.equal(b1, true, 'Domain B bucket is independent and has tokens');

  // Wait for token refill on Domain A
  await new Promise(r => setTimeout(r, 60));
  const cAfterRefill = limiter.tryRemoveToken('https://test-domain-a.com/jobs');
  assert.equal(cAfterRefill, true, 'Token available after refill interval');
});

// ============================================================================
// 2. RETRY-AFTER & EXPONENTIAL BACKOFF
// ============================================================================

suite.test('Retry-After header parser handles integer seconds, HTTP-Dates, and nulls', assert => {
  // Delta seconds
  assert.equal(parseRetryAfter('120'), 120000, 'Integer seconds converted to milliseconds');
  assert.equal(parseRetryAfter('0'), 0, 'Zero seconds handled');
  assert.equal(parseRetryAfter(45), 45000, 'Numeric seconds handled');

  // HTTP-Date RFC 1123
  const futureDate = new Date(Date.now() + 60000).toUTCString();
  const parsedFuture = parseRetryAfter(futureDate);
  assert.ok(parsedFuture >= 55000 && parsedFuture <= 65000, 'Future HTTP-Date converted to relative delta ms');

  const pastDate = new Date(Date.now() - 10000).toUTCString();
  assert.equal(parseRetryAfter(pastDate), 0, 'Past HTTP-Date clamped to 0ms');

  // Invalid or null
  assert.equal(parseRetryAfter(null), null, 'Null header returns null');
  assert.equal(parseRetryAfter(''), null, 'Empty string returns null');
  assert.equal(parseRetryAfter('not-a-valid-date'), null, 'Malformed header returns null');
});

suite.test('Exponential backoff computation increases exponentially and respects max ceiling', assert => {
  const d0 = computeExponentialBackoff(0, 100, 5000, false);
  const d1 = computeExponentialBackoff(1, 100, 5000, false);
  const d2 = computeExponentialBackoff(2, 100, 5000, false);
  const d3 = computeExponentialBackoff(3, 100, 5000, false);

  assert.equal(d0, 100, 'Attempt 0 uses base delay');
  assert.equal(d1, 200, 'Attempt 1 doubles delay');
  assert.equal(d2, 400, 'Attempt 2 quadruples delay');
  assert.equal(d3, 800, 'Attempt 3 octuples delay');

  const dCapped = computeExponentialBackoff(10, 100, 1000, false);
  assert.equal(dCapped, 1000, 'High attempt clamped to maxDelayMs');

  // Jitter variation
  const withJitter = computeExponentialBackoff(2, 100, 5000, true);
  assert.ok(withJitter >= 400 && withJitter <= 520, 'Jitter stays within 400-520ms window (up to +30%)');
});

// ============================================================================
// 3. EXECUTE WITH RETRY & SOURCE DEGRADED
// ============================================================================

suite.test('executeWithRetry retries on 429 and emits SOURCE_DEGRADED on exhaustion', async assert => {
  // Test immediate success
  let callsA = 0;
  const resA = await executeWithRetry(async () => {
    callsA++;
    return { ok: true, status: 200, data: 'payload' };
  }, { testMode: true });
  assert.equal(resA.success, true);
  assert.equal(callsA, 1);

  // Test retry on single 429 then success
  let callsB = 0;
  const resB = await executeWithRetry(async () => {
    callsB++;
    if (callsB === 1) {
      return { ok: false, status: 429, headers: { 'retry-after': '1' } };
    }
    return { ok: true, status: 200, data: 'recovered' };
  }, { testMode: true, maxRetries: 2 });
  assert.equal(resB.success, true);
  assert.equal(callsB, 2);

  // Test exhaustion on persistent 429
  let callsC = 0;
  let degradedLogged = null;
  const resC = await executeWithRetry(async () => {
    callsC++;
    return { ok: false, status: 429, headers: {} };
  }, {
    testMode: true,
    maxRetries: 2,
    source: 'test-source',
    url: 'https://api.test-source.com/jobs',
    onDegraded: info => {
      degradedLogged = info;
    }
  });

  assert.equal(resC.success, false);
  assert.equal(resC.degraded, true);
  assert.equal(callsC, 3, 'Initial attempt + 2 retries = 3 calls');
  assert.ok(degradedLogged !== null, 'onDegraded hook fired');
  assert.equal(degradedLogged.source, 'test-source');
  assert.equal(degradedLogged.statusCode, 429);
});

// ============================================================================
// 4. ARABIC QUERY NORMALIZATION & MORPHOLOGY
// ============================================================================

suite.test('ArabicQueryNormalizer normalizes tashkeel, alefs, taa marbuta, and alef maqsura', assert => {
  const inputDiacritics = 'مُهَنْدِسُ بَرْمَجِيَّاتٍ رَئِيسِيٌّ';
  const normDiacritics = ArabicQueryNormalizer.normalize(inputDiacritics);
  assert.equal(normDiacritics, 'مهندس برمجيات رئيسي', 'Tashkeel and tanween stripped cleanly');

  const inputAlefs = 'أحمد إبراهيم آمنة ٱستقرار';
  const normAlefs = ArabicQueryNormalizer.normalize(inputAlefs);
  assert.equal(normAlefs, 'احمد ابراهيم امنه استقرار', 'All alef variants unified to ا and taa marbuta to ه');

  const inputMaqsura = 'مستشفى الفتوى';
  const normMaqsura = ArabicQueryNormalizer.normalize(inputMaqsura);
  assert.equal(normMaqsura, 'مستشفي الفتوي', 'Alef maqsura unified to yaa');
});

suite.test('ArabicQueryNormalizer light-stemming strips prefixes and suffixes', assert => {
  // Proclitics (ال, وال, فال, بال, لل)
  assert.equal(ArabicQueryNormalizer.lightStem('المهندس'), 'مهندس', 'Stripped definite article ال');
  assert.equal(ArabicQueryNormalizer.lightStem('والمهندس'), 'مهندس', 'Stripped conjunction and article وال');
  assert.equal(ArabicQueryNormalizer.lightStem('للمهندس'), 'مهندس', 'Stripped preposition لل');

  // Enclitics (ين, ون, ات, ان)
  assert.equal(ArabicQueryNormalizer.lightStem('مهندسين'), 'مهندس', 'Stripped plural suffix ين');
  assert.equal(ArabicQueryNormalizer.lightStem('مهندسون'), 'مهندس', 'Stripped plural suffix ون');
  assert.equal(ArabicQueryNormalizer.lightStem('مهندسات'), 'مهندس', 'Stripped feminine plural suffix ات');
});

suite.test('ArabicQueryNormalizer morphological search matches query variants', assert => {
  const jdText = 'تعلن الشركة الرائدة في الرياض عن توفر شواغر للمهندسين السحابيين ومطوري النظم.';

  // Query is singular "مهندس"
  assert.equal(
    ArabicQueryNormalizer.matches(jdText, 'مهندس'),
    true,
    'Singular query "مهندس" matches plural in text "للمهندسين"'
  );

  // Query is with article "المهندسين"
  assert.equal(
    ArabicQueryNormalizer.matches(jdText, 'المهندسين'),
    true,
    'Plural query matches text'
  );

  // Query with diacritics
  assert.equal(
    ArabicQueryNormalizer.matches(jdText, 'مُهَنْدِس'),
    true,
    'Diacritized query matches plain text'
  );

  // Non-matching query
  assert.equal(
    ArabicQueryNormalizer.matches(jdText, 'طبيب اسنان'),
    false,
    'Unrelated query correctly returns false'
  );
});

// ============================================================================
// 5. STRICT ARABIC CV GATING POLICY
// ============================================================================

suite.test('ArabicCvPolicy defaults to English unless explicit submission mandate exists', assert => {
  // Default vacancy (English preferred)
  const standardJd = 'Looking for a Senior Software Engineer in Riyadh. Must have strong TypeScript and Node.js skills.';
  const p1 = shouldGenerateArabicCv(standardJd);
  assert.equal(p1.shouldGenerateArabicCv, false, 'Standard English JD defaults to English CV');
  assert.equal(p1.mode, 'ENGLISH_ONLY');

  // Incidental language requirement (must NOT trigger Arabic CV)
  const bilingualJd = 'Role requires fluency in spoken and written Arabic and English for stakeholder communications.';
  const p2 = shouldGenerateArabicCv(bilingualJd);
  assert.equal(p2.shouldGenerateArabicCv, false, 'Incidental Arabic fluency requirement does not trigger Arabic CV');

  // Explicit mandate in English
  const mandateEn = 'Note: All applicants must submit their CV in Arabic for Ministry of Human Resources registration.';
  const p3 = shouldGenerateArabicCv(mandateEn);
  assert.equal(p3.shouldGenerateArabicCv, true, 'Explicit English mandate triggers Arabic CV');
  assert.equal(p3.mode, 'BILINGUAL_PACK');

  // Explicit mandate in Arabic
  const mandateAr = 'شروط التقديم: يرجى تقديم السيرة الذاتية باللغة العربية لاعتماد الطلب.';
  const p4 = shouldGenerateArabicCv(mandateAr);
  assert.equal(p4.shouldGenerateArabicCv, true, 'Explicit Arabic mandate triggers Arabic CV');
  assert.equal(p4.mode, 'BILINGUAL_PACK');
});

// ============================================================================
// 6. KSA WATCHLIST REGISTRY & COMPLIANCE EVALUATION
// ============================================================================

suite.test('KSA Watchlist Registry contains 40+ strategic entities across target sectors', assert => {
  assert.ok(KSA_WATCHLIST.length >= 40, `Watchlist contains ${KSA_WATCHLIST.length} enterprises (>= 40 required)`);

  const registry = new KsaWatchlistRegistry();

  // Test Neom
  const neom = registry.findByCompanyName('NEOM Tech & Digital');
  assert.ok(neom !== null, 'NEOM matched by name');
  assert.equal(neom.category, 'giga_project');
  assert.equal(neom.provider, 'oraclecloud');

  // Test Red Sea Global
  const rsg = registry.findByCompanyName('Red Sea Global');
  assert.ok(rsg !== null, 'Red Sea Global matched');
  assert.equal(rsg.category, 'giga_project');

  // Test Saudi Aramco
  const aramco = registry.findByCompanyName('Saudi Aramco');
  assert.ok(aramco !== null, 'Aramco matched');
  assert.equal(aramco.category, 'national_champion');

  // Test STC
  const stc = registry.findByCompanyName('stc');
  assert.ok(stc !== null, 'STC matched');
  assert.equal(stc.category, 'national_champion');
});

suite.test('evaluateKsaCompliance flags Saudization restrictions and scam patterns', assert => {
  // Saudization restricted role
  const saudiOnlyJd = 'Position: HR Director. Strict requirement: Open only for Saudi nationals due to national quota.';
  const expatEval = evaluateKsaCompliance(saudiOnlyJd, 'Transferable Iqama');
  assert.equal(expatEval.eligible, false, 'Expat ineligible for Saudization restricted role');
  assert.equal(expatEval.isSaudizationRestricted, true);

  const nationalEval = evaluateKsaCompliance(saudiOnlyJd, 'Saudi National');
  assert.equal(nationalEval.eligible, true, 'Saudi national eligible and prioritized');
  assert.equal(nationalEval.isPriority, true);

  // Cold-offer scam pattern with upfront fee
  const scamJd = 'Congratulations! You are selected. Send a $450 refundable visa processing fee to secure your contract.';
  const scamEval = evaluateKsaCompliance(scamJd, 'Transferable Iqama');
  assert.equal(scamEval.eligible, false, 'Scam role rejected from pipeline');
  assert.equal(scamEval.isColdOfferScamRisk, true);
  assert.ok(scamEval.scamRiskScore >= 40);

  // Unofficial WhatsApp communication
  const whatsappScam = ScamDetector.evaluate('Send your CV to WhatsApp only +966500000000 for direct hiring without interview.');
  assert.equal(whatsappScam.isColdOfferScamRisk, true);
  assert.ok(whatsappScam.indicators.some(i => i.type === 'UNOFFICIAL_COMMUNICATION_CHANNEL'));
});

// ============================================================================
// 7. JOB SCORER 5-DIMENSION RUBRIC & ZERO AGE PENALTY INVARIANT
// ============================================================================

suite.test('JobScorer adheres to 5-dimension rubric and strict zero age penalty invariant', assert => {
  const profile = {
    targetTitles: ['Principal Engineer', 'Staff Software Engineer'],
    skills: ['TypeScript', 'Node.js', 'Distributed Systems', 'Cloud Architecture'],
    totalYearsExperience: 10,
    preferredLocations: ['Riyadh', 'Saudi Arabia', 'Remote'],
    workAuthorization: 'Transferable Iqama'
  };

  const scorer = new JobScorer(profile);

  // Base job posting template
  const createJob = (ageDays, deadlineDays = null) => {
    const postedDate = new Date(Date.now() - ageDays * 86400000).toISOString();
    const closingDate = deadlineDays !== null
      ? new Date(Date.now() + deadlineDays * 86400000).toISOString()
      : null;

    return {
      title: 'Principal Software Engineer',
      company: 'Neom',
      location: 'Riyadh, Saudi Arabia',
      description: 'Looking for a Principal Engineer with expertise in TypeScript, Node.js, and Distributed Systems.',
      postedDate,
      closingDate,
      isOpen: true
    };
  };

  // Compare vacancy posted today (0d) vs 30d vs 60d vs 90d vs 120d vs 365d
  const age0 = scorer.score(createJob(0));
  const age30 = scorer.score(createJob(30));
  const age60 = scorer.score(createJob(60));
  const age90 = scorer.score(createJob(90));
  const age120 = scorer.score(createJob(120));
  const age365 = scorer.score(createJob(365));

  // The composite score must be strictly equal across all ages
  assert.equal(age0.compositeScore, age30.compositeScore, 'Score at 0d equals 30d');
  assert.equal(age0.compositeScore, age60.compositeScore, 'Score at 0d equals 60d');
  assert.equal(age0.compositeScore, age90.compositeScore, 'Score at 0d equals 90d');
  assert.equal(age0.compositeScore, age120.compositeScore, 'Score at 0d equals 120d');
  assert.equal(age0.compositeScore, age365.compositeScore, 'Score at 0d equals 365d');

  // Verify all 5 dimensions are evaluated
  const dimensions = Object.keys(age0.breakdown);
  assert.ok(dimensions.includes('titleMatch'));
  assert.ok(dimensions.includes('skillsMatch'));
  assert.ok(dimensions.includes('experienceFit'));
  assert.ok(dimensions.includes('locationFit'));
  assert.ok(dimensions.includes('companyPrestige'));

  // Test closing-soon priority boost
  const normalJob = scorer.score(createJob(10, 30)); // closes in 30 days
  const closingSoonJob = scorer.score(createJob(10, 3)); // closes in 3 days

  assert.equal(normalJob.closingSoon, false, 'Normal job (>7 days to deadline) is not closing soon');
  assert.equal(closingSoonJob.closingSoon, true, 'Vacancy closing in 3 days must be marked closingSoon');
  assert.ok(
    closingSoonJob.compositeScore > normalJob.compositeScore,
    'Closing soon vacancy must receive priority boost'
  );
  assert.equal(
    closingSoonJob.compositeScore,
    Math.min(5.0, Number((normalJob.compositeScore + 0.5).toFixed(1))),
    'Closing soon compositeScore must be boosted by +0.5'
  );
  assert.equal(
    closingSoonJob.score,
    closingSoonJob.compositeScore,
    'score must match boosted compositeScore'
  );
  assert.equal(closingSoonJob.urgencyFlag, 'CLOSING_SOON', 'urgencyFlag must be CLOSING_SOON');
  assert.equal(closingSoonJob.priorityBadge, 'Closing Soon', 'priorityBadge must be Closing Soon');
});

// ============================================================================
// 8. BROWSER SWEEPS SPECIFICATIONS
// ============================================================================

suite.test('BrowserSweeps provides attended guidance and read-only session checkers for all 5 boards', assert => {
  const targets = BrowserSweeps.getTargetBoards();
  assert.ok(targets.length >= 5, 'at least the 5 original browser sweep boards are supported');

  const expectedBoards = ['linkedin', 'bayt', 'gulftalent', 'naukrigulf', 'indeed_sa'];
  for (const b of expectedBoards) {
    const spec = BrowserSweeps.getBoardSpec(b);
    assert.ok(spec !== null, `Board spec exists for ${b}`);
    assert.ok(spec.loginUrl.startsWith('https://'), `Valid login URL for ${b}`);
    assert.ok(spec.searchUrlTemplate.includes('{query}'), `Valid search template for ${b}`);
    assert.equal(typeof spec.checkSessionSelectors, 'object', `Selectors defined for ${b}`);
  }

  // Verify security invariant: zero credentials stored
  const serialized = JSON.stringify(targets);
  assert.equal(serialized.includes('password'), false, 'Zero password references in sweep configs');
  assert.equal(serialized.includes('apiKey'), false, 'Zero apiKey references in sweep configs');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true });
}
