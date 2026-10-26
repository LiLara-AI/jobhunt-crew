'use strict';
/**
 * Milestone M4 Empirical Adversarial Stress Test Suite
 *
 * Authored by: challenger_m4_1 (Empirical Challenger)
 * Scope: Multi-Channel Job Discovery Subsystems:
 *   1. Rate Limiting & Backoff (bursts, token bucket refill, domain isolation, 429/503 retry, full jitter, Retry-After header, SOURCE_DEGRADED ledger event)
 *   2. Pagination Safety (circular pages, repeating tokens/cursors, maxPages ceiling, empty/malformed/truncated responses, missing fields)
 *   3. Canonical Deduplication (25+ tracking params, custom utm_*, casing, anchor hashes, route normalization, duplicate detection & collision resistance)
 *
 * Zero external dependencies. Uses pure Node.js built-ins.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { TestSuite } = require('../helpers/test-harness');

// Subsystems under test
const {
  DomainTokenBucketRateLimiter,
  parseRetryAfter,
  computeExponentialBackoff,
  executeWithRetry
} = require('../../lib/discovery/rate-limiter');

const { BaseAtsAdapter } = require('../../lib/discovery/ats/base-adapter');
const { GreenhouseAdapter } = require('../../lib/discovery/ats/greenhouse');
const { LeverAdapter } = require('../../lib/discovery/ats/lever');
const { AshbyAdapter } = require('../../lib/discovery/ats/ashby');
const { WorkdayAdapter } = require('../../lib/discovery/ats/workday');
const { SmartRecruitersAdapter } = require('../../lib/discovery/ats/smartrecruiters');
const { OracleCloudAdapter } = require('../../lib/discovery/ats/oracle-cloud');

const {
  normalizeJobUrl,
  generateRequisitionKey,
  generateFingerprint,
  checkDuplicateRequisition,
  DuplicateApplicationGuard
} = require('../../lib/guardrails/dedup');

const { EventLedger } = require('../../lib/ledger/ledger');
const { reduceEvents } = require('../../lib/ledger/reducer');

const suite = new TestSuite('M4 Empirical Adversarial Stress Test Suite');

// ============================================================================
// SECTION 1: Rate Limiting & Backoff Stress Tests
// ============================================================================

suite.test('1.1 Rate Limiting: Rapid concurrent burst requests to same domain exhaust capacity without bleeding', assert => {
  const limiter = new DomainTokenBucketRateLimiter({
    profiles: [
      { pattern: /burst-test\.com/, capacity: 5, refillRate: 1.0, maxConcurrency: 1 },
      { pattern: /.*/, capacity: 5, refillRate: 1.0, maxConcurrency: 1 }
    ]
  });

  const domain = 'burst-test.com';
  let successCount = 0;
  let rejectedCount = 0;

  // Simulate 25 rapid concurrent burst attempts
  for (let i = 0; i < 25; i++) {
    if (limiter.tryAcquire(domain)) {
      successCount++;
    } else {
      rejectedCount++;
    }
  }

  assert.equal(successCount, 5, 'Exactly initial capacity (5) must succeed in immediate burst');
  assert.equal(rejectedCount, 20, 'All excess requests (20) must be rejected non-blockingly');
});

suite.test('1.2 Rate Limiting: Token replenishment math and capacity ceiling', assert => {
  const limiter = new DomainTokenBucketRateLimiter({
    profiles: [
      { pattern: /refill-test\.com/, capacity: 10, refillRate: 4.0, maxConcurrency: 1 }
    ]
  });

  const domain = 'refill-test.com';
  // Drain all 10 tokens
  for (let i = 0; i < 10; i++) {
    assert.ok(limiter.tryAcquire(domain), `Token ${i + 1} should be acquired`);
  }
  assert.equal(limiter.tryAcquire(domain), false, 'Bucket must be completely empty');

  const bucket = limiter.getBucket(domain);
  assert.equal(bucket.tokens, 0, 'Tokens must be 0 after exhaustion');

  // Simulate time passage: 500ms elapsed -> 0.5s * 4.0 tokens/s = 2.0 tokens
  bucket.lastRefill = Date.now() - 500;
  limiter.refill(bucket);
  assert.ok(bucket.tokens >= 1.9 && bucket.tokens <= 2.1, `Should have ~2.0 tokens replenished (got ${bucket.tokens})`);

  // Simulate long time passage: 10,000ms elapsed -> should cap at max capacity 10
  bucket.lastRefill = Date.now() - 10000;
  limiter.refill(bucket);
  assert.equal(bucket.tokens, 10, 'Tokens must be clamped at bucket capacity (10), never exceeding it');
});

suite.test('1.3 Rate Limiting: Absolute domain isolation under asymmetric exhaustion', assert => {
  const limiter = new DomainTokenBucketRateLimiter();

  const domainA = 'boards-api.greenhouse.io'; // profile capacity: 10
  const domainB = 'api.lever.co';             // profile capacity: 8
  const domainC = 'sa.indeed.com';            // profile capacity: 1

  // Exhaust domain A completely (10 tokens)
  for (let i = 0; i < 10; i++) {
    assert.ok(limiter.tryAcquire(domainA), `Domain A token ${i + 1} should acquire`);
  }
  assert.equal(limiter.tryAcquire(domainA), false, 'Domain A must be fully exhausted');

  // Verify domain B is completely unaffected and has its full 8 tokens
  let domainBSuccess = 0;
  for (let i = 0; i < 8; i++) {
    if (limiter.tryAcquire(domainB)) domainBSuccess++;
  }
  assert.equal(domainBSuccess, 8, 'Domain B must acquire all 8 tokens despite Domain A being exhausted');
  assert.equal(limiter.tryAcquire(domainB), false, 'Domain B 9th attempt should be rejected');

  // Verify domain C is completely unaffected
  assert.ok(limiter.tryAcquire(domainC), 'Domain C should acquire its 1 token');
  assert.equal(limiter.tryAcquire(domainC), false, 'Domain C should reject 2nd attempt');

  // Domain A must still be exhausted
  assert.equal(limiter.tryAcquire(domainA), false, 'Domain A must still be exhausted');
});

suite.test('1.4 Rate Limiting: Interleaved multi-domain high-throughput burst simulation', assert => {
  const limiter = new DomainTokenBucketRateLimiter();
  const domains = ['api.ashbyhq.com', 'api.smartrecruiters.com', 'custom-board.io'];
  const acquired = { 'api.ashbyhq.com': 0, 'api.smartrecruiters.com': 0, 'custom-board.io': 0 };

  // 150 requests round-robin
  for (let i = 0; i < 150; i++) {
    const d = domains[i % domains.length];
    if (limiter.tryAcquire(d)) {
      acquired[d]++;
    }
  }

  // Ashby profile capacity is 8
  assert.equal(acquired['api.ashbyhq.com'], 8, 'Ashby should acquire exactly its capacity of 8');
  // SmartRecruiters profile capacity is 5
  assert.equal(acquired['api.smartrecruiters.com'], 5, 'SmartRecruiters should acquire exactly its capacity of 5');
  // custom-board.io fallback capacity is 5
  assert.equal(acquired['custom-board.io'], 5, 'Fallback domain should acquire exactly its capacity of 5');
});

suite.test('1.5 Backoff & RFC 7231 Retry-After header parsing', assert => {
  // Delta-seconds
  assert.equal(parseRetryAfter('0'), 0);
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter('  120  '), 120000);

  // RFC 1123 HTTP-Date in future
  const futureDate = new Date(Date.now() + 15000).toUTCString();
  const parsedFuture = parseRetryAfter(futureDate);
  assert.ok(parsedFuture >= 13000 && parsedFuture <= 16000, `Future HTTP-Date parsed to ms: ${parsedFuture}`);

  // RFC 1123 HTTP-Date in past or negative delay (treated as past/immediate)
  const pastDate = new Date(Date.now() - 5000).toUTCString();
  assert.equal(parseRetryAfter(pastDate), 0, 'Past date should return 0ms delay');

  // Non-date non-numeric strings should return null
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('invalid-date-string'), null);
  assert.equal(parseRetryAfter('abc-xyz'), null);
});

suite.test('1.6 Backoff: Exponential progression, jitter distribution, and upper ceiling', assert => {
  const base = 50;
  const max = 400;

  // Test no-jitter deterministic progression
  assert.equal(computeExponentialBackoff(0, base, max, false), 50);
  assert.equal(computeExponentialBackoff(1, base, max, false), 100);
  assert.equal(computeExponentialBackoff(2, base, max, false), 200);
  assert.equal(computeExponentialBackoff(3, base, max, false), 400); // capped at max
  assert.equal(computeExponentialBackoff(4, base, max, false), 400); // capped at max

  // Test jitter dispersion at attempt 2 (base 200, jitter up to +30% -> range [200, 261])
  const samples = [];
  for (let i = 0; i < 40; i++) {
    const val = computeExponentialBackoff(2, { baseDelayMs: 50, maxDelayMs: 1000, jitter: true });
    samples.push(val);
    assert.ok(val >= 200, `Value ${val} must be >= base exponential 200`);
    assert.ok(val <= 265, `Value ${val} must be <= 200 + 30% jitter`);
  }

  // Verify non-zero variance (jitter is truly active)
  const uniqueSamples = new Set(samples);
  assert.ok(uniqueSamples.size > 5, `Jitter should create diverse delay distribution (got ${uniqueSamples.size} unique values)`);
});

suite.test('1.7 Backoff Injection: HTTP 429 and 503 recovery with and without Retry-After', async assert => {
  // Scenario A: 429 with Retry-After header succeeds on attempt 2
  let calls429 = 0;
  const fetchWith429 = async () => {
    calls429++;
    if (calls429 === 1) {
      return { statusCode: 429, headers: { 'retry-after': '1' } };
    }
    return { statusCode: 200, data: { jobs: [{ id: 'job_429' }] } };
  };

  const res429 = await executeWithRetry(fetchWith429, { maxRetries: 2, testMode: true });
  assert.equal(res429.success, true);
  assert.equal(res429.retries, 1);
  assert.equal(res429.history.length, 2);
  assert.equal(res429.history[0].statusCode, 429);
  assert.equal(res429.history[1].statusCode, 200);

  // Scenario B: 503 without Retry-After header succeeds on attempt 3
  let calls503 = 0;
  const fetchWith503 = async () => {
    calls503++;
    if (calls503 <= 2) {
      return { statusCode: 503, headers: {} };
    }
    return { statusCode: 200, data: { jobs: [{ id: 'job_503' }] } };
  };

  const res503 = await executeWithRetry(fetchWith503, { maxRetries: 3, testMode: true, baseDelayMs: 5, maxDelayMs: 20 });
  assert.equal(res503.success, true);
  assert.equal(res503.retries, 2);
  assert.equal(res503.history.length, 3);
  assert.equal(res503.history[0].statusCode, 503);
  assert.equal(res503.history[1].statusCode, 503);
  assert.equal(res503.history[2].statusCode, 200);
});

suite.test('1.8 Degraded Source: Exhausted rate limits append SOURCE_DEGRADED ledger event without crashing', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-ledger-'));
  const ledgerPath = path.join(tmpDir, 'ledger.jsonl');

  try {
    const ledger = new EventLedger({ ledgerPath });

    // Persistent 429 endpoint
    let attemptsCount = 0;
    const persistentRateLimited = async () => {
      attemptsCount++;
      return { statusCode: 429, headers: { 'retry-after': '1' } };
    };

    // Execute with retry — must NOT throw
    const result = await executeWithRetry(persistentRateLimited, {
      maxRetries: 2,
      domain: 'exhausted-ats.com',
      source: 'greenhouse',
      testMode: true,
      ledger,
      actor: 'agent:recon'
    });

    assert.equal(result.success, false, 'Persistent 429 must fail gracefully');
    assert.equal(result.degraded, true, 'Result must be flagged as degraded');
    assert.equal(result.error, 'SOURCE_RATE_LIMITED_EXHAUSTED');
    assert.equal(result.statusCode, 429);
    assert.equal(attemptsCount, 3, 'Must attempt initial + 2 retries = 3 attempts total');

    // Verify ledger event was recorded
    const events = ledger.readEvents();
    assert.ok(events.length >= 1, 'Ledger must contain recorded events');
    const degradedEvent = events.find(e => (e.event || e.type) === 'SOURCE_DEGRADED');
    assert.ok(degradedEvent, 'SOURCE_DEGRADED event must be recorded in ledger');
    assert.equal(degradedEvent.payload.source, 'greenhouse');
    assert.equal(degradedEvent.payload.domain, 'exhausted-ats.com');
    assert.equal(degradedEvent.payload.statusCode, 429);
    assert.equal(degradedEvent.payload.reason, 'RATE_LIMIT_EXHAUSTED');

    // Replay through pure reducer
    const state = reduceEvents(events);
    assert.ok(state.health && state.health.sources, 'Health state must track degraded sources');
    assert.equal(state.health.sources['greenhouse'].status, 'DEGRADED');
    assert.equal(state.health.sources['greenhouse'].reason, 'RATE_LIMIT_EXHAUSTED');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ============================================================================
// SECTION 2: Pagination Safety Stress Tests
// ============================================================================

suite.test('2.1 Pagination Safety: Circular next pages cycle detection halts infinite loops', async assert => {
  const adapter = new BaseAtsAdapter('test-ats');

  let callCount = 0;
  // Simulates an API where page 3 returns identical items to page 1
  const circularPageFetcher = async ({ page }) => {
    callCount++;
    if (page === 1) {
      return { items: [{ id: 'job-1', title: 'Software Engineer' }], hasMore: true };
    } else if (page === 2) {
      return { items: [{ id: 'job-2', title: 'Product Manager' }], hasMore: true };
    } else if (page === 3) {
      // Loop back: same items as page 1!
      return { items: [{ id: 'job-1', title: 'Software Engineer' }], hasMore: true };
    }
    return { items: [], hasMore: false };
  };

  const results = await adapter.paginate(circularPageFetcher, { maxPages: 10 });
  assert.equal(results.length, 2, 'Should break cycle on page 3 and keep only 2 unique page sets');
  assert.equal(callCount, 3, 'Must stop exactly on the 3rd fetch when cycle is detected');
  assert.equal(results[0].id, 'job-1');
  assert.equal(results[1].id, 'job-2');
});

suite.test('2.2 Pagination Safety: Repeating cursor tokens halt immediately', async assert => {
  const adapter = new BaseAtsAdapter('test-ats');

  let callCount = 0;
  // Simulates an API where cursor never advances and keeps returning same page
  const repeatingCursorFetcher = async ({ cursor }) => {
    callCount++;
    return {
      items: [{ id: 'job-sticky', title: 'DevOps Lead' }],
      hasMore: true,
      nextCursor: 'same_cursor_token'
    };
  };

  const results = await adapter.paginate(repeatingCursorFetcher, { maxPages: 20 });
  assert.equal(results.length, 1, 'Should collect only 1 batch before halting');
  assert.equal(callCount, 2, 'Must halt on 2nd iteration upon detecting identical content signature');
});

suite.test('2.3 Pagination Safety: MaxPages upper bound prevents runaway iteration', async assert => {
  const adapter = new BaseAtsAdapter('test-ats');

  let callCount = 0;
  // Simulates an endpoint with endless unique items
  const infiniteUniquePages = async ({ page }) => {
    callCount++;
    return {
      items: [{ id: `job-${page}`, title: `Title ${page}` }],
      hasMore: true
    };
  };

  const results = await adapter.paginate(infiniteUniquePages, { maxPages: 5 });
  assert.equal(results.length, 5, 'Should collect exactly maxPages items');
  assert.equal(callCount, 5, 'Must halt at maxPages (5) iterations without running away');
});

suite.test('2.4 Pagination Safety: Empty responses across all 6 ATS adapters terminate cleanly', assert => {
  const emptyCases = [null, undefined, {}, [], { jobs: [] }, { content: [] }, { items: [] }, { jobPostings: [] }];

  for (const empty of emptyCases) {
    assert.deepEqual(GreenhouseAdapter.parseJobs(empty, 'testco'), [], 'Greenhouse must return [] on empty input');
    assert.deepEqual(LeverAdapter.parseJobs(empty, 'testco'), [], 'Lever must return [] on empty input');
    assert.deepEqual(AshbyAdapter.parseJobs(empty, 'testco'), [], 'Ashby must return [] on empty input');
    assert.deepEqual(WorkdayAdapter.parseJobs(empty, 'testco'), [], 'Workday must return [] on empty input');
    assert.deepEqual(SmartRecruitersAdapter.parseJobs(empty, 'testco'), [], 'SmartRecruiters must return [] on empty input');
    assert.deepEqual(OracleCloudAdapter.parseJobs(empty, 'testco'), [], 'Oracle Cloud must return [] on empty input');
  }
});

suite.test('2.5 Pagination Safety: Malformed JSON, HTML error pages, and binary garbage', assert => {
  const malformedInputs = [
    '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>Server Error</body></html>',
    '{"jobs": [{"id": 123, "title": "Truncated JSON...',
    'MALFORMED_GARBAGE_CHARS_\x00\x01\xFF\xFE',
    12345,
    true
  ];

  for (const malformed of malformedInputs) {
    // None of these should throw uncaught exceptions
    assert.deepEqual(GreenhouseAdapter.parseJobs(malformed, 'testco'), []);
    assert.deepEqual(LeverAdapter.parseJobs(malformed, 'testco'), []);
    assert.deepEqual(AshbyAdapter.parseJobs(malformed, 'testco'), []);
    assert.deepEqual(WorkdayAdapter.parseJobs(malformed, 'testco'), []);
    assert.deepEqual(SmartRecruitersAdapter.parseJobs(malformed, 'testco'), []);
    assert.deepEqual(OracleCloudAdapter.parseJobs(malformed, 'testco'), []);
  }
});

suite.test('2.6 Pagination Safety: Missing required fields across ATS parsers yield compliant 12-field objects', assert => {
  // Degenerate items with almost all fields omitted
  const ghJobs = GreenhouseAdapter.parseJobs([{ id: 999 }], 'company_a');
  assert.equal(ghJobs.length, 1);
  assert.equal(ghJobs[0].id, 'greenhouse-company_a-999');
  assert.equal(ghJobs[0].title, '');
  assert.equal(ghJobs[0].location, '');
  assert.equal(ghJobs[0].department, null);

  const leverJobs = LeverAdapter.parseJobs([{ id: 'lev-1' }], 'company_b');
  assert.equal(leverJobs.length, 1);
  assert.equal(leverJobs[0].id, 'lever-company_b-lev-1');
  assert.equal(leverJobs[0].title, '');
  assert.equal(leverJobs[0].remoteStatus, 'unknown');

  const ashbyJobs = AshbyAdapter.parseJobs([{ id: 'ash-1' }], 'company_c');
  assert.equal(ashbyJobs.length, 1);
  assert.equal(ashbyJobs[0].id, 'ashby-company_c-ash-1');
  assert.equal(ashbyJobs[0].title, '');

  const wdJobs = WorkdayAdapter.parseJobs([{ bulletFields: [] }], 'company_d');
  assert.equal(wdJobs.length, 1);
  assert.equal(wdJobs[0].requisitionId, 'unknown');
  assert.equal(wdJobs[0].source, 'workday');

  const srJobs = SmartRecruitersAdapter.parseJobs([{ id: 'sr-1' }], 'company_e');
  assert.equal(srJobs.length, 1);
  assert.equal(srJobs[0].id, 'smartrecruiters-company_e-sr-1');

  const ocJobs = OracleCloudAdapter.parseJobs([{ Id: 'oc-1' }], 'company_f');
  assert.equal(ocJobs.length, 1);
  assert.equal(ocJobs[0].id, 'oracle-company_f-oc-1');

  // Verify all 12 invariant fields exist on parsed items
  const requiredFields = [
    'id', 'requisitionId', 'title', 'company', 'url', 'location',
    'remoteStatus', 'department', 'compensation', 'postedAt', 'rawPayload', 'source'
  ];

  for (const job of [ghJobs[0], leverJobs[0], ashbyJobs[0], wdJobs[0], srJobs[0], ocJobs[0]]) {
    for (const f of requiredFields) {
      assert.ok(f in job, `Field "${f}" must exist on normalized job object`);
    }
  }
});

// ============================================================================
// SECTION 3: Canonical Deduplication Stress Tests
// ============================================================================

suite.test('3.1 Canonical Dedup: 26+ tracking/marketing parameters stripped to identical canonical record', assert => {
  const trackingParams = [
    'utm_source=linkedin',
    'utm_medium=cpc',
    'utm_campaign=hiring_q4',
    'utm_term=cloud_engineer',
    'utm_content=sidebar_banner',
    'utm_custom_segment=emea',
    'utm_experiment_variant=b',
    'gh_src=partner_portal',
    'gh_jid=req_88219',
    'lever-source=recruiter_outreach',
    'lever-origin=applied',
    'ashby_jid=ash_0019',
    'ref=aggregator_feed',
    'source=jobsearch_engine',
    'tracking_id=tr_991823',
    'trackingid=tid_1120',
    'refid=referral_339',
    'trk=public_jobs_topcard',
    'sid=session_guid_xyz',
    'sp_id=spon_110',
    'fbclid=IwAR091283012938102938',
    'gclid=Cj0KCQjws_r99182391283',
    'mc_cid=mailchimp_campaign_01',
    'mc_eid=mailchimp_email_id_02',
    'midtoken=mid_token_hash_abc',
    'originalsubdomain=sa',
    'isfiltered=true',
    'currentjobid=4129381029'
  ];

  const messyUrl = `HTTPS://BOARDS.GREENHOUSE.IO/STC/JOBS/88219/?${trackingParams.join('&')}#application-form`;
  const canonical = 'https://boards.greenhouse.io/stc/jobs/88219';

  const normalized = normalizeJobUrl(messyUrl);
  assert.equal(normalized, canonical, 'URL with 28 tracking parameters, upper case, trailing slash, and hash must normalize cleanly');
});

suite.test('3.2 Canonical Dedup: Trailing slashes, anchor hashes, and protocol casing normalization', assert => {
  const variants = [
    'HTTPS://Jobs.Lever.co/Roshn/Lead-Architect/',
    'https://jobs.lever.co/roshn/lead-architect',
    'https://jobs.lever.co/roshn/lead-architect#job-description',
    'https://jobs.lever.co/roshn/lead-architect/#apply?utm_source=email',
    'HTTPS://JOBS.LEVER.CO/ROSHN/LEAD-ARCHITECT'
  ];

  const expected = 'https://jobs.lever.co/roshn/lead-architect';
  for (const v of variants) {
    assert.equal(normalizeJobUrl(v), expected, `Variant "${v}" must normalize to "${expected}"`);
  }
});

suite.test('3.3 Canonical Dedup: ATS specific route collapsing (Greenhouse embed, Lever /apply, Ashby /application)', assert => {
  // Greenhouse embed route collapsed to public job page
  const ghEmbed = 'https://boards.greenhouse.io/embed/job_app?for=tamara&token=401928&utm_source=feed';
  assert.equal(normalizeJobUrl(ghEmbed), 'https://boards.greenhouse.io/tamara/jobs/401928');

  // Lever /apply stripped
  const leverApply = 'https://jobs.lever.co/tabby/771029/apply?utm_campaign=winter';
  assert.equal(normalizeJobUrl(leverApply), 'https://jobs.lever.co/tabby/771029');

  // Ashby /application stripped
  const ashbyApp = 'https://jobs.ashbyhq.com/floward/11029/application';
  assert.equal(normalizeJobUrl(ashbyApp), 'https://jobs.ashbyhq.com/floward/11029');
});

suite.test('3.4 Canonical Dedup: Legitimate business query parameters are preserved and sorted deterministically', assert => {
  const url1 = 'https://careers.neom.com/jobs?department=Technology&location=Riyadh';
  const url2 = 'https://careers.neom.com/jobs?location=Riyadh&department=Technology&utm_source=Bayt';

  const norm1 = normalizeJobUrl(url1);
  const norm2 = normalizeJobUrl(url2);

  // Both should preserve department and location in alphabetical order, strip utm_source, and collapse to identical URL
  const expected = 'https://careers.neom.com/jobs?department=Technology&location=Riyadh';
  assert.equal(norm1, expected, 'Query params should be sorted deterministically');
  assert.equal(norm2, expected, 'Tracking query param should be stripped and remaining sorted');
  assert.equal(norm1, norm2, 'Both URLs must collapse to identical canonical record');
});

suite.test('3.5 Canonical Dedup: Requisition deduplication across multi-channel sweeps', assert => {
  const existingJobs = [
    {
      id: 'job_001',
      requisitionId: 'REQ-1001',
      title: 'Principal AI Architect',
      company: 'NEOM',
      location: 'NEOM, Saudi Arabia',
      url: 'https://careers.neom.com/jobs/req-1001'
    }
  ];

  // Discovery A: Same URL with tracking params
  const candidateA = {
    title: 'Principal AI Architect',
    company: 'NEOM',
    url: 'https://careers.neom.com/jobs/req-1001/?utm_source=LinkedIn&trk=job_view#overview'
  };
  const checkA = checkDuplicateRequisition(existingJobs, candidateA, { throwOnError: false });
  assert.equal(checkA.isDuplicate, true);
  assert.equal(checkA.matchType, 'CANONICAL_URL');

  // Discovery B: Matching requisition ID at same company
  const candidateB = {
    requisitionId: 'REQ-1001',
    title: 'AI Architect - Core Infrastructure',
    company: 'NEOM',
    url: 'https://external-aggregator.com/jobs/xyz999'
  };
  const checkB = checkDuplicateRequisition(existingJobs, candidateB, { throwOnError: false });
  assert.equal(checkB.isDuplicate, true);
  assert.equal(checkB.matchType, 'REQUISITION_ID');

  // Discovery C: Exact Title + Company + Location
  const candidateC = {
    title: 'Principal AI Architect',
    company: 'NEOM',
    location: 'NEOM, Saudi Arabia',
    url: 'https://another-site.com/jobs/random-path'
  };
  const checkC = checkDuplicateRequisition(existingJobs, candidateC, { throwOnError: false });
  assert.equal(checkC.isDuplicate, true);
  assert.equal(checkC.matchType, 'TITLE_COMPANY_LOCATION');

  // Non-duplicate: Different requisition at same company
  const candidateDistinct = {
    requisitionId: 'REQ-1002',
    title: 'Principal Cloud Architect',
    company: 'NEOM',
    location: 'NEOM, Saudi Arabia',
    url: 'https://careers.neom.com/jobs/req-1002'
  };
  const checkDistinct = checkDuplicateRequisition(existingJobs, candidateDistinct, { throwOnError: false });
  assert.equal(checkDistinct.isDuplicate, false);
});

suite.test('3.6 Canonical Dedup: Fingerprint collision resistance between distinct roles', assert => {
  const fp1 = generateFingerprint('Cloud Architect', 'Red Sea Global', 'Riyadh', 'REQ-A');
  const fp2 = generateFingerprint('Cloud Architect', 'Red Sea Global', 'Riyadh', 'REQ-B');
  assert.notEqual(fp1, fp2, 'Distinct requisition IDs at same company must generate distinct fingerprints');

  const fp3 = generateFingerprint('Data Engineer', 'Diriyah', 'Riyadh');
  const fp4 = generateFingerprint('Data Engineer', 'Diriyah', 'Jeddah');
  assert.notEqual(fp3, fp4, 'Different locations must generate distinct fingerprints');

  const fp5 = generateFingerprint('Lead Security Engineer', 'ROSHN');
  const fp6 = generateFingerprint('Lead Security Engineer', 'Qiddiya');
  assert.notEqual(fp5, fp6, 'Different employers must generate distinct fingerprints');
});

suite.test('3.7 Application Guard: 30-day cooldown enforcement prevents premature re-applications', assert => {
  const guard = new DuplicateApplicationGuard(30);

  const appliedDate = new Date('2026-10-01T10:00:00Z');
  guard.recordApplication('REQ-55', 'Tamara', appliedDate.toISOString());

  // Attempt re-applying to same requisition 10 days later -> BLOCKED
  const checkSameReq = guard.evaluateApplicationEligibility('REQ-55', 'Tamara', new Date('2026-10-11T10:00:00Z'));
  assert.equal(checkSameReq.allowed, false);
  assert.equal(checkSameReq.reason, 'DUPLICATE_REQUISITION');

  // Attempt applying to another role at same company 15 days later -> ALLOWED with active cooldown warning
  const checkDifferentRole = guard.evaluateApplicationEligibility('REQ-99', 'Tamara', new Date('2026-10-16T10:00:00Z'));
  assert.equal(checkDifferentRole.allowed, true);
  assert.equal(checkDifferentRole.warning, 'COMPANY_COOLDOWN_ACTIVE');
  assert.equal(checkDifferentRole.cooldownRemainingDays, 15);

  // Attempt applying after 35 days -> ALLOWED with NO cooldown warning
  const checkPostCooldown = guard.evaluateApplicationEligibility('REQ-100', 'Tamara', new Date('2026-11-06T10:00:00Z'));
  assert.equal(checkPostCooldown.allowed, true);
  assert.equal(checkPostCooldown.warning, null);
});

// ============================================================================
// SECTION 4: Advanced Host & Non-Retryable Error Stress Tests
// ============================================================================

suite.test('4.1 Rate Limiting: Host normalization unifies raw URLs, uppercase, and ports to single bucket', assert => {
  const limiter = new DomainTokenBucketRateLimiter();

  // All 4 calls refer to boards-api.greenhouse.io (capacity 10)
  assert.ok(limiter.tryAcquire('https://boards-api.greenhouse.io/v1/boards/stc/jobs'));
  assert.ok(limiter.tryAcquire('HTTPS://BOARDS-API.GREENHOUSE.IO:443/V1/'));
  assert.ok(limiter.tryAcquire('  boards-api.greenhouse.io  '));
  assert.ok(limiter.tryAcquire('boards-api.greenhouse.io'));

  // Should have consumed 4 tokens from the same bucket
  const bucket = limiter.getBucket('boards-api.greenhouse.io');
  assert.equal(Math.floor(bucket.tokens), 6, 'All variations must hit the exact same token bucket');
});

suite.test('4.2 Degraded Source: Non-retryable HTTP 401 & 403 halts immediately and records degradation', async assert => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'challenger-403-'));
  const ledgerPath = path.join(tmpDir, 'ledger.jsonl');

  try {
    const ledger = new EventLedger({ ledgerPath });

    let callCount = 0;
    const wafBlockedEndpoint = async () => {
      callCount++;
      return { statusCode: 403, headers: {}, error: 'Forbidden by Cloudflare WAF' };
    };

    const res = await executeWithRetry(wafBlockedEndpoint, {
      maxRetries: 3,
      domain: 'waf-protected.sa',
      source: 'bayt',
      ledger,
      testMode: true
    });

    assert.equal(res.success, false);
    assert.equal(res.degraded, true);
    assert.equal(res.statusCode, 403);
    assert.equal(res.error, 'WAF_CHALLENGE_BLOCKED');
    assert.equal(callCount, 1, 'Must NOT retry on 403 WAF challenge — halts immediately');

    const events = ledger.readEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.reason, 'WAF_CHALLENGE_BLOCKED');
    assert.equal(events[0].payload.statusCode, 403);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

suite.test('4.3 Deduplication: Duplicate requisition throws when throwOnError is true', assert => {
  const existing = [{
    id: 'job_dup_1',
    requisitionId: 'REQ-999',
    company: 'Tamara',
    title: 'Senior Product Manager',
    location: 'Riyadh',
    url: 'https://careers.tamara.co/jobs/req-999'
  }];

  const candidate = {
    requisitionId: 'REQ-999',
    company: 'Tamara',
    title: 'Senior Product Manager',
    url: 'https://careers.tamara.co/jobs/req-999'
  };

  assert.throws(
    () => checkDuplicateRequisition(existing, candidate, { throwOnError: true }),
    /DUPLICATE_REQUISITION/,
    'Must throw DUPLICATE_REQUISITION Error when duplicate is discovered with throwOnError'
  );
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}

