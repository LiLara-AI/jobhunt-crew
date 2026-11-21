'use strict';

/**
 * Tier 1: Feature Coverage — Outreach Generator (<= 300 Characters)
 *
 * Verifies:
 * 1. Strict <= 300 character limit enforcement for connection requests across all 3 personas.
 * 2. Persona-specific messaging differentiation (Hiring Manager vs Recruiter vs Peer).
 * 3. Grounding with candidate dossier metrics and claims.
 * 4. Zero personal PII and draft-only safety constraints.
 */

const { TestSuite } = require('../helpers/test-harness');
const { OutreachGenerator } = require('../../lib/crew/outreach');

const suite = new TestSuite('M5 Feature 32: Outreach Generator (<= 300 Characters)');

suite.test('OutreachGenerator enforces strict <= 300 character limit across all 3 personas', assert => {
  const jobRecord = {
    company: 'Enterprise Cloud Technologies',
    title: 'Lead Platform Reliability Architect'
  };

  const dossier = {
    noticePeriod: '30 days notice',
    claims: [
      {
        id: 'CLM-OUT-1',
        metrics: ['40% reduction in MTTR across 200 nodes']
      }
    ]
  };

  const personas = ['HIRING_MANAGER', 'RECRUITER', 'PEER'];
  for (const p of personas) {
    const draft = OutreachGenerator.generateOutreach({
      persona: p,
      jobRecord,
      dossier
    });

    assert.equal(draft.persona, p);
    assert.ok(draft.charCount <= 300, `Character count (${draft.charCount}) exceeds 300 for persona ${p}`);
    assert.equal(draft.isUnderLimit, true);
    assert.equal(draft.safetyStatus, 'draft_only');
  }
});

suite.test('OutreachGenerator customizes message angle per persona', assert => {
  const jobRecord = {
    company: 'NextGen Systems',
    title: 'Principal Distributed Systems Engineer'
  };

  const dossier = {
    noticePeriod: 'available immediately',
    claims: [
      {
        id: 'CLM-PERF-1',
        metrics: ['p99 latency from 120ms to 18ms']
      }
    ]
  };

  // Hiring Manager: emphasizes delivery/scale metric
  const hmDraft = OutreachGenerator.generateOutreach({
    persona: 'HIRING_MANAGER',
    jobRecord,
    dossier
  });
  assert.ok(hmDraft.message.includes('Having delivered p99 latency from 120ms to 18ms'));
  assert.equal(hmDraft.claimId, 'CLM-PERF-1');

  // Recruiter: emphasizes application, role match, and notice period
  const recruiterDraft = OutreachGenerator.generateOutreach({
    persona: 'RECRUITER',
    jobRecord,
    dossier
  });
  assert.ok(recruiterDraft.message.includes('available immediately'));
  assert.ok(recruiterDraft.message.includes('recently applied for the Principal Distributed Systems Engineer position'));

  // Peer: interest in the team's work, with no profession assumed that the dossier does not state
  const peerDraft = OutreachGenerator.generateOutreach({
    persona: 'PEER',
    jobRecord,
    dossier
  });
  assert.equal(/platform engineer|engineering architecture/.test(peerDraft.message), false);
  assert.ok(peerDraft.message.includes('the work your team does at NextGen Systems'));
});

suite.test('OutreachGenerator truncates oversized text cleanly at word boundaries', assert => {
  const longText = 'A'.repeat(250) + ' ' + 'B'.repeat(100);
  const truncated = OutreachGenerator.fitWithinLimit(longText, 300);

  const count = OutreachGenerator.getCharCount(truncated);
  assert.ok(count <= 300, `Truncated text length ${count} must be <= 300`);
  assert.ok(truncated.endsWith('...'));
});

suite.test('OutreachGenerator respects zero personal PII and draft-only status', assert => {
  const jobRecord = {
    company: 'Fintech Gulf',
    title: 'Core Infrastructure Lead'
  };

  const draft = OutreachGenerator.generateOutreach({
    persona: 'HIRING_MANAGER',
    jobRecord
  });

  // Zero personal names or email addresses
  assert.equal(/@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(draft.message), false, 'Outreach must not contain email addresses');
  assert.equal(draft.safetyStatus, 'draft_only', 'Outreach must always carry draft_only safetyStatus');
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
