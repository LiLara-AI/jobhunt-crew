'use strict';

/**
 * JobHunt Crew — CLI Crew Operations Commands
 *
 * MCP-parity verbs over existing engine modules: apply-pack generation,
 * blind review evaluation, outreach drafting (draft-only, never sent),
 * interview story packs, KSA offer maths, and follow-up cadence.
 * All state stays in local files under the workspace.
 *
 * @module lib/cli/commands/crew-ops
 */

const fs = require('fs');
const path = require('path');
const { ApplyPackGenerator } = require('../../honest-cv/apply-pack');
const { BlindReviewPanel } = require('../../honest-cv/review-panel');
const { OutreachGenerator } = require('../../crew/outreach');
const { StarRStoryBank } = require('../../crew/interview-story-bank');
const { KsaOfferCalculator } = require('../../crew/ksa-offer');
const { CadenceEngine } = require('../../crew/cadence');
const { parseArgs, resolveWorkspace } = require('../shared');
const { runLedger } = require('./ledger');

function loadJsonIfExists(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function loadDossier(targetDir, flags) {
  // Relative to the workspace, not the cwd; .crew/dossier.json first (legacy migration target), as the MCP server does.
  if (flags.dossier) return JSON.parse(fs.readFileSync(path.resolve(targetDir, String(flags.dossier)), 'utf8'));
  return loadJsonIfExists(path.join(targetDir, '.crew', 'dossier.json')) || loadJsonIfExists(path.join(targetDir, 'dossier.json')) || {};
}

function loadSnapshot(targetDir) {
  return loadJsonIfExists(path.join(targetDir, '.crew', 'snapshot.json')) || { jobs: {}, applications: {} };
}

function resolveJob(targetDir, flags) {
  const jobId = flags.jobId || flags['job-id'] || flags.id || flags.i;
  if (jobId) {
    const snapshot = loadSnapshot(targetDir);
    const job = snapshot.jobs ? snapshot.jobs[jobId] : null;
    if (!job) throw new Error(`Job not found in snapshot: ${jobId}`);
    return job;
  }
  if (flags.company || flags.title || flags.role) {
    return {
      id: 'job_target',
      company: flags.company || 'Target Enterprise',
      title: flags.title || flags.role || 'Target Role',
      url: flags.url || ''
    };
  }
  return null;
}

function readTextArg(value, baseDir = process.cwd()) {
  if (typeof value === 'string' && value.length < 4096 && fs.existsSync(path.resolve(baseDir, value))) {
    return fs.readFileSync(path.resolve(baseDir, value), 'utf8');
  }
  return value;
}

async function runApplyPack(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  let job;
  let dossier;
  try {
    job = resolveJob(targetDir, flags);
    dossier = loadDossier(targetDir, flags);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return 1;
  }
  if (!job) {
    console.error('[ERROR] Missing job selector: --job-id <id> or --company <c> --title <t>');
    return 1;
  }
  try {
    const screeningAnswers = ApplyPackGenerator.generateScreeningAnswers(dossier, job);
    const preFillPlan = ApplyPackGenerator.buildPreFillPlan(job, dossier);
    const snapshot = loadSnapshot(targetDir);
    const recorded = ApplyPackGenerator.checksFromApplication(snapshot.applications ? snapshot.applications[job.id] : null);
    const written = ApplyPackGenerator.writeApplyPack(targetDir, job.company, job.title, {
      jobUrl: job.canonicalUrl || job.url || '',
      matchScore: typeof job.score === 'number' ? job.score : undefined,
      reviewVerdict: recorded.reviewVerdict,
      verification: recorded.verification,
      screeningAnswers,
      preFillPlan
    });
    if (flags.json) {
      console.log(JSON.stringify({ ...written, safetyGate: preFillPlan.safetyGate }, null, 2));
    } else {
      console.log(`[APPLY-PACK] Written: ${written.filePath}`);
      console.log(`  Safety gate: ${preFillPlan.safetyGate.status} (human clicks final Submit)`);
    }
    return 0;
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return 1;
  }
}

async function runBlindReview(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const jdArg = flags.jd || flags.jobDescription || flags['job-description'];
  const draftArg = flags.draft || flags.document;
  if (!jdArg || !draftArg) {
    console.error('[ERROR] Missing required input: --jd <path|text> --draft <path|text> [--dossier <path>] [--job-id <id> --record]');
    return 1;
  }
  let dossier;
  try {
    if (flags.dossier) dossier = loadDossier(targetDir, flags);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return 1;
  }
  let result;
  try {
    result = BlindReviewPanel.evaluate({ requirementsText: readTextArg(jdArg, targetDir) }, { type: 'cv', content: readTextArg(draftArg, targetDir) }, { dossier });
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  const jobId = flags.jobId || flags['job-id'] || flags.id;
  if (flags.record === true && jobId) {
    const payload = {
      jobId,
      verdict: result.verdict,
      score: result.overallScore,
      notes: 'Blind review via crew blind-review',
      reviewedAt: new Date().toISOString()
    };
    return await runLedger('append', [
      '--event', 'BLIND_REVIEW_RECORDED',
      '--payload', JSON.stringify(payload),
      '--actor', 'agent:critic',
      '--workspace', targetDir
    ]);
  }
  return result.verdict === 'APPROVE' ? 0 : 0;
}

async function runOutreach(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  let job;
  let dossier;
  try {
    job = resolveJob(targetDir, flags) || { company: 'your team', title: 'the open role' };
    dossier = loadDossier(targetDir, flags);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return 1;
  }
  const draft = OutreachGenerator.generateOutreach({
    persona: flags.persona || 'RECRUITER',
    jobRecord: job,
    dossier,
    claimId: flags.claimId || flags['claim-id']
  });
  if (flags.json) {
    console.log(JSON.stringify(draft, null, 2));
  } else {
    console.log(`[OUTREACH] Draft only (never auto-sent), ${draft.charCount}/300 chars, persona ${draft.persona}:`);
    console.log(draft.message);
  }
  const jobId = flags.jobId || flags['job-id'] || flags.id;
  if (flags.record === true && jobId) {
    const payload = {
      jobId,
      persona: draft.persona,
      text: draft.message,
      channel: flags.channel || 'linkedin'
    };
    return await runLedger('append', [
      '--event', 'OUTREACH_DRAFTED',
      '--payload', JSON.stringify(payload),
      '--actor', 'agent:liaison',
      '--workspace', targetDir
    ]);
  }
  return 0;
}

async function runInterviewStory(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  let job;
  let dossier;
  try {
    job = resolveJob(targetDir, flags) || {};
    dossier = loadDossier(targetDir, flags);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return 1;
  }
  try {
    const bank = new StarRStoryBank(dossier);
    const selected = flags.storyIds
      ? String(flags.storyIds).split(',').map(s => s.trim()).filter(Boolean)
      : null;
    const pack = bank.generateInterviewPack(job, selected);
    if (flags.out) {
      const outFile = path.resolve(flags.out);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, pack.markdown, 'utf8');
      console.log(`[INTERVIEW-STORY] Pack written to: ${outFile} (${pack.storiesCount} stories)`);
    } else if (flags.json) {
      console.log(JSON.stringify(pack, null, 2));
    } else {
      console.log(pack.markdown);
    }
    return 0;
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return 1;
  }
}

async function runKsaOffer(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const grossRaw = flags.gross !== undefined ? flags.gross : flags.amount;
  const hasSplit = flags.basic !== undefined || flags.housing !== undefined ||
    flags.transport !== undefined || flags.transportation !== undefined;
  if (grossRaw === undefined && !hasSplit) {
    console.error('[ERROR] Missing required input: --gross <monthly SAR> (or --basic/--housing/--transport split) [--tenure <years>] [--saudi]');
    return 1;
  }
  const gross = grossRaw !== undefined ? Number(grossRaw) : 0;
  if (grossRaw !== undefined && (isNaN(gross) || gross < 0)) {
    console.error('[ERROR] --gross must be a non-negative number');
    return 1;
  }
  try {
    const split = {};
    if (flags.basic !== undefined) split.basic = Number(flags.basic);
    if (flags.housing !== undefined) split.housing = Number(flags.housing);
    if (flags.transport !== undefined) split.transport = Number(flags.transport);
    if (flags.transportation !== undefined) split.transport = Number(flags.transportation);
    const structure = KsaOfferCalculator.calculateSalaryStructure(gross, { split });
    const basic = Number(structure.basic || 0);
    const housing = Number(structure.housing || 0);
    const transport = Number(structure.transport || structure.transportation || 0);
    const isSaudi = flags.saudi === true || flags.national === true;
    const report = { salaryStructure: structure };
    try {
      report.gosi = KsaOfferCalculator.calculateGosi(basic + housing, isSaudi);
    } catch (_) {}
    if (flags.tenure !== undefined) {
      const years = Number(flags.tenure);
      report.eosb = KsaOfferCalculator.calculateEosb(
        { basic, housing, transport },
        years,
        flags.separation || 'TERMINATION'
      );
    }
    try {
      report.evaluation = KsaOfferCalculator.evaluateOffer({
        totalSalary: gross || undefined,
        basic,
        housing,
        transport,
        isSaudiNational: isSaudi,
        probationDays: flags.probation !== undefined ? Number(flags.probation) : undefined,
        nonCompeteMonths: flags['non-compete'] !== undefined ? Number(flags['non-compete']) : undefined,
        nonCompeteScope: flags['non-compete-scope'],
        qiwaNoticeDate: flags['qiwa-notice'],
        title: flags.title
      });
    } catch (_) {}
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return 1;
  }
}

async function runCadence(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  try {
    if (flags.submitted) {
      const result = CadenceEngine.calculateCadence(flags.submitted, new Date(), {
        day7FollowUpSent: flags.day7Sent === true,
        day14FollowUpSent: flags.day14Sent === true
      });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    const snapshot = loadSnapshot(targetDir);
    const apps = Object.entries(snapshot.applications || {}).map(([id, app]) => {
      const job = snapshot.jobs ? snapshot.jobs[id] : null;
      return {
        ...app,
        id,
        company: app.company || (job && job.company),
        title: app.title || (job && job.title),
        submittedAt: app.submittedAt || (job && job.submittedAt)
      };
    });
    const results = CadenceEngine.evaluateApplications(apps, new Date());
    if (flags.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(`[CADENCE] ${results.length} submitted application(s):`);
      for (const r of results) {
        console.log(`  - ${r.jobId} ${r.title || ''} @ ${r.company || ''}: ${r.nextAction} (day ${r.daysSinceSubmission})`);
      }
    }
    return 0;
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return 1;
  }
}

module.exports = {
  runApplyPack,
  runBlindReview,
  runOutreach,
  runInterviewStory,
  runKsaOffer,
  runCadence
};
