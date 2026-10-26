'use strict';

/**
 * Tier 1: Feature Coverage — STAR+R Interview Story Bank & Pack Generator
 *
 * Verifies:
 * 1. STAR+R structural schema validation (Situation, Task, Action, Result, Reflection).
 * 2. Deterministic claim binding and unverified metric / employer mismatch gating.
 * 3. Status confirmation gating (CONFIRM status marks story as DRAFT_PENDING_CONFIRMATION).
 * 4. Interview preparation pack compilation with reverse-interview questions.
 */

const { TestSuite } = require('../helpers/test-harness');
const { StarRStoryBank } = require('../../lib/crew/interview-story-bank');

const suite = new TestSuite('M5 Feature 30: STAR+R Story Bank & Interview Pack Generator');

suite.test('StarRStoryBank validates STAR+R structural schema and throws on missing components', assert => {
  const bank = new StarRStoryBank();

  // Missing situation
  assert.throws(() => {
    bank.validateStory({
      claimId: 'CLM-01',
      task: 'Migrate monolith to microservices',
      action: 'Designed event-driven Kafka pipeline',
      result: 'Reduced latency by 45%',
      reflection: 'Early load testing prevents cascading timeouts'
    });
  }, /Missing or empty required STAR\+R field: "situation"/);

  // Missing reflection (+R)
  assert.throws(() => {
    bank.validateStory({
      claimId: 'CLM-01',
      situation: 'Legacy billing system faced 40% failure rates',
      task: 'Redesign payment pipeline',
      action: 'Introduced idempotent retry workers',
      result: 'Decreased transaction drop rate to 0.01%'
    });
  }, /Missing or empty required STAR\+R field: "reflection"/);

  // Missing claimId
  assert.throws(() => {
    bank.validateStory({
      situation: 'Infrastructure costs spiraled during hypergrowth',
      task: 'Cut cluster costs by 30%',
      action: 'Implemented spot instance autoscaling',
      result: 'Saved $250k annually',
      reflection: 'Graceful shutdown handling is essential for spot nodes'
    });
  }, /Story must have a claimId/);
});

suite.test('StarRStoryBank enforces deterministic claim binding, employer integrity, and metric consistency', assert => {
  const dossier = {
    claims: [
      {
        id: 'CLM-101',
        employerId: 'ORG_ACME',
        metrics: ['45% latency reduction', '100k rps'],
        status: 'VERIFIED'
      },
      {
        id: 'CLM-102',
        employerId: 'ORG_NEXUS',
        metrics: ['$500k savings'],
        status: 'CONFIRM'
      }
    ]
  };

  const bank = new StarRStoryBank(dossier);

  // Valid story matching claim
  const validStory = bank.validateStory({
    claimId: 'CLM-101',
    employerId: 'ORG_ACME',
    situation: 'API gateway suffered under surge traffic',
    task: 'Optimize throughput and latency',
    action: 'Implemented Redis cluster caching and request batching',
    result: 'Achieved 45% latency reduction and supported 100k rps',
    reflection: 'Cache invalidation policies must be designed before deployment',
    metrics: ['45% latency reduction']
  });
  assert.equal(validStory.confirmed, true);
  assert.equal(validStory.status, 'CONFIRMED');

  // Error: Unbound claim
  assert.throws(() => {
    bank.validateStory({
      claimId: 'CLM-999',
      situation: 'Database contention during peak hours',
      task: 'Shard database partitions',
      action: 'Partitioned by tenant ID',
      result: 'Eliminated deadlocks',
      reflection: 'Consistent hashing maintains balanced distribution'
    });
  }, /UNBOUND_STORY_CLAIM_ERROR/);

  // Error: Employer mismatch
  assert.throws(() => {
    bank.validateStory({
      claimId: 'CLM-101',
      employerId: 'ORG_OTHER',
      situation: 'System migration challenge',
      task: 'Execute zero downtime cutover',
      action: 'Used dual-write strategy',
      result: 'Zero downtime achieved',
      reflection: 'Dual-write requires strict synchronization verification'
    });
  }, /EMPLOYER_MISMATCH_ERROR/);

  // Error: Unbound metric hallucination
  assert.throws(() => {
    bank.validateStory({
      claimId: 'CLM-101',
      employerId: 'ORG_ACME',
      situation: 'Query performance degradation',
      task: 'Tune index strategies',
      action: 'Added composite b-tree indexes',
      result: 'Reduced database bill by 99% overnight',
      reflection: 'Index overhead must be weighed against read gains',
      metrics: ['99% cost reduction']
    });
  }, /UNBOUND_STORY_METRIC_ERROR/);
});

suite.test('StarRStoryBank gates stories with unconfirmed claims as DRAFT_PENDING_CONFIRMATION', assert => {
  const dossier = {
    claims: [
      {
        id: 'CLM-UNCONFIRMED',
        employerId: 'ORG_ENTERPRISE',
        metrics: ['20% improvement'],
        status: 'CONFIRM'
      }
    ]
  };

  const bank = new StarRStoryBank(dossier);
  const story = bank.addStory({
    id: 'story_gated',
    claimId: 'CLM-UNCONFIRMED',
    employerId: 'ORG_ENTERPRISE',
    situation: 'Deployment bottlenecks slowed sprint velocity',
    task: 'Streamline CI/CD pipeline',
    action: 'Implemented parallelized test stages',
    result: 'Achieved 20% improvement in deployment turnaround',
    reflection: 'Flaky tests erode team confidence if not quarantined immediately'
  });

  assert.equal(story.status, 'DRAFT_PENDING_CONFIRMATION');
  assert.equal(story.confirmed, false);

  // Confirmed query should exclude gated stories
  const activeStories = bank.getStoriesForRole({});
  assert.equal(activeStories.length, 0, 'Unconfirmed stories must not be included in active role prep');
});

suite.test('StarRStoryBank compiles structured interview-pack.md preparation guide', assert => {
  const dossier = {
    claims: [
      {
        id: 'CLM-ARCH-1',
        employerId: 'CORP_ONE',
        metrics: ['99.99% uptime'],
        status: 'VERIFIED'
      }
    ]
  };

  const bank = new StarRStoryBank(dossier);
  bank.addStory({
    id: 'story_arch_1',
    title: 'Multi-Region Failover Architecture',
    claimId: 'CLM-ARCH-1',
    employerId: 'CORP_ONE',
    situation: 'Single cloud region failure caused outage',
    task: 'Design active-active multi-region failover',
    action: 'Implemented global traffic management with health check failover',
    result: 'Delivered 99.99% uptime through 3 simulated region drops',
    reflection: 'Data replication lag across regions must be planned for eventual consistency'
  });

  const pack = bank.generateInterviewPack({
    company: 'Alpha Cloud Ltd',
    title: 'Lead Infrastructure Engineer'
  });

  assert.equal(pack.company, 'Alpha Cloud Ltd');
  assert.equal(pack.role, 'Lead Infrastructure Engineer');
  assert.equal(pack.storiesCount, 1);
  assert.ok(pack.markdown.includes('# Interview Preparation Pack: Lead Infrastructure Engineer @ Alpha Cloud Ltd'));
  assert.ok(pack.markdown.includes('### Story 1: Multi-Region Failover Architecture (Claim: `[CLM-ARCH-1]`)'));
  assert.ok(pack.markdown.includes('Reverse-Interview Questions'));
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
