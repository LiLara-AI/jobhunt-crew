'use strict';

/**
 * JobHunt Crew — CLI Job Commands
 * @module lib/cli/commands/job
 */

const fs = require('fs');
const path = require('path');
const { GuardrailEngine } = require('../../guardrails/engine');
const { normalizeJobUrl, checkDuplicateRequisition, generateRequisitionKey } = require('../../guardrails/dedup');
const { parseArgs, resolveWorkspace } = require('../shared');
const { runLedger } = require('./ledger');

function tryArchiveShortlisted(targetDir, job, evaluation) {
  try {
    if (!job || !evaluation || !evaluation.shortlisted) return null;
    const { DiscoveryEngine } = require('../../discovery');
    const engine = new DiscoveryEngine({ workspaceDir: targetDir });
    return engine.archiveShortlistedJd(job, evaluation, {});
  } catch (_) { return null; }
}

async function runJob(subcommand, rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const crewDir = path.join(targetDir, '.crew');
  const snapshotPath = path.join(crewDir, 'snapshot.json');

  if (subcommand === 'add') {
    const rawUrl = flags.url || flags.u;
    const title = flags.title || flags.t;
    const company = flags.company || flags.c;
    const location = flags.location || flags.l || '';
    const source = flags.source || flags.s || 'web';
    const requisitionId = flags.requisitionId || flags['requisition-id'] || flags.req || '';

    if (!rawUrl || !title || !company) {
      console.error('[ERROR] Missing required flags: --url, --title, --company');
      return 1;
    }

    const cleanUrl = normalizeJobUrl(rawUrl);
    const candidateJob = {
      title,
      company,
      url: cleanUrl,
      location,
      source,
      requisitionId
    };

    // Check duplicate against existing snapshot
    if (fs.existsSync(snapshotPath)) {
      try {
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        const existingJobs = Object.values(snapshot.jobs || {});
        const check = checkDuplicateRequisition(existingJobs, candidateJob, { throwOnError: false });
        if (check.isDuplicate) {
          console.log(`[JOB] ${check.message}`);
          return 0;
        }
        if (check.warning) {
          console.warn(`[WARN] ${check.message}`);
        }
      } catch (_) {}
    }

    const reqKey = generateRequisitionKey(company, title, cleanUrl, { location, requisitionId });
    const jobId = `job_${reqKey.slice(0, 10)}`;

    const payload = {
      id: jobId,
      title,
      company,
      location,
      source,
      url: cleanUrl,
      rawUrl,
      requisitionId,
      requisitionKey: reqKey
    };

    return await runLedger('append', [
      '--event', 'JOB_DISCOVERED',
      '--payload', JSON.stringify(payload),
      '--actor', 'agent:recon',
      '--workspace', targetDir
    ]);
  }

  if (subcommand === 'triage') {
    const isAll = flags.all === true;
    const id = flags.id || flags.i;
    const rawScore = flags.score;
    const status = flags.status;
    const rationale = flags.rationale || flags.r || '';

    // If --all: automatically score and triage all untriaged jobs
    if (isAll) {
      if (!fs.existsSync(snapshotPath)) {
        console.log('[TRIAGE] No snapshot found. Nothing to triage.');
        return 0;
      }
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      const jobs = Object.values(snapshot.jobs || {});
      const toTriage = jobs.filter(j => j.status === 'discovered'); // never re-triage closed/submitted jobs

      if (toTriage.length === 0) {
        console.log('[TRIAGE] No pending untriaged jobs found.');
        return 0;
      }

      let preferences = {};
      let skills = [];
      const dossierPath = path.join(targetDir, 'dossier.json');
      if (fs.existsSync(dossierPath)) {
        try {
          const dos = JSON.parse(fs.readFileSync(dossierPath, 'utf8'));
          preferences = dos.preferences || {};
          skills = (dos.skills && Array.isArray(dos.skills.keywords)) ? dos.skills.keywords : [];
        } catch (_) {}
      }

      const { JobScorer } = require('../../discovery/job-scorer');
      let triagedCount = 0;
      for (const job of toTriage) {
        const result = JobScorer.scoreVacancy(job, preferences, skills);
        const payload = {
          id: job.id,
          score: result.score,
          status: result.status,
          verdict: result.verdict,
          shortlisted: result.shortlisted,
          rationale: result.rationale || `5-dimension rubric score: ${result.score}`,
          dimensions: result.dimensions,
          closingSoon: result.closingSoon,
          ageBadge: result.ageBadge
        };

        const rcAll = await runLedger('append', [
          '--event', 'JOB_TRIAGED',
          '--payload', JSON.stringify(payload),
          '--actor', 'agent:recon',
          '--workspace', targetDir
        ]);
        if (rcAll === 0) tryArchiveShortlisted(targetDir, { ...job, description: job.description || flags.description }, result);
        triagedCount++;
      }

      console.log(`[TRIAGE] Automatically triaged ${triagedCount} job(s).`);
      return 0;
    }

    if (!id) {
      console.error('[ERROR] Missing required flags: --id <id> (or --all)');
      return 1;
    }

    // Manual score & status provided
    if (rawScore !== undefined && status) {
      const score = parseFloat(rawScore);
      if (isNaN(score) || score < 0.0 || score > 5.0) {
        console.error('[ERROR] Score must be a float between 0.0 and 5.0');
        return 1;
      }

      const payload = {
        id,
        score,
        status,
        verdict: status,
        shortlisted: status === 'PASS' || status === 'MARGINAL' || status === 'shortlisted',
        rationale
      };

      let snapJob = null;
      try {
        if (fs.existsSync(snapshotPath)) {
          const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
          snapJob = snap.jobs ? snap.jobs[id] : null;
        }
      } catch (_) {}
      const rcManual = await runLedger('append', [
        '--event', 'JOB_TRIAGED',
        '--payload', JSON.stringify(payload),
        '--actor', 'agent:recon',
        '--workspace', targetDir
      ]);
      if (rcManual === 0 && snapJob) {
        tryArchiveShortlisted(targetDir,
          { ...snapJob, title: snapJob.title || flags.title, company: snapJob.company || flags.company, description: snapJob.description || flags.description, url: snapJob.canonicalUrl || snapJob.url || flags.url },
          { shortlisted: payload.shortlisted, score, verdict: status });
      }
      return rcManual;
    }

    // Auto-triage single job from snapshot
    if (fs.existsSync(snapshotPath)) {
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      const job = snapshot.jobs ? snapshot.jobs[id] : null;
      if (!job) {
        console.error(`[ERROR] Job not found in snapshot: ${id}`);
        return 1;
      }

      let preferences = {};
      let skills = [];
      const dossierPath = path.join(targetDir, 'dossier.json');
      if (fs.existsSync(dossierPath)) {
        try {
          const dos = JSON.parse(fs.readFileSync(dossierPath, 'utf8'));
          preferences = dos.preferences || {};
          skills = (dos.skills && Array.isArray(dos.skills.keywords)) ? dos.skills.keywords : [];
        } catch (_) {}
      }

      const { JobScorer } = require('../../discovery/job-scorer');
      const result = JobScorer.scoreVacancy(job, preferences, skills);
      const payload = {
        id,
        score: result.score,
        status: result.status,
        verdict: result.verdict,
        shortlisted: result.shortlisted,
        rationale: rationale || `Auto-triaged score: ${result.score}`,
        dimensions: result.dimensions,
        closingSoon: result.closingSoon,
        ageBadge: result.ageBadge
      };

      const rcAuto = await runLedger('append', [
        '--event', 'JOB_TRIAGED',
        '--payload', JSON.stringify(payload),
        '--actor', 'agent:recon',
        '--workspace', targetDir
      ]);
      if (rcAuto === 0) tryArchiveShortlisted(targetDir, { ...job, description: job.description || flags.description }, result);
      return rcAuto;
    }

    console.error('[ERROR] Missing required flags: --id, --score, --status');
    return 1;
  }

  if (subcommand === 'inspect') {
    const id = flags.id || flags.i;
    const isJson = Boolean(flags.json);

    if (!id) {
      console.error('[ERROR] Missing required flag: --id <id>');
      return 1;
    }

    if (!fs.existsSync(snapshotPath)) {
      console.error('[ERROR] Materialized snapshot does not exist. Run "crew ledger replay --rebuild"');
      return 1;
    }

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const job = snapshot.jobs ? snapshot.jobs[id] : null;

    if (!job) {
      console.error(`[ERROR] Job not found in snapshot: ${id}`);
      return 1;
    }

    const application = snapshot.applications ? snapshot.applications[id] : null;

    if (isJson) {
      console.log(JSON.stringify({ job, application }, null, 2));
      return 0;
    }

    console.log('======================================================================');
    console.log(`JOB INSPECTION: ${job.id}`);
    console.log('======================================================================');
    console.log(`Title:         ${job.title}`);
    console.log(`Company:       ${job.company}`);
    console.log(`Location:      ${job.location || 'Unknown'}`);
    console.log(`Source:        ${job.channel || job.source || 'unknown'}`);
    console.log(`Canonical URL: ${job.canonicalUrl || job.url}`);
    console.log(`Requisition:   ${job.requisitionId || 'None'} (Key: ${job.requisitionKey ? job.requisitionKey.slice(0, 16) : 'N/A'})`);
    console.log(`Status:        ${(job.status || 'discovered').toUpperCase()} (Discovered: ${job.discoveredAt || job.updatedAt})`);
    console.log(`Age Invariant: Open · Posted ${job.postedAgeDays || 0}d ago [Zero Age Penalty: Fully Eligible]`);
    console.log('----------------------------------------------------------------------');
    console.log(`TRIAGE EVALUATION (Score: ${job.score !== null && job.score !== undefined ? job.score : 'Untriaged'} / 5.0)`);
    if (job.triageNotes) {
      console.log(`  - Notes: ${job.triageNotes}`);
    }
    console.log('----------------------------------------------------------------------');
    console.log('LIFECYCLE STATUS');
    console.log(`  - Application:    ${application ? application.status : 'None'}`);
    console.log(`  - Claims Gate:    ${application && application.verification ? (application.verification.passed ? 'PASSED' : 'FAILED') : 'Pending verification'}`);
    console.log(`  - Human Submit:   ${job.status === 'submitted' ? 'SUBMITTED' : 'Unsubmitted (Human authorization token required)'}`);
    console.log('======================================================================');
    return 0;
  }

  if (subcommand === 'close') {
    const id = flags.id || flags.i;
    const reason = flags.reason || flags.r;
    const evidenceType = flags.evidence || flags.e;
    const proof = flags.proof || flags.p;

    if (!id || !reason || !evidenceType) {
      console.error('[ERROR] Missing required flags: --id, --reason, --evidence, --proof');
      return 1;
    }

    try {
      GuardrailEngine.validateClosure({
        type: evidenceType,
        proof: proof || '',
        reason
      });
    } catch (err) {
      console.error(err.message);
      return 1;
    }

    if (!proof) {
      console.error('[ERROR] Missing required flags: --id, --reason, --evidence, --proof');
      return 1;
    }

    const payload = {
      id,
      reason,
      evidence: {
        type: evidenceType,
        proof
      }
    };

    return await runLedger('append', [
      '--event', 'JOB_CLOSED',
      '--payload', JSON.stringify(payload),
      '--actor', 'agent:recon',
      '--workspace', targetDir
    ]);
  }

  if (subcommand === 'submit') {
    const id = flags.id || flags.i;
    const token = flags.token || flags.t;
    const actor = flags.actor || flags.a || 'human';

    if (!id || !token) {
      console.error('[ERROR] Missing required flags: --id, --token');
      return 1;
    }

    try {
      GuardrailEngine.validateSubmission(actor, id, token);
    } catch (err) {
      console.error(err.message);
      return 1;
    }

    const crewDir = path.join(targetDir, '.crew');
    const snapshotPath = path.join(crewDir, 'snapshot.json');
    let snapshot = { jobs: {}, applications: {} };
    if (fs.existsSync(snapshotPath)) {
      try {
        snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      } catch (_) {}
    }
    const job = snapshot.jobs ? snapshot.jobs[id] : null;
    const app = snapshot.applications ? snapshot.applications[id] : null;
    const isReady = (job && job.status === 'ready') || (app && app.status === 'ready');
    const isVerifiedAndApproved = (app && app.verification && app.verification.passed === true &&
                                   app.review && app.review.verdict === 'APPROVE');

    if (!isReady && !isVerifiedAndApproved) {
      console.error('GUARDRAIL_VIOLATION: Cannot submit unverified application. Application must pass claim verification and review panel before submission.');
      return 1;
    }

    const payload = {
      id,
      jobId: id,
      token,
      confirmedByHuman: true
    };

    return await runLedger('append', [
      '--event', 'APPLICATION_SUBMITTED',
      '--payload', JSON.stringify(payload),
      '--actor', actor,
      '--workspace', targetDir
    ]);
  }

  console.error(`[ERROR] Unknown job subcommand: ${subcommand}`);
  return 1;
}

module.exports = {
  runJob
};
