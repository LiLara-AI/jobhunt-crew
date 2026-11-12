'use strict';

/**
 * JobHunt Crew — CLI Review Commands
 * @module lib/cli/commands/review
 */

const { parseArgs, resolveWorkspace } = require('../shared');
const { runLedger } = require('./ledger');

async function runReview(subcommand, rawArgs = []) {
  if (subcommand !== 'record') {
    console.error(`[ERROR] Unknown review subcommand: ${subcommand}. Usage: crew review record --job-id <id> --verdict <APPROVE|REQUEST_CHANGES> --notes <notes>`);
    return 1;
  }
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const jobId = flags.jobId || flags.job_id || flags.id || flags.i;
  const verdict = flags.verdict || flags.v;
  const notes = flags.notes || flags.n || '';
  const score = flags.score !== undefined ? parseFloat(flags.score) : 4.5;

  if (!jobId || !verdict || !notes) {
    console.error('[ERROR] Missing required flags: --job-id, --verdict, --notes');
    return 1;
  }

  const normalizedVerdict = verdict.toUpperCase();
  if (normalizedVerdict !== 'APPROVE' && normalizedVerdict !== 'REQUEST_CHANGES') {
    console.error(`[ERROR] Invalid verdict: "${verdict}". Must be "APPROVE" or "REQUEST_CHANGES".`);
    return 1;
  }

  const payload = {
    jobId,
    verdict: normalizedVerdict,
    score: isNaN(score) ? 4.5 : score,
    notes,
    reviewedAt: new Date().toISOString()
  };

  return await runLedger('append', [
    '--event', 'BLIND_REVIEW_RECORDED',
    '--payload', JSON.stringify(payload),
    '--actor', 'agent:critic',
    '--workspace', targetDir
  ]);
}

module.exports = {
  runReview
};
