'use strict';
/**
 * Tier 1: Feature Coverage - Agent Crew Topology & Work-State Dispatching
 * Verifies 7 agent definitions, optimal model routing, Antigravity sidecar schema,
 * and state-driven (non-timer) agent chaining.
 */

const { TestSuite } = require('../helpers/test-harness');

const CREW_TOPOLOGY = {
  dispatcher: { name: 'Dispatcher', model: 'flash', role: 'Work-state inspection and queue-driven waking' },
  recon:      { name: 'Recon',      model: 'flash', role: '4-channel job discovery, dedup, and multi-dimensional scoring' },
  scribe:     { name: 'Scribe',     model: 'pro',   role: 'Claim-grounded CV & cover-letter drafting, multi-vacancy synthesis' },
  inquisitor: { name: 'Inquisitor', model: 'pro',   role: 'Claim verification, [CONFIRM] gating, JD keyword benchmark' },
  critic:     { name: 'Critic',     model: 'pro',   role: 'Candidate-isolated blind Recruiter + Hiring Manager review panel' },
  liaison:    { name: 'Liaison',    model: 'flash', role: 'Inbound email signals, 7/14-day follow-up cadences, outreach drafting, daily briefing' },
  navigator:  { name: 'Navigator',  model: 'flash', role: 'Attended browser sessions, login health, ready-to-save profile synchronization' }
};

class DispatchController {
  static evaluateWakeNeeds(snapshot) {
    const wakeQueue = [];

    // If discovered jobs need triage -> wake Recon
    const untriagedJobs = Object.values(snapshot.jobs || {}).filter(j => j.status === 'discovered');
    if (untriagedJobs.length > 0) {
      wakeQueue.push({ agent: 'recon', reason: `${untriagedJobs.length} untriaged jobs discovered` });
    }

    // If shortlisted jobs need drafting -> wake Scribe
    const selectedJobs = Object.values(snapshot.jobs || {}).filter(j => j.status === 'selected_for_apply');
    if (selectedJobs.length > 0) {
      wakeQueue.push({ agent: 'scribe', reason: `${selectedJobs.length} jobs ready for CV/CL draft` });
    }

    // If drafts need claim verification -> wake Inquisitor
    const unverifiedDrafts = Object.values(snapshot.drafts || {}).filter(d => d.verified !== true);
    if (unverifiedDrafts.length > 0) {
      wakeQueue.push({ agent: 'inquisitor', reason: `${unverifiedDrafts.length} drafts awaiting claim verification` });
    }

    // If verified drafts need blind review -> wake Critic
    const pendingReviews = Object.values(snapshot.drafts || {}).filter(d => d.verified === true && !d.reviewed);
    if (pendingReviews.length > 0) {
      wakeQueue.push({ agent: 'critic', reason: `${pendingReviews.length} drafts ready for blind review` });
    }

    return wakeQueue;
  }

  static validateSidecarDefinition(sidecar) {
    if (sidecar.builtin !== 'schedule') {
      throw new Error('Sidecar must specify "builtin": "schedule"');
    }
    if (!sidecar.cron || !sidecar.cron.includes('CRON_TZ=')) {
      throw new Error('Sidecar cron must specify timezone via CRON_TZ=');
    }
    if (!sidecar.command || !Array.isArray(sidecar.command)) {
      throw new Error('Sidecar command must be an array of arguments');
    }
    const cmdStr = sidecar.command.join(' ');
    if (!cmdStr.includes('agentapi') || !cmdStr.includes('new-conversation')) {
      throw new Error('Sidecar command must invoke agentapi new-conversation');
    }
    if (!sidecar.agent_permissions || !Array.isArray(sidecar.agent_permissions.workspace_uris)) {
      throw new Error('Sidecar must define scoped agent_permissions.workspace_uris');
    }
    return true;
  }
}

const suite = new TestSuite('Tier 1: Agent Crew Topology & Dispatching');

suite.test('7-agent crew defines valid model routing (flash for bulk, pro for reasoning)', assert => {
  const agents = Object.keys(CREW_TOPOLOGY);
  assert.equal(agents.length, 7);

  // High-throughput tasks mapped to Flash
  assert.equal(CREW_TOPOLOGY.dispatcher.model, 'flash');
  assert.equal(CREW_TOPOLOGY.recon.model, 'flash');
  assert.equal(CREW_TOPOLOGY.liaison.model, 'flash');
  assert.equal(CREW_TOPOLOGY.navigator.model, 'flash');

  // Complex reasoning, honest writing & adversarial review mapped to Pro
  assert.equal(CREW_TOPOLOGY.scribe.model, 'pro');
  assert.equal(CREW_TOPOLOGY.inquisitor.model, 'pro');
  assert.equal(CREW_TOPOLOGY.critic.model, 'pro');
});

suite.test('Dispatcher wakes agents exclusively on work state rather than timer intervals', assert => {
  const emptySnapshot = { jobs: {}, drafts: {} };
  const noWake = DispatchController.evaluateWakeNeeds(emptySnapshot);
  assert.equal(noWake.length, 0, 'No agents should be woken when work queues are empty');

  const busySnapshot = {
    jobs: {
      'j1': { status: 'discovered' },
      'j2': { status: 'selected_for_apply' }
    },
    drafts: {
      'd1': { verified: false }
    }
  };
  const wakes = DispatchController.evaluateWakeNeeds(busySnapshot);
  assert.equal(wakes.length, 3);
  assert.ok(wakes.some(w => w.agent === 'recon'));
  assert.ok(wakes.some(w => w.agent === 'scribe'));
  assert.ok(wakes.some(w => w.agent === 'inquisitor'));
});

suite.test('Antigravity Scheduled Task sidecar definitions comply with JSON specification', assert => {
  const validSidecar = {
    builtin: 'schedule',
    cron: 'CRON_TZ=Asia/Riyadh 0 8 * * *',
    command: ['agentapi', 'new-conversation', '--', 'Run crew dispatcher for morning triage'],
    restart_policy: 'always',
    display_name: 'Crew Morning Dispatcher',
    agent_permissions: {
      workspace_uris: ['c:/Users/example/jobhunt-crew']
    }
  };

  assert.ok(DispatchController.validateSidecarDefinition(validSidecar));

  assert.throws(
    () => DispatchController.validateSidecarDefinition({ builtin: 'wrong' }),
    /builtin/
  );
  assert.throws(
    () => DispatchController.validateSidecarDefinition({ builtin: 'schedule', cron: '0 8 * * *' }),
    /CRON_TZ/
  );
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
