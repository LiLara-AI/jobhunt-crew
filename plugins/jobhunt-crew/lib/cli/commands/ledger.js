'use strict';

/**
 * JobHunt Crew — CLI Ledger Commands
 * @module lib/cli/commands/ledger
 */

const fs = require('fs');
const path = require('path');
const { EventLedger } = require('../../ledger/ledger');
const { replayLedger } = require('../../ledger/reducer');
const { GuardrailEngine } = require('../../guardrails/engine');
const { parseArgs, resolveWorkspace } = require('../shared');

async function runLedger(subcommand, rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const crewDir = path.join(targetDir, '.crew');
  const ledgerPath = path.join(crewDir, 'ledger.jsonl');
  const snapshotPath = path.join(crewDir, 'snapshot.json');
  const lockPath = path.join(crewDir, 'ledger.lock');

  const ledger = new EventLedger({
    workspaceDir: targetDir,
    ledgerPath,
    lockPath
  });

  if (subcommand === 'append') {
    const eventType = flags.event || flags.e;
    const rawPayload = flags.payload || flags.p;
    const actor = flags.actor || flags.a || 'agent:cli';

    if (!eventType) {
      console.error('[ERROR] Missing required flag: --event <type>');
      return 1;
    }
    if (!rawPayload) {
      console.error('[ERROR] Missing required flag: --payload <json>');
      return 1;
    }

    let payload;
    try {
      if (typeof rawPayload === 'string' && fs.existsSync(rawPayload)) {
        payload = JSON.parse(fs.readFileSync(rawPayload, 'utf8'));
      } else {
        payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
      }
    } catch (err) {
      console.error(`[ERROR] Invalid JSON payload: ${err.message}`);
      return 1;
    }

    // Guardrail Check: Human Submission & Readiness Gate
    if (eventType === 'APPLICATION_SUBMITTED' || eventType === 'JOB_SUBMITTED' || payload.status === 'submitted') {
      const jobId = payload.jobId || payload.id;
      try {
        GuardrailEngine.validateSubmission(actor, jobId, payload.token);
      } catch (err) {
        console.error(err.message);
        return 1;
      }

      const snapshotPath = path.join(crewDir, 'snapshot.json');
      let snapshot = { jobs: {}, applications: {} };
      if (fs.existsSync(snapshotPath)) {
        try {
          snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        } catch (_) {}
      }
      const job = snapshot.jobs ? snapshot.jobs[jobId] : null;
      const app = snapshot.applications ? snapshot.applications[jobId] : null;
      const isReady = (job && job.status === 'ready') || (app && app.status === 'ready');
      const isVerifiedAndApproved = (app && app.verification && app.verification.passed === true &&
                                     app.review && app.review.verdict === 'APPROVE');

      if (!isReady && !isVerifiedAndApproved) {
        console.error('GUARDRAIL_VIOLATION: Cannot submit unverified application. Application must pass claim verification and review panel before submission.');
        return 1;
      }
    }

    // Guardrail Check: Readiness Gate
    if (eventType === 'PACKAGE_MARKED_READY') {
      if (!payload.claimVerification || payload.claimVerification.passed !== true) {
        console.error('GUARDRAIL_VIOLATION: Package cannot be marked ready without passing claim verification');
        return 1;
      }
      if (payload.claimVerification.violations && payload.claimVerification.violations.length > 0) {
        console.error('GUARDRAIL_VIOLATION: Package cannot be marked ready with unresolved claim violations');
        return 1;
      }
      if (!payload.reviewPanel || payload.reviewPanel.verdict !== 'APPROVE') {
        console.error('GUARDRAIL_VIOLATION: Package cannot be marked ready without review panel approval');
        return 1;
      }
    }

    // Guardrail Check: Evidence-Based Closure
    if (eventType === 'JOB_CLOSED') {
      try {
        const evidence = payload.evidence || { type: payload.evidenceType, proof: payload.proof };
        GuardrailEngine.validateClosure(evidence);
      } catch (err) {
        console.error(err.message);
        return 1;
      }
    }

    let appendedEvent;
    try {
      appendedEvent = await ledger.appendEvent({
        event: eventType,
        payload,
        actor
      });

      // Update materialized snapshot projection
      await replayLedger({
        workspaceDir: targetDir,
        ledgerPath,
        snapshotPath,
        rebuild: false
      });
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      return 1;
    }

    console.log(JSON.stringify(appendedEvent, null, 2));
    return 0;
  }

  if (subcommand === 'replay') {
    const shouldRebuild = flags.rebuild === true || flags.r === true;
    const integrity = ledger.verifyChainIntegrity();

    if (!integrity.valid) {
      console.error(`[REPLAY] FAILED: ${integrity.reason}`);
      return 1;
    }

    try {
      const state = await replayLedger({
        workspaceDir: targetDir,
        ledgerPath,
        snapshotPath,
        rebuild: shouldRebuild
      });

      if (shouldRebuild) {
        console.log(`[REPLAY] Replayed ${integrity.count} events. Cryptographic chain OK. Materialized snapshot rebuilt.`);
      } else {
        console.log(`[REPLAY] Replayed ${integrity.count} events. Cryptographic chain OK. Snapshot in sync.`);
      }
      return 0;
    } catch (err) {
      console.error(`[REPLAY] Error during replay: ${err.message}`);
      return 1;
    }
  }

  console.error(`[ERROR] Unknown ledger subcommand: ${subcommand}`);
  return 1;
}

module.exports = {
  runLedger
};
