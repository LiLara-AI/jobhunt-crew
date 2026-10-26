'use strict';
/**
 * Milestone M4 Iteration 2 Empirical Adversarial Stress Test Suite
 *
 * Authored by: challenger_m4_iter2_1 (Empirical Challenger)
 * Scope: Multi-Channel Job Discovery Subsystems:
 *   1. Rate Limiting, Backoff & Error Edge Cases:
 *      - parseRetryAfter adversarial inputs: "-10", "-0", "-1.5", "abc", "", null, undefined,
 *        future RFC 7231 dates, past dates, non-numeric strings with trailing text, Infinity, NaN.
 *      - Token bucket replenishment capacity ceiling.
 *      - Concurrency token acquisition & potential leakage under concurrency.
 *      - Unrecoverable 429 and 503 errors emitting SOURCE_DEGRADED ledger events.
 *   2. ATS Adapter URL Canonicalization Stress:
 *      - All 6 concrete ATS adapters (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Oracle Cloud).
 *      - URLs with gh_jid, utm_source, utm_campaign, utm_medium, fbclid, gclid, _hsenc, ref, source, lever-source, ashby_jid.
 *      - Confirm whether all tracking parameters are stripped and path formatting is deterministic.
 *   3. Pagination Loop & Truncation Resilience:
 *      - Duplicate items across pages, cycle cursors, empty responses, malformed JSON, and truncated responses.
 */

const assert = require('assert');
const { TestSuite } = require('../helpers/test-harness');

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

const { normalizeJobUrl } = require('../../lib/guardrails/dedup');
const { reduceEvents } = require('../../lib/ledger/reducer');

const suite = new TestSuite('M4 Iteration 2 Adversarial Stress Test Suite');

// ============================================================================
// SECTION 1: Rate Limiting, Backoff & Error Edge Cases
// ============================================================================

suite.test('1.1 parseRetryAfter with adversarial negative inputs returns null', () => {
  assert.strictEqual(parseRetryAfter('-10'), null, '"-10" must return null');
  assert.strictEqual(parseRetryAfter('-0'), null, '"-0" string must return null');
  assert.strictEqual(parseRetryAfter('-1.5'), null, '"-1.5" must return null');
  assert.strictEqual(parseRetryAfter('-Infinity'), null, '"-Infinity" must return null');
  assert.strictEqual(parseRetryAfter(-10), null, 'Number -10 must return null');
  // Note: In JavaScript String(-0) converts to "0", so Object.is(-0, headerValue) would be required to catch numeric -0.
});

suite.test('1.2 parseRetryAfter with non-numeric, empty, null, and undefined returns null', () => {
  assert.strictEqual(parseRetryAfter('abc'), null, '"abc" must return null');
  assert.strictEqual(parseRetryAfter(''), null, '"" must return null');
  assert.strictEqual(parseRetryAfter('   '), null, 'whitespace must return null');
  assert.strictEqual(parseRetryAfter(null), null, 'null must return null');
  assert.strictEqual(parseRetryAfter(undefined), null, 'undefined must return null');
  assert.strictEqual(parseRetryAfter('Infinity'), null, '"Infinity" must return null');
  assert.strictEqual(parseRetryAfter('NaN'), null, '"NaN" must return null');
  assert.strictEqual(parseRetryAfter({}), null, 'Object must return null');
  assert.strictEqual(parseRetryAfter([]), null, 'Array must return null');
  assert.strictEqual(parseRetryAfter(true), null, 'Boolean true must return null');
});

suite.test('1.3 parseRetryAfter with trailing non-numeric text returns null', () => {
  assert.strictEqual(parseRetryAfter('10 seconds'), null, '"10 seconds" must return null');
  assert.strictEqual(parseRetryAfter('10s'), null, '"10s" must return null');
  assert.strictEqual(parseRetryAfter('5 minutes'), null, '"5 minutes" must return null');
  assert.strictEqual(parseRetryAfter('120 sec'), null, '"120 sec" must return null');
  assert.strictEqual(parseRetryAfter('10 abc'), null, '"10 abc" must return null');
  assert.strictEqual(parseRetryAfter('500ms'), null, '"500ms" must return null');
});

suite.test('1.4 parseRetryAfter with valid integer and decimal values', () => {
  assert.strictEqual(parseRetryAfter('0'), 0, '"0" must return 0 ms');
  assert.strictEqual(parseRetryAfter('5'), 5000, '"5" must return 5000 ms');
  assert.strictEqual(parseRetryAfter(' 120 '), 120000, 'padded " 120 " must return 120000 ms');
  assert.strictEqual(parseRetryAfter('1.5'), 1500, '"1.5" must return 1500 ms');
  assert.strictEqual(parseRetryAfter(10), 10000, 'numeric 10 must return 10000 ms');
});

suite.test('1.5 parseRetryAfter with future and past RFC 7231 / RFC 1123 HTTP-Dates', () => {
  const futureDate = new Date(Date.now() + 10000).toUTCString();
  const futureMs = parseRetryAfter(futureDate);
  assert.ok(typeof futureMs === 'number', 'Future date must return numeric ms');
  assert.ok(futureMs > 0 && futureMs <= 11000, `Future ms (${futureMs}) must be roughly 10000 ms`);

  const pastDate = new Date(Date.now() - 10000).toUTCString();
  const pastMs = parseRetryAfter(pastDate);
  assert.strictEqual(pastMs, 0, 'Past date must clamp to 0 ms delay');
});

suite.test('1.6 Token bucket replenishment strictly clamped to capacity ceiling', () => {
  const limiter = new DomainTokenBucketRateLimiter({
    profiles: [
      { pattern: /ceiling-test\.com/, capacity: 6, refillRate: 10.0, maxConcurrency: 1 }
    ]
  });

  const bucket = limiter.getBucket('ceiling-test.com');
  assert.strictEqual(bucket.tokens, 6, 'Initial capacity must be 6');

  // Drain bucket
  assert.ok(limiter.tryAcquire('ceiling-test.com', 6), 'Draining 6 tokens should succeed');
  assert.strictEqual(bucket.tokens, 0, 'Tokens must be 0 after drain');

  // Simulate advancing time into the distant future (100,000 seconds)
  bucket.lastRefill = Date.now() - 100000 * 1000;
  limiter.refill(bucket);

  assert.strictEqual(bucket.tokens, 6, 'Tokens must never exceed capacity of 6 despite long elapsed time');
});

suite.test('1.7 Synchronous burst concurrency does not bleed tokens across attempts', () => {
  const limiter = new DomainTokenBucketRateLimiter({
    profiles: [
      { pattern: /sync-burst\.com/, capacity: 5, refillRate: 1.0, maxConcurrency: 1 }
    ]
  });

  let granted = 0;
  let rejected = 0;
  for (let i = 0; i < 50; i++) {
    if (limiter.tryAcquire('sync-burst.com', 1)) {
      granted++;
    } else {
      rejected++;
    }
  }

  assert.strictEqual(granted, 5, 'Exactly 5 attempts must acquire tokens');
  assert.strictEqual(rejected, 45, '45 attempts must be rejected without bleeding');
  assert.ok(
    limiter.getBucket('sync-burst.com').tokens < 0.1,
    `Remaining tokens must be approximately 0 (actual: ${limiter.getBucket('sync-burst.com').tokens})`
  );
});

suite.test('1.8 Unrecoverable 429 and 503 retries emit SOURCE_DEGRADED ledger event', async () => {
  const events = [];
  const mockLedger = {
    appendEvent: async (e) => events.push(e)
  };

  // Exhausted 429
  const res429 = await executeWithRetry(
    async () => ({ statusCode: 429, headers: {} }),
    { maxRetries: 2, testMode: true, domain: 'rate-limited-429.com', ledger: mockLedger }
  );

  assert.strictEqual(res429.success, false, 'Result must be unsuccessful');
  assert.strictEqual(res429.degraded, true, 'Result must be marked degraded');
  assert.strictEqual(res429.error, 'SOURCE_RATE_LIMITED_EXHAUSTED');

  // Exhausted 503
  const res503 = await executeWithRetry(
    async () => ({ statusCode: 503, headers: {} }),
    { maxRetries: 2, testMode: true, domain: 'service-down-503.com', ledger: mockLedger }
  );

  assert.strictEqual(res503.success, false);
  assert.strictEqual(res503.degraded, true);
  assert.strictEqual(res503.error, 'SOURCE_RATE_LIMITED_EXHAUSTED');

  // Verify ledger events recorded
  assert.strictEqual(events.length, 2, 'Two SOURCE_DEGRADED events must be emitted');

  const ev429 = events[0];
  assert.strictEqual(ev429.event, 'SOURCE_DEGRADED');
  assert.strictEqual(ev429.payload.reason, 'RATE_LIMIT_EXHAUSTED');
  assert.strictEqual(ev429.payload.statusCode, 429);
  assert.strictEqual(ev429.payload.domain, 'rate-limited-429.com');

  const ev503 = events[1];
  assert.strictEqual(ev503.event, 'SOURCE_DEGRADED');
  assert.strictEqual(ev503.payload.reason, 'SERVICE_UNAVAILABLE');
  assert.strictEqual(ev503.payload.statusCode, 503);
  assert.strictEqual(ev503.payload.domain, 'service-down-503.com');

  // Verify pure reducer processes SOURCE_DEGRADED correctly
  const state = reduceEvents(events);
  assert.ok(state.health.sources['rate-limited-429.com'], '429 source must be registered in health');
  assert.strictEqual(state.health.sources['rate-limited-429.com'].status, 'DEGRADED');
  assert.strictEqual(state.health.sources['service-down-503.com'].status, 'DEGRADED');
});

suite.test('1.9 Asynchronous acquire() serializes concurrent callers without leaking tokens', async () => {
  const limiter = new DomainTokenBucketRateLimiter([
    { pattern: /concurrency-test\.com/, capacity: 1, refillRate: 20.0, maxConcurrency: 1 }
  ]);

  // Drain initial token
  assert.ok(limiter.tryAcquire('concurrency-test.com', 1), 'Initial drain succeeds');

  const start = Date.now();
  // Request 3 tokens concurrently. With refillRate 20.0 (50ms per token),
  // serialized acquisition must take >= 100ms total, not 50ms.
  const waits = await Promise.all([
    limiter.acquire('concurrency-test.com', 1),
    limiter.acquire('concurrency-test.com', 1),
    limiter.acquire('concurrency-test.com', 1)
  ]);

  const elapsed = Date.now() - start;
  assert.strictEqual(waits.length, 3, 'All 3 acquire calls must resolve');
  assert.ok(elapsed >= 100, `Concurrent acquires must serialize over time, elapsed: ${elapsed}ms (expected >= 100ms)`);
});

// ============================================================================
// SECTION 2: ATS Adapter URL Canonicalization Stress
// ============================================================================

suite.test('2.1 Tracking parameter stripping stress across normalizeJobUrl', () => {
  const testParams = [
    'gh_jid', 'utm_source', 'utm_campaign', 'utm_medium',
    'fbclid', 'gclid', 'ref', 'source', 'lever-source', 'ashby_jid'
  ];

  for (const p of testParams) {
    const rawUrl = `https://boards.greenhouse.io/corp/jobs/1001?${p}=test_token_123&keep_this=1`;
    const clean = normalizeJobUrl(rawUrl);
    assert.ok(!clean.includes(p + '='), `Parameter "${p}" should be stripped from ${clean}`);
    assert.ok(clean.includes('keep_this=1'), `Legitimate parameter keep_this must be preserved`);
  }
});

suite.test('2.2 Verification of HubSpot tracking parameters stripped by normalizeJobUrl', () => {
  // Verify _hsenc, _hsmi, and hs_* prefixes are stripped cleanly
  const rawUrl = 'https://boards.greenhouse.io/corp/jobs/1001?_hsenc=p223_encrypted_token&_hsmi=12345&hs_preview=test&keep=1';
  const clean = normalizeJobUrl(rawUrl);
  assert.ok(!clean.includes('_hsenc='), '_hsenc must be stripped from canonical URL');
  assert.ok(!clean.includes('_hsmi='), '_hsmi must be stripped from canonical URL');
  assert.ok(!clean.includes('hs_preview='), 'hs_* params must be stripped from canonical URL');
  assert.ok(clean.includes('keep=1'), 'Non-tracking param keep=1 must be preserved');
});

suite.test('2.3 GreenhouseAdapter canonical URL emission and tracking parameter stripping', () => {
  const rawJob = {
    id: 50101,
    title: 'Platform Engineer',
    absolute_url: 'https://boards.greenhouse.io/techcorp/jobs/50101/?gh_jid=50101&utm_source=email&utm_campaign=hire&fbclid=abc123'
  };

  const parsed = GreenhouseAdapter.parseJobs([rawJob], 'techcorp');
  assert.strictEqual(parsed.length, 1);
  const url = parsed[0].url;

  assert.strictEqual(url, 'https://boards.greenhouse.io/techcorp/jobs/50101');
  assert.ok(!url.includes('gh_jid'), 'gh_jid must be stripped');
  assert.ok(!url.includes('utm_source'), 'utm_source must be stripped');
  assert.ok(!url.includes('fbclid'), 'fbclid must be stripped');
  assert.ok(!url.endsWith('/'), 'Trailing slash must be stripped');
});

suite.test('2.4 LeverAdapter canonical URL emission and tracking parameter stripping', () => {
  const rawJob = {
    id: 'lever-900',
    text: 'Site Reliability Engineer',
    hostedUrl: 'https://jobs.lever.co/techcorp/lever-900/apply?lever-source=linkedin&utm_medium=cpc&gclid=xyz456'
  };

  const parsed = LeverAdapter.parseJobs([rawJob], 'techcorp');
  assert.strictEqual(parsed.length, 1);
  const url = parsed[0].url;

  assert.strictEqual(url, 'https://jobs.lever.co/techcorp/lever-900');
  assert.ok(!url.includes('/apply'), '/apply path must be collapsed');
  assert.ok(!url.includes('lever-source'), 'lever-source must be stripped');
  assert.ok(!url.includes('utm_medium'), 'utm_medium must be stripped');
  assert.ok(!url.includes('gclid'), 'gclid must be stripped');
});

suite.test('2.5 AshbyAdapter canonical URL emission and tracking parameter stripping', () => {
  const rawJob = {
    id: 'ashby-1234',
    title: 'Lead Architect',
    jobUrl: 'https://jobs.ashbyhq.com/techcorp/ashby-1234/application/?ashby_jid=ashby-1234&ref=jobboard&source=newsletter'
  };

  const parsed = AshbyAdapter.parseJobs([rawJob], 'techcorp');
  assert.strictEqual(parsed.length, 1);
  const url = parsed[0].url;

  assert.strictEqual(url, 'https://jobs.ashbyhq.com/techcorp/ashby-1234');
  assert.ok(!url.includes('/application'), '/application path must be collapsed');
  assert.ok(!url.includes('ashby_jid'), 'ashby_jid must be stripped');
  assert.ok(!url.includes('ref='), 'ref must be stripped');
  assert.ok(!url.includes('source='), 'source must be stripped');
});

suite.test('2.6 WorkdayAdapter canonical URL emission and tracking parameter stripping', () => {
  const rawJob = {
    title: 'Cloud Security Architect',
    bulletFields: ['JR-10992'],
    externalPath: '/en-US/careers/job/Cloud-Security-Architect_JR-10992/?utm_source=indeed&utm_campaign=q4&fbclid=fb_click'
  };

  const parsed = WorkdayAdapter.parseJobs([rawJob], 'techcorp', { host: 'techcorp.wd1.myworkdayjobs.com' });
  assert.strictEqual(parsed.length, 1);
  const url = parsed[0].url;

  assert.strictEqual(url, 'https://techcorp.wd1.myworkdayjobs.com/en-us/careers/job/cloud-security-architect_jr-10992');
  assert.ok(!url.includes('utm_source'), 'utm_source must be stripped');
  assert.ok(!url.includes('fbclid'), 'fbclid must be stripped');
  assert.ok(!url.endsWith('/'), 'Trailing slash must be stripped');
});

suite.test('2.7 SmartRecruitersAdapter canonical URL emission and tracking parameter stripping', () => {
  const rawJob = {
    id: 'sr-8812',
    name: 'Backend Tech Lead',
    postingUrl: 'https://jobs.smartrecruiters.com/techcorp/sr-8812/?utm_campaign=social&gclid=g_click&ref=referral'
  };

  const parsed = SmartRecruitersAdapter.parseJobs([rawJob], 'techcorp');
  assert.strictEqual(parsed.length, 1);
  const url = parsed[0].url;

  assert.strictEqual(url, 'https://jobs.smartrecruiters.com/techcorp/sr-8812');
  assert.ok(!url.includes('utm_campaign'), 'utm_campaign must be stripped');
  assert.ok(!url.includes('gclid'), 'gclid must be stripped');
  assert.ok(!url.includes('ref='), 'ref must be stripped');
});

suite.test('2.8 OracleCloudAdapter canonical URL emission and tracking parameter stripping', () => {
  const rawJob = {
    RequisitionNumber: '300000109928172',
    PostingTitle: 'Executive Director Infrastructure',
    ExternalURL: 'https://careers.neom.com/hcmUI/CandidateExperience/en/sites/CX/job/300000109928172/?utm_source=linkedin&utm_campaign=hcm&fbclid=123'
  };

  const parsed = OracleCloudAdapter.parseJobs([rawJob], 'neom');
  assert.strictEqual(parsed.length, 1);
  const url = parsed[0].url;

  assert.strictEqual(url, 'https://careers.neom.com/hcmui/candidateexperience/en/sites/cx/job/300000109928172');
  assert.ok(!url.includes('utm_source'), 'utm_source must be stripped');
  assert.ok(!url.includes('utm_campaign'), 'utm_campaign must be stripped');
  assert.ok(!url.includes('fbclid'), 'fbclid must be stripped');
});

// ============================================================================
// SECTION 3: Pagination Loop & Truncation Resilience
// ============================================================================

suite.test('3.1 BaseAtsAdapter cycle detection halts infinite pagination on duplicate items', async () => {
  const adapter = new BaseAtsAdapter('cycle-test');

  let callCount = 0;
  const items = await adapter.paginate(async ({ page }) => {
    callCount++;
    return {
      items: [{ id: 'job-1', title: 'Circular Dev' }],
      hasMore: true
    };
  }, { maxPages: 20 });

  assert.strictEqual(callCount, 2, 'Pagination must halt on 2nd page when identical item signature is encountered');
  assert.strictEqual(items.length, 1, 'Only 1 unique page of items should be collected');
});

suite.test('3.2 BaseAtsAdapter cycle detection on interleaved duplicate pages', async () => {
  const adapter = new BaseAtsAdapter('interleaved-test');

  let callCount = 0;
  const items = await adapter.paginate(async ({ page }) => {
    callCount++;
    if (page === 1) return { items: [{ id: 'job-A' }], hasMore: true };
    if (page === 2) return { items: [{ id: 'job-B' }], hasMore: true };
    // Page 3 repeats Page 1
    return { items: [{ id: 'job-A' }], hasMore: true };
  }, { maxPages: 20 });

  assert.strictEqual(callCount, 3, 'Pagination must halt on Page 3 when Page 1 signature repeats');
  assert.strictEqual(items.length, 2, 'Only items from Page 1 and Page 2 should be returned');
});

suite.test('3.3 BaseAtsAdapter halts immediately on empty response even if hasMore is true', async () => {
  const adapter = new BaseAtsAdapter('empty-test');

  let callCount = 0;
  const items = await adapter.paginate(async () => {
    callCount++;
    return { items: [], hasMore: true };
  }, { maxPages: 20 });

  assert.strictEqual(callCount, 1, 'Must halt immediately on empty items array');
  assert.strictEqual(items.length, 0);
});

suite.test('3.4 BaseAtsAdapter halts cleanly on null or malformed pageResult', async () => {
  const adapter = new BaseAtsAdapter('null-test');

  let callCount = 0;
  const items = await adapter.paginate(async () => {
    callCount++;
    return null;
  }, { maxPages: 20 });

  assert.strictEqual(callCount, 1, 'Must halt on null pageResult');
  assert.strictEqual(items.length, 0);
});

suite.test('3.5 BaseAtsAdapter strictly respects maxPages boundary', async () => {
  const adapter = new BaseAtsAdapter('maxpages-test');

  let callCount = 0;
  const items = await adapter.paginate(async ({ page }) => {
    callCount++;
    return {
      items: [{ id: `unique-job-${page}` }],
      hasMore: true
    };
  }, { maxPages: 7 });

  assert.strictEqual(callCount, 7, 'Must stop strictly at maxPages 7');
  assert.strictEqual(items.length, 7);
});

suite.test('3.6 Degenerate inputs (null, undefined, HTML error) across all 6 parseJobs implementations', () => {
  const testInputs = [
    null,
    undefined,
    '',
    '<html>502 Bad Gateway</html>',
    '{ truncated json without closing brace',
    {},
    [],
    { jobs: null },
    { jobPostings: null },
    { content: null },
    { items: null }
  ];

  const adapters = [
    { name: 'Greenhouse', fn: GreenhouseAdapter.parseJobs },
    { name: 'Lever', fn: LeverAdapter.parseJobs },
    { name: 'Ashby', fn: AshbyAdapter.parseJobs },
    { name: 'Workday', fn: WorkdayAdapter.parseJobs },
    { name: 'SmartRecruiters', fn: SmartRecruitersAdapter.parseJobs },
    { name: 'OracleCloud', fn: OracleCloudAdapter.parseJobs }
  ];

  for (const a of adapters) {
    for (const input of testInputs) {
      const res = a.fn(input, 'test-corp');
      assert.ok(Array.isArray(res), `${a.name} must return an array for degenerate input ${typeof input}`);
      assert.strictEqual(res.length, 0, `${a.name} must return empty array for degenerate input`);
    }
  }
});

suite.test('3.7 Sparse / null / degenerate items in array do not crash parseJobs across all 6 adapters', () => {
  const sparseInputs = [
    [null],
    [undefined],
    [null, undefined, 42, 'string', true],
    [{ id: 999 }, null, undefined]
  ];

  const adapters = [
    { name: 'Greenhouse', fn: GreenhouseAdapter.parseJobs },
    { name: 'Lever', fn: LeverAdapter.parseJobs },
    { name: 'Ashby', fn: AshbyAdapter.parseJobs },
    { name: 'Workday', fn: WorkdayAdapter.parseJobs },
    { name: 'SmartRecruiters', fn: SmartRecruitersAdapter.parseJobs },
    { name: 'OracleCloud', fn: OracleCloudAdapter.parseJobs }
  ];

  for (const a of adapters) {
    for (const input of sparseInputs) {
      assert.doesNotThrow(() => {
        const res = a.fn(input, 'test-corp');
        assert.ok(Array.isArray(res), `${a.name} must return an array for sparse input`);
      }, `${a.name} must not throw on sparse/null items`);
    }
  }
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(summary => {
    console.log(`\nResult: ${summary.failed === 0 ? 'PASS' : 'FAIL'} (${summary.passed} passed, ${summary.failed} failed)`);
    if (summary.failed > 0) process.exit(1);
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
