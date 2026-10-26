'use strict';
/**
 * Tier 3: Cross-Feature Interactions - Discovery to Triage Pipeline
 * Verifies multi-channel ingestion, canonical deduplication, 5-dimension preference scoring,
 * and state progression in the real ledger using production modules.
 */

const fs = require('fs');
const path = require('path');
const { TestSuite } = require('../helpers/test-harness');
const { EventLedger } = require('../../lib/ledger/ledger');
const { reduceEvents } = require('../../lib/ledger/reducer');
const { normalizeJobUrl, checkDuplicateRequisition, generateRequisitionKey } = require('../../lib/guardrails/dedup');
const { JobScorer } = require('../../lib/discovery/job-scorer');

class DiscoveryTriagePipeline {
  constructor(options = {}) {
    this.tempDir = path.join(__dirname, '..', 'fixtures', `.temp_triage_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
    this.ledgerPath = path.join(this.tempDir, 'ledger.jsonl');
    this.ledger = new EventLedger({ ledgerPath: this.ledgerPath });
  }

  async cleanup() {
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch (_) {}
  }

  async ingestDiscovery(rawJob) {
    const cleanUrl = normalizeJobUrl(rawJob.url);
    const existingEvents = this.ledger.readEvents();
    const state = reduceEvents(existingEvents);
    const existingJobs = Object.values(state.jobs || {});

    const reqKey = generateRequisitionKey(rawJob.company, rawJob.title, cleanUrl, {
      location: rawJob.location,
      requisitionId: rawJob.requisitionId
    });
    const jobId = `job_${reqKey.slice(0, 10)}`;

    const candidateJob = {
      id: jobId,
      title: rawJob.title,
      company: rawJob.company,
      location: rawJob.location,
      url: cleanUrl,
      rawUrl: rawJob.url,
      channel: rawJob.channel || 'unknown',
      requisitionId: rawJob.requisitionId || '',
      requisitionKey: reqKey
    };

    const dupCheck = checkDuplicateRequisition(existingJobs, candidateJob, { throwOnError: false });
    if (dupCheck.isDuplicate) {
      return {
        ingested: false,
        duplicateOf: dupCheck.matchedJob ? dupCheck.matchedJob.id : null,
        reason: dupCheck.reason
      };
    }

    const event = await this.ledger.appendEvent({
      event: 'JOB_DISCOVERED',
      payload: candidateJob,
      actor: 'agent:recon'
    });

    return {
      ingested: true,
      job: event.payload
    };
  }

  async triageJob(jobId, candidatePreferences = {}) {
    const events = this.ledger.readEvents();
    const state = reduceEvents(events);
    const job = state.jobs ? state.jobs[jobId] : null;

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const evalResult = JobScorer.scoreVacancy(job, candidatePreferences);
    const payload = {
      id: jobId,
      score: evalResult.score,
      verdict: evalResult.verdict,
      status: evalResult.status,
      shortlisted: evalResult.shortlisted,
      dimensions: evalResult.dimensions,
      closingSoon: evalResult.closingSoon,
      ageBadge: evalResult.ageBadge
    };

    await this.ledger.appendEvent({
      event: 'JOB_TRIAGED',
      payload,
      actor: 'agent:recon'
    });

    return payload;
  }
}

const suite = new TestSuite('Tier 3: Discovery to Triage Pipeline');

let pipeline;

suite.test('Initialize Discovery to Triage Pipeline with real event ledger', async assert => {
  pipeline = new DiscoveryTriagePipeline();
  assert.ok(pipeline.ledger);
});

suite.test('Multi-channel discovery collapses duplicates and triages qualifying roles', async assert => {
  const preferences = {
    targetTitles: ['Platform Architect', 'Staff Infrastructure Engineer'],
    targetCities: ['Riyadh', 'NEOM'],
    companyWatchlist: ['Apex Cloud Technologies', 'NEOM', 'ROSHN'],
    candidateStatus: 'Transferable Iqama'
  };

  // 1. Ingest job from LinkedIn
  const r1 = await pipeline.ingestDiscovery({
    title: 'Principal Platform Architect',
    company: 'Apex Cloud Technologies',
    location: 'Riyadh, Saudi Arabia',
    url: 'https://apex.com/jobs/42?utm_source=linkedin',
    channel: 'linkedin'
  });
  assert.equal(r1.ingested, true);
  assert.ok(r1.job.id.startsWith('job_'));

  // 2. Same job discovered via direct ATS sweep with different query params
  const r2 = await pipeline.ingestDiscovery({
    title: 'Principal Platform Architect',
    company: 'Apex Cloud Technologies',
    location: 'Riyadh, Saudi Arabia',
    url: 'https://apex.com/jobs/42?source=greenhouse',
    channel: 'greenhouse'
  });
  assert.equal(r2.ingested, false);
  assert.equal(r2.duplicateOf, r1.job.id);

  // 3. Triage job using real 5-dimension preference rubric
  const triage = await pipeline.triageJob(r1.job.id, preferences);
  assert.ok(triage.score >= 3.5, `Expected score >= 3.5, got ${triage.score}`);
  assert.equal(triage.verdict, 'PASS');
  assert.equal(triage.shortlisted, true);

  // 4. Verify immutable event ledger progression
  const events = pipeline.ledger.readEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'JOB_DISCOVERED');
  assert.equal(events[1].type, 'JOB_TRIAGED');
});

suite.test('Cleanup temporary ledger workspace', async assert => {
  if (pipeline) {
    await pipeline.cleanup();
  }
  assert.ok(true);
});

module.exports = suite;
if (require.main === module) {
  suite.run({ verbose: true });
}
