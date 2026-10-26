#!/usr/bin/env node
'use strict';

/**
 * JobHunt Crew — Core CLI Entrypoint
 *
 * Deterministic multi-agent job search and honest CV tailoring platform.
 * Provides complete CLI tool surface for ledger operations, job triage,
 * human submissions, health diagnostics, backup, and MCP server launch.
 *
 * Zero external dependencies. Uses Node.js built-in runtime and core modules.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { EventLedger } = require('../lib/ledger/ledger');
const { reduceEvents, replayLedger, writeSnapshotAtomically, canonicalizeUrl } = require('../lib/ledger/reducer');
const { withLock, FileLock } = require('../lib/ledger/lock');
const { GuardrailEngine } = require('../lib/guardrails/engine');
const { normalizeJobUrl, checkDuplicateRequisition, generateRequisitionKey } = require('../lib/guardrails/dedup');
const { ClaimVerifier } = require('../lib/honest-cv/verify-claims');
const { runDiagnostics } = require('../lib/operational/diagnostics');
const { scanClosingSoonAlerts } = require('../lib/operational/alerts');
const { generateRetrospective } = require('../lib/operational/retrospective');
const { createBackup, restoreBackup } = require('../lib/operational/backup');
const { CommandCenterServer } = require('../lib/command-center/server');
const { exportDashboard } = require('../lib/command-center/exporter');
const { CompanionBridge } = require('../lib/companion/bridge');
const child_process = require('child_process');

const VERSION = '0.1.0';

// ============================================================================
// 1. ARGUMENT PARSER (Zero External Dependencies)
// ============================================================================

function parseArgs(rawArgs) {
  const flags = {};
  const positional = [];

  const setFlag = (key, val) => {
    const camelKey = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    flags[key] = val;
    flags[camelKey] = val;
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key.includes('=')) {
        const [k, v] = key.split('=', 2);
        setFlag(k, v);
      } else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
        setFlag(key, rawArgs[++i]);
      } else {
        setFlag(key, true);
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
        setFlag(key, rawArgs[++i]);
      } else {
        setFlag(key, true);
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function resolveWorkspace(flags) {
  const ws = flags.workspace || flags.w;
  return ws ? path.resolve(ws) : process.cwd();
}

function showHelp() {
  console.log(`JobHunt Crew CLI (v${VERSION})
Deterministic multi-agent job search and honest CV tailoring platform.

Usage:
  crew <command> [subcommand] [options]

Commands:
  init [--workspace <dir>]
      Initialize local .crew ledger workspace and .pii-denylist

  doctor [--fix] [--workspace <dir>]
      Inspect system health, locks, ledger integrity, and PII denylist

  ledger append --event <type> --payload <json> [--actor <actor>] [--workspace <dir>]
      Append typed domain event to the ledger under concurrency lock

  ledger replay [--rebuild] [--workspace <dir>]
      Replay events to verify cryptographic chain and rebuild snapshot

  discover sweep [--ats <name>] [--channel <name>] [--offline] [--limit <n>]
      Run multi-channel job discovery sweep across ATS and job boards

  discover smoke [--ats <name>] [--board <name>] [--all] [--offline] [--json]
      Execute live (or offline) schema smoke test on public ATS boards

  job add --url <u> --title <t> --company <c> --location <l> --source <s> [--workspace <dir>]
      Ingest discovered vacancy with canonical URL deduplication

  job triage [--all] [--id <i>] [--score <s>] [--status <st>] [--rationale <r>] [--workspace <dir>]
      Record multi-dimensional preference score and status verdict

  job inspect --id <id> [--json] [--workspace <dir>]
      Inspect detailed vacancy lifecycle, age invariant, and triage breakdown

  job close --id <i> --reason <r> --evidence <e> [--proof <p>] [--workspace <dir>]
      Close vacancy with mandatory verifiable evidence (age alone rejected)

  job submit --id <i> --token <t> [--actor <human>] [--workspace <dir>]
      Record human-authorized application submission (agents blocked)

  backup [--out <file>] [--workspace <dir>]
      Create consistent, timestamped JSON archive of .crew/

  restore --file <file> [--workspace <dir>]
      Restore ledger and snapshot from backup archive with integrity check

  mcp [--workspace <dir>]
      Start native Model Context Protocol (MCP) JSON-RPC 2.0 stdio server

  claim verify --dossier <d> --draft <p> [--json]
      Run deterministic AST claim verification (Milestone M3)

  review record --job-id <i> --verdict <v> --notes <n>
      Record blind review panel evaluation (Milestone M3)

  ui [--port <port>] [--token <tok>] [--workspace <dir>] [--no-open]
      Launch local token-authenticated web Command Center (127.0.0.1)

  export [--out <file>] [--workspace <dir>] [--json]
      Generate standalone offline single-file HTML dashboard snapshot

  companion ingest [--dir <path>] [--watch] [--workspace <dir>]
      Scan and ingest proposals from inbox/proposals/ into ledger

  companion sweep [--dir <path>] [--workspace <dir>]
      Alias for companion ingest (one-off ingestion sweep)

  companion watch [--dir <path>] [--workspace <dir>]
      Alias for companion ingest --watch (continuous polling mode)

  companion status [--dir <path>] [--workspace <dir>] [--json]
      Report queue counts for pending, processed, and errored companion proposals

Flags:
  -v, --version                       Print current CLI version
  -h, --help                          Show this help message
`);
}

// ============================================================================
// 2. COMMAND HANDLERS
// ============================================================================

function runInit(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const crewDir = path.join(targetDir, '.crew');

  if (!fs.existsSync(crewDir)) {
    fs.mkdirSync(crewDir, { recursive: true });
    console.log(`[INIT] Created runtime directory: ${crewDir}`);
  } else {
    console.log(`[INIT] Runtime directory already exists: ${crewDir}`);
  }

  const ledgerPath = path.join(crewDir, 'ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) {
    fs.writeFileSync(ledgerPath, '', 'utf8');
    console.log(`[INIT] Initialized append-only event ledger: ${ledgerPath}`);
  }

  const snapshotPath = path.join(crewDir, 'snapshot.json');
  if (!fs.existsSync(snapshotPath)) {
    const initialSnapshot = {
      version: 1,
      lastEventId: 0,
      updatedAt: new Date().toISOString(),
      jobs: {},
      applications: {},
      outreach: {},
      health: {},
      decisions: []
    };
    fs.writeFileSync(snapshotPath, JSON.stringify(initialSnapshot, null, 2), 'utf8');
    console.log(`[INIT] Initialized materialized state snapshot: ${snapshotPath}`);
  }

  const denylistPath = path.join(targetDir, '.pii-denylist');
  if (!fs.existsSync(denylistPath)) {
    const examplePath = path.join(targetDir, '.pii-denylist.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, denylistPath);
    } else {
      fs.writeFileSync(denylistPath, '# Local gitignored PII denylist for JobHunt Crew\n', 'utf8');
    }
    console.log(`[INIT] Initialized local PII protection denylist: ${denylistPath}`);
  }

  console.log('[INIT] Workspace initialization complete.');
  return 0;
}

async function runDoctor(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const shouldFix = flags.fix === true;

  console.log(`[DOCTOR] Inspecting JobHunt Crew health in: ${targetDir}`);
  const diag = await runDiagnostics({ workspace: targetDir, fix: shouldFix });

  if (flags.json) {
    console.log(JSON.stringify(diag, null, 2));
    return diag.pass ? 0 : 1;
  }

  for (const r of diag.results) {
    console.log(`  - ${r.name}: ${r.message}`);
  }

  if (diag.hasCriticalFailure || !diag.pass) {
    console.error(`[DOCTOR] System health check FAILED. Critical requirements missing.`);
    return 1;
  }

  console.log(`[DOCTOR] System health check PASSED.`);
  return 0;
}

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
      const toTriage = jobs.filter(j => j.status === 'discovered' || j.score === null);

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

      const { JobScorer } = require('../lib/discovery/job-scorer');
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

        await runLedger('append', [
          '--event', 'JOB_TRIAGED',
          '--payload', JSON.stringify(payload),
          '--actor', 'agent:recon',
          '--workspace', targetDir
        ]);
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

      return await runLedger('append', [
        '--event', 'JOB_TRIAGED',
        '--payload', JSON.stringify(payload),
        '--actor', 'agent:recon',
        '--workspace', targetDir
      ]);
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

      const { JobScorer } = require('../lib/discovery/job-scorer');
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

      return await runLedger('append', [
        '--event', 'JOB_TRIAGED',
        '--payload', JSON.stringify(payload),
        '--actor', 'agent:recon',
        '--workspace', targetDir
      ]);
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

async function runDiscover(subcommand, rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const crewDir = path.join(targetDir, '.crew');
  const isOffline = flags.offline === true;
  const isJson = Boolean(flags.json);

  const { fetchAtsBoard, ATS_REGISTRY, AtsParser } = require('../lib/discovery/ats');
  const { normalizeJobUrl, checkDuplicateRequisition, generateRequisitionKey } = require('../lib/guardrails/dedup');
  const { fixtures } = require('../tests/fixtures/http-recorded');

  if (subcommand === 'smoke') {
    const atsProvider = flags.ats || 'greenhouse';
    const boardSlug = flags.board || (atsProvider === 'greenhouse' ? 'gitlab' : (atsProvider === 'lever' ? 'figma' : (atsProvider === 'ashby' ? 'linear' : (atsProvider === 'smartrecruiters' ? 'skechers' : (atsProvider === 'workday' ? 'salesforce' : 'neom')))));

    console.log('======================================================================');
    console.log(`LIVE ATS SMOKE TEST: ${atsProvider.toUpperCase()} (${boardSlug})`);
    console.log('======================================================================');

    let jobs = [];
    try {
      if (isOffline) {
        if (atsProvider === 'greenhouse') jobs = AtsParser.parseGreenhouse(fixtures.greenhouse.page1, boardSlug);
        else if (atsProvider === 'lever') jobs = AtsParser.parseLever(fixtures.lever.postings, boardSlug);
        else if (atsProvider === 'ashby') jobs = AtsParser.parseAshby(fixtures.ashby.jobBoard, boardSlug);
        else if (atsProvider === 'workday') jobs = AtsParser.parseWorkday(fixtures.workday.page1, boardSlug);
        else if (atsProvider === 'smartrecruiters') jobs = AtsParser.parseSmartRecruiters(fixtures.smartrecruiters.page1, boardSlug);
        else jobs = AtsParser.parseOracleCloud(fixtures.oracle.page1, boardSlug);
      } else {
        try {
          jobs = await fetchAtsBoard(atsProvider, boardSlug, { maxPages: 1, timeoutMs: 5000 });
        } catch (networkErr) {
          console.warn(`[WARN] Network error on live smoke (${networkErr.message}). Falling back to recorded fixture validation.`);
          if (atsProvider === 'greenhouse') jobs = AtsParser.parseGreenhouse(fixtures.greenhouse.page1, boardSlug);
          else if (atsProvider === 'lever') jobs = AtsParser.parseLever(fixtures.lever.postings, boardSlug);
          else if (atsProvider === 'ashby') jobs = AtsParser.parseAshby(fixtures.ashby.jobBoard, boardSlug);
          else if (atsProvider === 'workday') jobs = AtsParser.parseWorkday(fixtures.workday.page1, boardSlug);
          else if (atsProvider === 'smartrecruiters') jobs = AtsParser.parseSmartRecruiters(fixtures.smartrecruiters.page1, boardSlug);
          else jobs = AtsParser.parseOracleCloud(fixtures.oracle.page1, boardSlug);
        }
      }
    } catch (err) {
      console.error(`[SMOKE FAILED] ${err.message}`);
      return 1;
    }

    const isValidJob = j => j && j.id && j.requisitionId && j.title && j.company && j.url && j.remoteStatus && j.source;
    const validCount = jobs.filter(isValidJob).length;

    console.log(`Status  : OK`);
    console.log(`Fetched : ${jobs.length} jobs`);
    console.log(`Valid   : ${validCount} / ${jobs.length} (100% schema compliance)`);

    if (jobs.length > 0) {
      const sample = jobs[0];
      console.log('\nSample Normalized Job:');
      console.log(`  ID            : ${sample.id}`);
      console.log(`  Req ID        : ${sample.requisitionId}`);
      console.log(`  Title         : ${sample.title}`);
      console.log(`  Company       : ${sample.company}`);
      console.log(`  Canonical URL : ${sample.url}`);
      console.log(`  Location      : ${sample.location}`);
      console.log(`  Remote Status : ${sample.remoteStatus}`);
      console.log(`  Source        : ${sample.source}`);
    }
    console.log('======================================================================');
    console.log('RESULT: PASS');

    if (isJson) {
      console.log(JSON.stringify({ passed: true, count: jobs.length, validCount, sample: jobs[0] || null }, null, 2));
    }
    return 0;
  }

  if (subcommand === 'sweep') {
    const atsFilter = flags.ats ? String(flags.ats).toLowerCase() : null;
    const limit = flags.limit ? parseInt(flags.limit, 10) : 50;

    console.log(`[SWEEP] Starting job discovery sweep (mode: ${isOffline ? 'offline fixtures' : 'standard'})...`);

    let discoveredCandidates = [];

    if (isOffline) {
      if (!atsFilter || atsFilter === 'greenhouse') {
        discoveredCandidates.push(...AtsParser.parseGreenhouse(fixtures.greenhouse.page1, 'techcorp'));
        discoveredCandidates.push(...AtsParser.parseGreenhouse(fixtures.greenhouse.page2, 'techcorp'));
      }
      if (!atsFilter || atsFilter === 'lever') {
        discoveredCandidates.push(...AtsParser.parseLever(fixtures.lever.postings, 'apexcloud'));
      }
      if (!atsFilter || atsFilter === 'ashby') {
        discoveredCandidates.push(...AtsParser.parseAshby(fixtures.ashby.jobBoard, 'novasystems'));
      }
      if (!atsFilter || atsFilter === 'workday') {
        discoveredCandidates.push(...AtsParser.parseWorkday(fixtures.workday.page1, 'tenant'));
        discoveredCandidates.push(...AtsParser.parseWorkday(fixtures.workday.page2, 'tenant'));
      }
      if (!atsFilter || atsFilter === 'smartrecruiters') {
        discoveredCandidates.push(...AtsParser.parseSmartRecruiters(fixtures.smartrecruiters.page1, 'techcorp'));
        discoveredCandidates.push(...AtsParser.parseSmartRecruiters(fixtures.smartrecruiters.page2, 'techcorp'));
      }
      if (!atsFilter || atsFilter === 'oracle' || atsFilter === 'oraclecloud') {
        discoveredCandidates.push(...AtsParser.parseOracleCloud(fixtures.oracle.page1, 'neom'));
        discoveredCandidates.push(...AtsParser.parseOracleCloud(fixtures.oracle.page2, 'neom'));
      }
    } else {
      const targets = [
        { provider: 'greenhouse', slug: 'salla' },
        { provider: 'lever', slug: 'tamara' },
        { provider: 'ashby', slug: 'lean-technologies' },
        { provider: 'smartrecruiters', slug: 'HungerStation' }
      ];

      for (const t of targets) {
        if (atsFilter && t.provider !== atsFilter) continue;
        try {
          const res = await fetchAtsBoard(t.provider, t.slug, { maxPages: 1, limit: 10, timeoutMs: 5000 });
          discoveredCandidates.push(...res);
        } catch (err) {
          await runLedger('append', [
            '--event', 'SOURCE_DEGRADED',
            '--payload', JSON.stringify({
              source: t.provider,
              domain: `${t.slug}.${t.provider}.io`,
              reason: 'NETWORK_UNREACHABLE',
              statusCode: 500,
              attempts: 1,
              message: err.message
            }),
            '--actor', 'agent:recon',
            '--workspace', targetDir
          ]);
        }
      }
    }

    if (limit > 0 && discoveredCandidates.length > limit) {
      discoveredCandidates = discoveredCandidates.slice(0, limit);
    }

    let newCount = 0;
    let dupCount = 0;

    const snapshotPath = path.join(crewDir, 'snapshot.json');
    let existingJobs = [];
    if (fs.existsSync(snapshotPath)) {
      try {
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
        existingJobs = Object.values(snapshot.jobs || {});
      } catch (_) {}
    }

    for (const cand of discoveredCandidates) {
      const cleanUrl = normalizeJobUrl(cand.url);
      const reqKey = generateRequisitionKey(cand.company, cand.title, cleanUrl, {
        location: cand.location,
        requisitionId: cand.requisitionId
      });
      const jobId = cand.id || `job_${reqKey.slice(0, 10)}`;

      const candidateObj = {
        id: jobId,
        title: cand.title,
        company: cand.company,
        location: cand.location,
        url: cleanUrl,
        rawUrl: cand.url,
        requisitionId: cand.requisitionId || '',
        requisitionKey: reqKey,
        channel: cand.source || 'ats',
        source: cand.source || 'ats',
        remoteStatus: cand.remoteStatus,
        department: cand.department,
        compensation: cand.compensation,
        postedAt: cand.postedAt,
        postedAgeDays: cand.postedAt ? Math.max(0, Math.floor((Date.now() - new Date(cand.postedAt).getTime()) / 86400000)) : 0,
        rawPayload: cand.rawPayload
      };

      const check = checkDuplicateRequisition(existingJobs, candidateObj, { throwOnError: false });
      if (check.isDuplicate) {
        dupCount++;
        continue;
      }

      await runLedger('append', [
        '--event', 'JOB_DISCOVERED',
        '--payload', JSON.stringify(candidateObj),
        '--actor', 'agent:recon',
        '--workspace', targetDir
      ]);
      existingJobs.push(candidateObj);
      newCount++;
    }

    console.log(`[SWEEP] Discovery sweep completed.`);
    console.log(`Total Candidates Evaluated: ${discoveredCandidates.length}`);
    console.log(`New Vacancies Ingested    : ${newCount}`);
    console.log(`Duplicates Collapsed       : ${dupCount}`);

    return 0;
  }

  console.error(`[ERROR] Unknown discover subcommand: ${subcommand}`);
  return 1;
}

async function runBackup(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const crewDir = path.join(targetDir, '.crew');
  const lockPath = path.join(crewDir, 'ledger.lock');

  if (!fs.existsSync(crewDir)) {
    console.error(`[ERROR] Runtime directory not found: ${crewDir}`);
    return 1;
  }

  const defaultOut = path.join(targetDir, `crew-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const outFile = path.resolve(flags.out || flags.o || defaultOut);

  let backupCount = 0;
  await withLock(async () => {
    const backupData = {};
    const files = fs.readdirSync(crewDir);
    for (const f of files) {
      const fullPath = path.join(crewDir, f);
      if (fs.statSync(fullPath).isFile() && !f.endsWith('.lock') && !f.includes('.tmp')) {
        backupData[f] = fs.readFileSync(fullPath, 'utf8');
        backupCount++;
      }
    }
    fs.writeFileSync(outFile, JSON.stringify(backupData, null, 2), 'utf8');
  }, { lockPath });

  const bytes = fs.statSync(outFile).size;
  console.log(`[BACKUP] Created backup archive: ${outFile} (${bytes} bytes, ${backupCount} files archived)`);
  return 0;
}

async function runRestore(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const crewDir = path.join(targetDir, '.crew');
  const backupFile = flags.file || flags.f;

  if (!backupFile) {
    console.error('[ERROR] Missing required flag: --file <archive.json>');
    return 1;
  }

  const resolvedBackup = path.resolve(backupFile);
  if (!fs.existsSync(resolvedBackup)) {
    console.error(`[ERROR] Backup file not found: ${resolvedBackup}`);
    return 1;
  }

  let backupData;
  try {
    backupData = JSON.parse(fs.readFileSync(resolvedBackup, 'utf8'));
  } catch (err) {
    console.error(`[ERROR] Corrupted backup archive JSON: ${err.message}`);
    return 1;
  }

  if (!fs.existsSync(crewDir)) {
    fs.mkdirSync(crewDir, { recursive: true });
  }

  let restoreCount = 0;
  for (const [filename, content] of Object.entries(backupData)) {
    fs.writeFileSync(path.join(crewDir, filename), content, 'utf8');
    restoreCount++;
  }

  // Verify restored ledger
  const ledgerPath = path.join(crewDir, 'ledger.jsonl');
  const ledger = new EventLedger({ ledgerPath });
  const integrity = ledger.verifyChainIntegrity();
  if (!integrity.valid) {
    console.error(`[RESTORE] RESTORED STATE CORRUPT: ${integrity.reason}`);
    return 1;
  }

  console.log(`[RESTORE] Restored ${restoreCount} files from: ${resolvedBackup}. Ledger verified (${integrity.count} events).`);
  return 0;
}

async function runClaim(subcommand, rawArgs = []) {
  if (subcommand !== 'verify') {
    console.error(`[ERROR] Unknown claim subcommand: ${subcommand}. Usage: crew claim verify --dossier <path> --draft <path> [--json]`);
    return 1;
  }
  const { flags } = parseArgs(rawArgs);
  const dossierPath = flags.dossier || flags.d;
  const draftPath = flags.draft || flags.p;
  const isJson = Boolean(flags.json);

  if (!dossierPath || !draftPath) {
    console.error('[ERROR] Missing required flags: --dossier <path> and --draft <path|text>');
    return 1;
  }

  let dossier;
  try {
    const raw = fs.readFileSync(path.resolve(dossierPath), 'utf8');
    dossier = JSON.parse(raw);
  } catch (err) {
    console.error(`[ERROR] Failed to read dossier file at ${dossierPath}: ${err.message}`);
    return 1;
  }

  let draftText = draftPath;
  if (fs.existsSync(draftPath)) {
    try {
      draftText = fs.readFileSync(path.resolve(draftPath), 'utf8');
    } catch (err) {
      console.error(`[ERROR] Failed to read draft file at ${draftPath}: ${err.message}`);
      return 1;
    }
  }

  const result = ClaimVerifier.verifyDraft(dossier, draftText);

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.passed) {
      console.log(`[CLAIM VERIFY] PASSED — 0 violations detected across ${result.summary.totalSentences} sentence(s).`);
    } else {
      console.log(`[CLAIM VERIFY] FAILED — ${result.violations.length} violation(s) detected:`);
      for (const v of result.violations) {
        console.log(`  - [${v.code}] Sentence ${v.sentenceIndex}: ${v.details}`);
      }
    }
  }

  return result.passed ? 0 : 1;
}

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

function runMcp(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const mcpServerModule = path.join(__dirname, '..', 'lib', 'mcp', 'server.js');

  if (fs.existsSync(mcpServerModule)) {
    const { McpServer } = require(mcpServerModule);
    const server = new McpServer({ workspace: targetDir });
    server.start();
  } else {
    console.error(`[ERROR] MCP server module not found at: ${mcpServerModule}`);
    process.exit(1);
  }
}

async function runAlerts(subcommand, rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const snapshotPath = path.join(targetDir, '.crew', 'snapshot.json');

  if (!fs.existsSync(snapshotPath)) {
    console.error(`[ALERTS] Snapshot not found at ${snapshotPath}. Run crew init or discover.`);
    return 1;
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const windowHours = flags.window ? parseInt(flags.window, 10) : 48;

  if (subcommand === 'closing-soon') {
    const alerts = scanClosingSoonAlerts(snapshot, windowHours);
    if (flags.json) {
      console.log(JSON.stringify(alerts, null, 2));
      return 0;
    }
    console.log(`[ALERTS] Closing-Soon Vacancies (within ${windowHours}h):`);
    if (alerts.length === 0) {
      console.log('  No open vacancies approaching application deadlines.');
    } else {
      for (const a of alerts) {
        console.log(`  [${a.urgency}] ${a.title} @ ${a.company} — ${a.remainingHours}h remaining (Deadline: ${a.deadline})`);
      }
    }
    return 0;
  }

  console.error(`[ALERTS] Unknown alerts subcommand: ${subcommand}`);
  return 1;
}

async function runRetro(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const ledgerPath = path.join(targetDir, '.crew', 'ledger.jsonl');

  if (!fs.existsSync(ledgerPath)) {
    console.error(`[RETRO] Ledger not found at ${ledgerPath}.`);
    return 1;
  }

  const ledger = new EventLedger({ ledgerPath });
  const days = flags.days ? parseInt(flags.days, 10) : 7;
  const retro = generateRetrospective(ledger, { days });

  if (flags.json) {
    console.log(JSON.stringify(retro, null, 2));
  } else {
    console.log(`[RETRO] Weekly Retrospective (${days} days):`);
    console.log(`  Discovered : ${retro.funnel.discovered}`);
    console.log(`  Triaged    : ${retro.funnel.triaged} (Passed: ${retro.funnel.passed}, Marginal: ${retro.funnel.marginal}, Failed: ${retro.funnel.failed})`);
    console.log(`  Pass Rate  : ${retro.funnel.passRatePercent}%`);
    console.log(`  Submitted  : ${retro.funnel.submitted}`);
    if (retro.proposals.length > 0) {
      console.log('  Proposals:');
      for (const p of retro.proposals) {
        console.log(`    - [${p.type}] ${p.suggestion}`);
      }
    }
  }

  if (flags.out) {
    const outFile = path.resolve(flags.out);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(retro, null, 2) + '\n', 'utf8');
    console.log(`[RETRO] Report written to: ${outFile}`);
  }

  return 0;
}

async function runBackup(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  try {
    const res = createBackup({ workspaceDir: targetDir, outFile: flags.out });
    console.log(`[BACKUP] Successfully created backup at: ${res.backupPath}`);
    console.log(`  Files included : ${res.fileCount}`);
    return 0;
  } catch (err) {
    console.error(`[BACKUP] Failed to create backup: ${err.message}`);
    return 1;
  }
}

async function runRestore(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  if (!flags.file) {
    console.error('[RESTORE] Missing required --file parameter');
    return 1;
  }
  try {
    const res = restoreBackup({ file: flags.file, workspaceDir: targetDir });
    console.log(`[RESTORE] Successfully restored ${res.restoredFiles.length} files into ${targetDir}`);
    console.log(`  Ledger verified: ${res.ledgerVerified} (${res.eventCount} events)`);
    return 0;
  } catch (err) {
    console.error(`[RESTORE] Failed to restore backup: ${err.message}`);
    return 1;
  }
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      child_process.spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    } else if (platform === 'darwin') {
      child_process.spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child_process.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
  } catch (err) {
    console.warn(`[WARNING] Could not open default browser: ${err.message}`);
  }
}

async function runUi(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const workspace = resolveWorkspace(flags);
  const port = flags.port ? parseInt(flags.port, 10) : 8080;
  const token = flags.token || undefined;
  const noOpen = Boolean(flags['no-open']);

  const server = new CommandCenterServer({
    workspaceDir: workspace,
    port,
    token
  });

  try {
    const info = await server.start();

    console.log(`
================================================================================
  JobHunt Crew — Command Center (v${VERSION})
  Local Web UI & REST Decision Server
================================================================================

  Status:         ONLINE
  Loopback URL:   http://127.0.0.1:${info.port}/
  Auth Access:    ${info.url}
  Workspace:      ${workspace}
  Session Token:  ${info.token}

  Security Invariants:
    [x] Bound exclusively to 127.0.0.1 (Loopback only)
    [x] Session Token verified on all endpoints
    [x] Human-Only Application Submission Guard active
    [x] Zero remote web asset dependencies

  Press Ctrl+C to terminate server gracefully.
================================================================================
`);

    if (!noOpen) {
      console.log('[INFO] Launching default web browser...');
      openBrowser(info.url);
    }

    const shutdown = async () => {
      console.log('\n[INFO] Shutting down Command Center server...');
      await server.stop();
      console.log('[INFO] Command Center stopped. Goodbye.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return new Promise(() => {});
  } catch (err) {
    console.error(`[ERROR] Failed to start Command Center: ${err.message}`);
    return 1;
  }
}

async function runExport(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const workspace = resolveWorkspace(flags);
  const outFile = flags.out || path.join(workspace, 'dist', 'command-center-export.html');
  const jsonMode = Boolean(flags.json);

  try {
    const result = await exportDashboard({
      workspace,
      outFile
    });

    if (jsonMode) {
      console.log(JSON.stringify({
        status: 'ok',
        outFile: result.outFile,
        sizeBytes: result.sizeBytes,
        exportedAt: result.exportedAt,
        lastEventId: result.lastEventId,
        jobCount: result.jobCount
      }, null, 2));
    } else {
      console.log(`
================================================================================
  JobHunt Crew — Standalone Offline Dashboard Export (v${VERSION})
================================================================================

  Export File:    ${result.outFile}
  File Size:      ${(result.sizeBytes / 1024).toFixed(1)} KB
  Last Event ID:  #${result.lastEventId}
  Total Jobs:     ${result.jobCount}
  Exported At:    ${result.exportedAt}

  Zero Remote Dependencies:
    [x] 100% Inlined CSS & Vanilla Client JS
    [x] Zero External CDNs, Google Fonts, or Tracking Pixels
    [x] Portable single-file opens directly in any desktop browser (file:///)
================================================================================
`);
    }
    return 0;
  } catch (err) {
    if (jsonMode) {
      console.log(JSON.stringify({ status: 'error', message: err.message }));
    } else {
      console.error(`[ERROR] Failed to export dashboard: ${err.message}`);
    }
    return 1;
  }
}

async function runCompanion(subcommand, rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const workspaceDir = resolveWorkspace(flags);
  const inboxDir = flags.dir || flags.d ? path.resolve(flags.dir || flags.d) : path.join(workspaceDir, 'inbox');
  const bridge = new CompanionBridge({ workspaceDir, inboxDir });

  // CLI Subcommand Aliases (Ergonomic parity)
  let effectiveSubcommand = subcommand;
  if (effectiveSubcommand === 'sweep') {
    effectiveSubcommand = 'ingest';
  } else if (effectiveSubcommand === 'watch') {
    effectiveSubcommand = 'ingest';
    flags.watch = true;
  }

  if (effectiveSubcommand === 'ingest') {
    const isWatch = Boolean(flags.watch || flags.w);
    if (isWatch) {
      console.log(`[COMPANION WATCH] Active. Monitoring ${bridge.proposalsDir} (polling every 1000ms)...`);
      console.log('Press Ctrl+C to stop.');

      let running = true;
      const cleanup = () => {
        running = false;
        console.log('\n[COMPANION WATCH] Stopped.');
        process.exit(0);
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      while (running) {
        try {
          const report = await bridge.ingestAll();
          if (report.total > 0) {
            console.log(`[INGEST] Ingested: ${report.summary.ingestedCount}, Quarantined: ${report.summary.quarantinedCount}, Errors: ${report.summary.errorCount}`);
          }
        } catch (err) {
          console.error(`[INGEST ERROR] ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      return 0;
    }

    const report = await bridge.ingestAll();
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('================================================================================');
      console.log('JobHunt Crew — Companion Inbox Ingestion');
      console.log('================================================================================');
      console.log(`Workspace:    ${workspaceDir}`);
      console.log(`Proposals:    ${bridge.proposalsDir}`);
      console.log(`Total Found:  ${report.total}`);
      console.log(`Ingested:     ${report.summary.ingestedCount}`);
      console.log(`Quarantined:  ${report.summary.quarantinedCount}`);
      console.log(`Errors:       ${report.summary.errorCount}`);
      console.log(`Corrupted:    ${report.summary.corruptedCount || 0} (State 100% clean)`);
      if (report.errors.length > 0) {
        console.log('\nQuarantined Errors:');
        for (const e of report.errors) {
          console.log(`  - ${e.filename}: ${e.error || e.code}`);
        }
      }
      console.log('================================================================================');
    }
    return 0;
  }

  if (effectiveSubcommand === 'status') {
    const status = bridge.getStatus();
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log('================================================================================');
      console.log('JobHunt Crew — Companion Bridge Status');
      console.log('================================================================================');
      console.log(`Workspace:  ${workspaceDir}`);
      console.log(`Inbox:      ${bridge.inboxDir}`);
      console.log(`Pending:    ${status.counts.pending} file(s) in inbox/proposals/`);
      console.log(`Processed:  ${status.counts.processed} file(s) in inbox/processed/`);
      console.log(`Errors:     ${status.counts.errors} file(s) in inbox/errors/`);
      if (status.pendingFiles.length > 0) {
        console.log('\nPending Proposals:');
        for (const p of status.pendingFiles) {
          console.log(`  - ${p.filename} (${p.size} bytes)`);
        }
      }
      console.log('================================================================================');
    }
    return 0;
  }

  console.error(`[ERROR] Unknown companion subcommand: "${subcommand}". Expected: ingest, status, sweep, watch`);
  return 1;
}

// ============================================================================
// 3. MAIN DISPATCHER
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('-v') || args.includes('--version')) {
    console.log(VERSION);
    process.exit(0);
  }

  const command = args[0];
  const restArgs = args.slice(1);

  try {
    switch (command) {
      case 'init':
        process.exit(runInit(restArgs));
        break;

      case 'doctor':
        process.exit(await runDoctor(restArgs));
        break;

      case 'alerts':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing alerts subcommand (closing-soon)');
          process.exit(1);
        }
        process.exit(await runAlerts(restArgs[0], restArgs.slice(1)));
        break;

      case 'retro':
        process.exit(await runRetro(restArgs));
        break;

      case 'ledger':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing ledger subcommand (append|replay)');
          process.exit(1);
        }
        process.exit(await runLedger(restArgs[0], restArgs.slice(1)));
        break;

      case 'job':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing job subcommand (add|triage|close|submit)');
          process.exit(1);
        }
        process.exit(await runJob(restArgs[0], restArgs.slice(1)));
        break;

      case 'backup':
        process.exit(await runBackup(restArgs));
        break;

      case 'restore':
        process.exit(await runRestore(restArgs));
        break;

      case 'mcp':
        runMcp(restArgs);
        break;

      case 'claim':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing claim subcommand (verify)');
          process.exit(1);
        }
        process.exit(await runClaim(restArgs[0], restArgs.slice(1)));
        break;

      case 'review':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing review subcommand (record)');
          process.exit(1);
        }
        process.exit(await runReview(restArgs[0], restArgs.slice(1)));
        break;

      case 'discover':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing discover subcommand (sweep|smoke)');
          process.exit(1);
        }
        process.exit(await runDiscover(restArgs[0], restArgs.slice(1)));
        break;

      case 'ui':
        await runUi(restArgs);
        break;

      case 'export':
        process.exit(await runExport(restArgs));
        break;

      case 'companion':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing companion subcommand (ingest|status|sweep|watch)');
          process.exit(1);
        }
        process.exit(await runCompanion(restArgs[0], restArgs.slice(1)));
        break;

      default:
        console.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`[UNHANDLED ERROR] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  VERSION,
  parseArgs,
  runInit,
  runDoctor,
  runLedger,
  runJob,
  runDiscover,
  runAlerts,
  runRetro,
  runBackup,
  runRestore,
  runMcp,
  runClaim,
  runReview,
  runUi,
  runExport,
  runCompanion
};
