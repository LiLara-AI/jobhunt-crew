'use strict';
/**
 * Tier 2: Boundary & Corner Cases - Rate Limit Backoff & Degraded Source Reporting
 * Verifies HTTP 429 response handling, exponential backoff, Retry-After header parsing,
 * and reporting of blocked/degraded channels without silent drops.
 */

const { TestSuite } = require('../helpers/test-harness');
const { RateLimitClient, parseRetryAfter } = require('../../lib/discovery/rate-limiter');

const suite = new TestSuite('Tier 2: Rate Limit Backoff & Degraded Reporting');

suite.test('429 response triggers backoff and succeeds on subsequent retry', async assert => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    if (callCount === 1) {
      return { statusCode: 429, headers: { 'retry-after': '1' } };
    }
    return { statusCode: 200, headers: {}, data: { postings: ['job_1'] } };
  };

  const result = await RateLimitClient.fetchWithBackoff(mockFetch, 2);
  assert.equal(result.success, true);
  assert.equal(result.retries, 1);
  assert.equal(result.history.length, 2);
  assert.equal(result.history[0].statusCode, 429);
  assert.equal(result.history[1].statusCode, 200);
});

suite.test('Persistent 429 rate limiting flags source as degraded without silent drop', async assert => {
  const persistent429 = async () => ({
    statusCode: 429,
    headers: { 'retry-after': '2' }
  });

  const result = await RateLimitClient.fetchWithBackoff(persistent429, 2);
  assert.equal(result.success, false);
  assert.equal(result.degraded, true);
  assert.equal(result.error, 'SOURCE_RATE_LIMITED_EXHAUSTED');
  assert.ok(result.message.includes('Source flagged as DEGRADED'));
});

suite.test('parseRetryAfter strictly rejects negative numbers and invalid formats', assert => {
  assert.equal(parseRetryAfter('-10'), null, 'Negative string "-10" must return null');
  assert.equal(parseRetryAfter('-1'), null, 'Negative string "-1" must return null');
  assert.equal(parseRetryAfter('-1000'), null, 'Negative string "-1000" must return null');
  assert.equal(parseRetryAfter(-10), null, 'Negative number -10 must return null');
  assert.equal(parseRetryAfter(0), 0, 'Zero returns 0ms');
  assert.equal(parseRetryAfter('0'), 0, 'Zero string returns 0ms');
  assert.equal(parseRetryAfter('120'), 120000, 'Positive seconds converted to ms');
  assert.equal(parseRetryAfter(null), null, 'null returns null');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
