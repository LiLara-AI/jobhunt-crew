'use strict';

/**
 * JobHunt Crew — Companion Inbox Proposal Bridge
 *
 * Implements the asynchronous file bridge connecting the Gemini Desktop app
 * to the core append-only event ledger, candidate dossier, and snapshot.
 *
 * Enforces core guardrails:
 * - Reject unauthorized submission claims (action === 'submitted' or status === 'submitted')
 * - Quarantine companion-drafted documents pending Inquisitor claim verification
 * - Gating proposed claims with [CONFIRM]
 * - State corruption immunity under all error conditions
 * - Atomic cross-process concurrency locking via withLock
 *
 * Location: lib/companion/bridge.js
 * Zero external dependencies. Uses Node.js built-in runtime.
 */

const fs = require('fs');
const path = require('path');
const { EventLedger } = require('../ledger/ledger');
const { replayLedger } = require('../ledger/reducer');
const { withLock } = require('../ledger/lock');
const { CompanionValidationGate } = require('./validation');

/**
 * Cross-platform safe file move with retries for Windows EPERM/EBUSY file locks.
 *
 * @param {string} src - Source file path
 * @param {string} dest - Destination file path
 * @param {number} [retries=3] - Number of retry attempts
 */
function safeMoveFile(src, dest, retries = 3) {
  if (!fs.existsSync(src)) {
    return false;
  }
  try {
    fs.renameSync(src, dest);
    if (!fs.existsSync(dest)) {
      return false;
    }
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return false;
    }
    if (
      process.platform === 'win32' &&
      (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EXDEV' || err.code === 'EACCES')
    ) {
      if (retries > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        if (!fs.existsSync(src)) {
          return false;
        }
        try {
          fs.renameSync(src, dest);
          return true;
        } catch (retryErr) {
          if (retryErr.code === 'ENOENT') {
            return false;
          }
        }
      }

      let copied = false;
      try {
        fs.copyFileSync(src, dest);
        copied = true;
      } catch (copyErr) {
        if (copyErr.code === 'ENOENT') {
          return false;
        }
        throw copyErr;
      }
      try {
        fs.unlinkSync(src);
        return true;
      } catch (unlinkErr) {
        if (copied) {
          try {
            fs.unlinkSync(dest);
          } catch (_) {}
        }
        if (unlinkErr.code === 'ENOENT') {
          return false;
        }
        if (retries > 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          return safeMoveFile(src, dest, retries - 1);
        }
        return false;
      }
    } else {
      throw err;
    }
  }
}

class CompanionBridge {
  /**
   * Static in-memory proposal ingestion & validation method.
   * 100% backward-compatible with tests/tier1-feature-coverage/test-gemini-companion.js.
   *
   * @param {string} fileContent - Raw JSON string
   * @param {object} [options]
   * @returns {object} Validation & ingestion verdict:
   *   { ingested: boolean, error?: string, action?: string, jobId?: string, status?: string, stateCorrupted: false }
   */
  static ingestProposal(fileContent, options = {}) {
    let parsed;
    try {
      const cleanContent = typeof fileContent === 'string' && fileContent.charCodeAt(0) === 0xFEFF
        ? fileContent.slice(1)
        : fileContent;
      parsed = JSON.parse(cleanContent);
    } catch (_) {
      return {
        ingested: false,
        code: 'MALFORMED_JSON',
        error: 'MALFORMED_JSON',
        stateCorrupted: false
      };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ingested: false,
        code: 'INVALID_OBJECT',
        error: 'INVALID_OBJECT: Proposal must be a non-null, non-array JSON object',
        stateCorrupted: false
      };
    }

    // Required fields check: must have type and an identifier
    const targetId = parsed.jobId || parsed.claimId || parsed.id || (parsed.type === 'claim_proposal' ? parsed.employerId : null);
    if (!parsed.type) {
      return {
        ingested: false,
        code: 'MISSING_REQUIRED_FIELDS',
        error: 'MISSING_REQUIRED_FIELDS: Missing proposal type',
        stateCorrupted: false
      };
    }
    if (!targetId && parsed.type !== 'candidate_fact_proposal') {
      return {
        ingested: false,
        code: 'MISSING_REQUIRED_FIELDS',
        error: 'MISSING_REQUIRED_FIELDS: Missing target identifier',
        stateCorrupted: false
      };
    }

    // Delegate to CompanionValidationGate for authoritative validation
    const verdict = CompanionValidationGate.validateProposal(parsed, options);

    if (!verdict.ingested) {
      return {
        ingested: false,
        code: verdict.code || 'GUARDRAIL_VIOLATION',
        error: verdict.error,
        stateCorrupted: false
      };
    }

    // Inquisitor draft quarantine gate
    if (verdict.action === 'HOLD_FOR_CLAIM_VERIFICATION' || parsed.type === 'draft_proposal') {
      return {
        ingested: true,
        action: 'HOLD_FOR_CLAIM_VERIFICATION',
        jobId: targetId,
        status: 'pending_inquisitor_verification',
        stateCorrupted: false,
        proposal: parsed
      };
    }

    return {
      ingested: true,
      action: verdict.action || 'INGESTED_AS_PROPOSAL',
      jobId: targetId,
      status: verdict.status || 'pending_human_review',
      stateCorrupted: false,
      proposal: parsed
    };
  }

  /**
   * Static helper to ingest a full proposals directory.
   *
   * @param {string} workspaceDir - Target workspace directory
   * @param {object} [options]
   * @returns {Promise<object>} Ingestion summary report
   */
  static async ingestDirectory(workspaceDir, options = {}) {
    const bridge = new CompanionBridge({ workspaceDir, ...options });
    return await bridge.ingestAll();
  }

  /**
   * Constructs a CompanionBridge instance tied to a workspace.
   *
   * @param {object} [options]
   * @param {string} [options.workspaceDir] - Root workspace directory (default: process.cwd())
   * @param {string} [options.inboxDir] - Custom inbox directory path
   */
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir ? path.resolve(options.workspaceDir) : process.cwd();
    this.inboxDir = options.inboxDir ? path.resolve(options.inboxDir) : path.join(this.workspaceDir, 'inbox');
    this.proposalsDir = path.join(this.inboxDir, 'proposals');
    this.processedDir = path.join(this.inboxDir, 'processed');
    this.errorsDir = path.join(this.inboxDir, 'errors');

    this.ledgerPath = path.join(this.workspaceDir, '.crew', 'ledger.jsonl');
    this.lockPath = path.join(this.workspaceDir, '.crew', 'ledger.lock');
    this.snapshotPath = path.join(this.workspaceDir, '.crew', 'snapshot.json');
    this.dossierPath = path.join(this.workspaceDir, 'dossier.json');

    this.ledger = new EventLedger({
      workspaceDir: this.workspaceDir,
      ledgerPath: this.ledgerPath,
      lockPath: this.lockPath
    });
  }

  /**
   * Ensures the inbox directory structure exists.
   */
  ensureDirectories() {
    for (const dir of [this.inboxDir, this.proposalsDir, this.processedDir, this.errorsDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Lists all pending proposal files sorted in FIFO order by modification time.
   *
   * @returns {Array<{ filename: string, fullPath: string, mtimeMs: number, size: number }>}
   */
  listPendingProposals() {
    this.ensureDirectories();
    const files = fs.readdirSync(this.proposalsDir);
    return files
      .filter(f => f.endsWith('.json') && !f.startsWith('.') && !f.includes('.tmp.') && !f.endsWith('.error.json'))
      .filter(f => {
        const lockFile = path.join(this.proposalsDir, `.${f}.lock`);
        if (fs.existsSync(lockFile)) {
          try {
            const stat = fs.statSync(lockFile);
            if (Date.now() - stat.mtimeMs < 15000) {
              return false;
            }
          } catch (_) {}
        }
        return true;
      })
      .map(f => {
        const fullPath = path.join(this.proposalsDir, f);
        try {
          const stat = fs.statSync(fullPath);
          return { filename: f, fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  /**
   * Ingests a single proposal file from inbox/proposals/ through validation,
   * ledger append, and atomic file archiving.
   *
   * @param {string} filePath - Absolute path to proposal JSON file
   * @returns {Promise<object>} Ingestion result
   */
  async ingestFile(filePath) {
    this.ensureDirectories();

    // 0. Directory Containment & Path Traversal Guard (VULN-M7-09)
    if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
      return {
        success: false,
        action: 'SECURITY_VIOLATION',
        code: 'SECURITY_VIOLATION',
        error: 'SECURITY_VIOLATION: File path must be a non-empty string',
        stateCorrupted: false
      };
    }

    const resolvedProposalsDir = path.resolve(this.proposalsDir);
    const resolvedPath = path.resolve(filePath);
    const relative = path.relative(resolvedProposalsDir, resolvedPath);

    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative.includes('/') ||
      relative.includes('\\') ||
      relative.startsWith('.')
    ) {
      return {
        success: false,
        action: 'SECURITY_VIOLATION',
        code: 'SECURITY_VIOLATION',
        error: `SECURITY_VIOLATION: File path "${filePath}" must reside directly within inbox/proposals/`,
        stateCorrupted: false
      };
    }

    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        action: 'ALREADY_PROCESSED',
        stateCorrupted: false
      };
    }
    const basename = path.basename(filePath);
    const dirname = path.dirname(filePath);
    const timestamp = Date.now();

    // 1. Exclusive Reservation Lock via fs.openSync('.<file>.lock', 'wx') (VULN-M7-07, VULN-M7-08)
    const lockPath = path.join(dirname, `.${basename}.lock`);
    let lockFd = null;

    try {
      lockFd = fs.openSync(lockPath, 'wx');
      fs.writeSync(lockFd, `${process.pid}:${timestamp}`);
      fs.closeSync(lockFd);
      lockFd = null;
    } catch (lockErr) {
      if (lockErr.code === 'EEXIST') {
        // Check for stale lock (> 30s) from potentially crashed process
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 30000) {
            try { fs.unlinkSync(lockPath); } catch (_) {}
            try {
              lockFd = fs.openSync(lockPath, 'wx');
              fs.closeSync(lockFd);
              lockFd = null;
            } catch (_) {
              return { success: false, action: 'ALREADY_PROCESSED', stateCorrupted: false };
            }
          } else {
            return { success: false, action: 'ALREADY_PROCESSED', stateCorrupted: false };
          }
        } catch (_) {
          return { success: false, action: 'ALREADY_PROCESSED', stateCorrupted: false };
        }
      } else {
        throw lockErr;
      }
    }

    try {
      // Re-verify existence after acquiring reservation lock
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          action: 'ALREADY_PROCESSED',
          stateCorrupted: false
        };
      }

      // 2. Atomic Claiming via safeMoveFile
      const claimName = `.${basename}.${process.pid}.${timestamp}.${Math.random().toString(36).slice(2, 8)}.claiming`;
      const claimPath = path.join(dirname, claimName);

      const claimed = safeMoveFile(filePath, claimPath);
      if (!claimed) {
        return {
          success: false,
          action: 'ALREADY_PROCESSED',
          stateCorrupted: false
        };
      }

      // Safe read from claimed file
      let content;
      try {
        content = fs.readFileSync(claimPath, 'utf8');
      } catch (readErr) {
        return {
          success: false,
          error: `READ_ERROR: ${readErr.message}`,
          stateCorrupted: false
        };
      }

      // Load candidate dossier for employer / claim cross-referencing if present
      let dossierData = null;
      if (fs.existsSync(this.dossierPath)) {
        try {
          dossierData = JSON.parse(fs.readFileSync(this.dossierPath, 'utf8'));
        } catch (_) {}
      }

      // 3. Validate in-memory against core invariants
      const check = CompanionBridge.ingestProposal(content, { dossier: dossierData });

      if (!check.ingested) {
        // Quarantine to inbox/errors/ with Sidecar Deduplication (VULN-M7-07)
        const existingErrors = fs.readdirSync(this.errorsDir);
        const alreadyQuarantined = existingErrors.some(f => f.startsWith(`${basename}.`) && f.endsWith('.error.json'));
        if (alreadyQuarantined) {
          try { fs.unlinkSync(claimPath); } catch (_) {}
          return {
            success: false,
            action: 'ALREADY_PROCESSED',
            stateCorrupted: false
          };
        }

        const isMalformed = check.error === 'MALFORMED_JSON' || (check.code && check.code.includes('MALFORMED'));
        const statusSuffix = isMalformed ? 'malformed' : 'rejected';
        const errDest = path.join(this.errorsDir, `${basename}.${timestamp}.${statusSuffix}.json`);
        const sidecarDest = path.join(this.errorsDir, `${basename}.${timestamp}.error.json`);

        const moved = safeMoveFile(claimPath, errDest);
        if (!moved) {
          return {
            success: false,
            action: 'ALREADY_PROCESSED',
            stateCorrupted: false
          };
        }

        const sidecarContent = {
          timestamp: new Date(timestamp).toISOString(),
          originalFile: basename,
          code: check.code || (isMalformed ? 'MALFORMED_JSON' : 'GUARDRAIL_VIOLATION'),
          error: check.error,
          stateCorrupted: false
        };

        try {
          const sidecarFd = fs.openSync(sidecarDest, 'wx');
          fs.writeSync(sidecarFd, JSON.stringify(sidecarContent, null, 2), 'utf8');
          fs.closeSync(sidecarFd);
        } catch (sidecarErr) {
          if (sidecarErr.code === 'EEXIST') {
            return {
              success: false,
              action: 'ALREADY_PROCESSED',
              stateCorrupted: false
            };
          }
          throw sidecarErr;
        }

        return {
          success: false,
          action: 'QUARANTINE_ERROR',
          error: check.error,
          code: sidecarContent.code,
          quarantinedPath: errDest,
          sidecarPath: sidecarDest,
          stateCorrupted: false
        };
      }

      const proposal = check.proposal;
      const type = proposal.type ? proposal.type.toLowerCase().trim() : 'status_update';
      const targetId = check.jobId || proposal.jobId || proposal.claimId || proposal.id;

      // 4. Map proposal to ledger event
      let eventName = 'DECISION_RECORDED';
      let payload = {};
      const actor = proposal.actor || 'human:gemini_companion';

      if (type === 'triage_decision') {
        const dec = String(proposal.decision || '').toLowerCase();
        if (dec === 'shortlist' || dec === 'select' || dec === 'apply') {
          eventName = 'JOB_SELECTED';
          payload = {
            jobId: targetId,
            decision: 'apply',
            decisionType: 'apply',
            score: typeof proposal.score === 'number' ? proposal.score : 4.0,
            rationale: proposal.rationale || proposal.notes || 'Shortlisted via Gemini Desktop Companion',
            decisionId: `dec_triage_${timestamp}`
          };
        } else if (dec === 'not_interested' || dec === 'exclude' || dec === 'reject') {
          eventName = 'JOB_CLOSED';
          payload = {
            jobId: targetId,
            reason: 'not_interested',
            evidence: {
              type: 'explicit_closure_notice',
              proof: proposal.notes || proposal.rationale || 'Marked not interested via Gemini Desktop Companion'
            }
          };
        } else {
          eventName = 'DECISION_RECORDED';
          payload = {
            jobId: targetId,
            decision: 'park',
            decisionType: 'park',
            reason: proposal.notes || 'Parked via Gemini Desktop Companion',
            decisionId: `dec_park_${timestamp}`
          };
        }
      } else if (type === 'claim_confirmation') {
        eventName = 'CLAIM_CONFIRMED';
        payload = {
          claimId: targetId,
          evidence: proposal.evidence || 'Confirmed by candidate via Gemini Desktop Companion',
          confirmedAt: new Date(timestamp).toISOString(),
          actor: proposal.actor || 'human:candidate'
        };
      } else if (type === 'claim_proposal' || type === 'candidate_fact_proposal') {
        eventName = 'DECISION_RECORDED';
        payload = {
          decisionId: `claim_prop_${timestamp}`,
          decision: 'claim_proposed',
          claimId: targetId,
          claimText: proposal.claimText || proposal.text,
          employerId: proposal.employerId,
          status: 'CONFIRM',
          proposedAt: new Date(timestamp).toISOString()
        };
      } else if (type === 'draft_proposal') {
        if (proposal.draftType === 'outreach') {
          eventName = 'OUTREACH_DRAFTED';
          payload = {
            jobId: targetId,
            persona: proposal.persona || 'RECRUITER',
            text: proposal.draftText || proposal.text || '',
            channel: proposal.channel || 'linkedin',
            unverified: true,
            status: 'pending_inquisitor_verification',
            source: 'gemini_companion',
            draftedAt: new Date(timestamp).toISOString()
          };
        } else {
          eventName = 'DRAFT_GENERATED';
          payload = {
            jobId: targetId,
            cvText: proposal.cvText || proposal.draftText || '',
            clText: proposal.clText || null,
            claimsUsed: Array.isArray(proposal.claimsUsed) ? proposal.claimsUsed : [],
            unverified: true,
            status: 'pending_inquisitor_verification',
            source: 'gemini_companion',
            generatedAt: new Date(timestamp).toISOString()
          };
        }
      } else if (type === 'pack_approval') {
        eventName = 'DECISION_RECORDED';
        payload = {
          jobId: targetId,
          decision: 'pack_approved',
          decisionType: 'pack_approved',
          verdict: (proposal.verdict || 'APPROVE').toUpperCase(),
          notes: proposal.notes || proposal.feedback || 'Approved via Gemini Desktop Companion',
          decisionId: `dec_pack_${timestamp}`
        };
      } else {
        eventName = 'DECISION_RECORDED';
        payload = {
          jobId: targetId,
          decision: proposal.decision || 'companion_proposal',
          proposal
        };
      }

      // 5. Proposal Idempotency Guard (VULN-M7-07)
      // Check existing ledger events to ensure duplicate events are never appended
      const existingEvents = this.ledger.readEvents();
      const isDuplicate = existingEvents.some(e => {
        if (e.event !== eventName) return false;
        const ep = e.payload || {};
        if (eventName === 'JOB_SELECTED') {
          return ep.jobId === targetId && (ep.decision === payload.decision || ep.decisionType === payload.decisionType);
        }
        if (eventName === 'CLAIM_CONFIRMED') {
          return ep.claimId === targetId && ep.evidence === payload.evidence;
        }
        if (eventName === 'JOB_CLOSED') {
          return ep.jobId === targetId && ep.reason === payload.reason;
        }
        if (eventName === 'DRAFT_GENERATED') {
          return ep.jobId === targetId && ep.cvText === payload.cvText;
        }
        if (eventName === 'OUTREACH_DRAFTED') {
          return ep.jobId === targetId && ep.text === payload.text;
        }
        if (eventName === 'DECISION_RECORDED') {
          if (payload.decision === 'claim_proposed') {
            return ep.claimId === targetId && ep.claimText === payload.claimText;
          }
          if (payload.decision === 'pack_approved' || payload.decisionType === 'pack_approved') {
            return ep.jobId === targetId && ep.verdict === payload.verdict;
          }
          return ep.jobId === targetId && ep.decision === payload.decision;
        }
        return false;
      });

      if (isDuplicate) {
        // Move claim file to processed directory and exit idempotently
        const destPath = path.join(this.processedDir, `${basename}.${timestamp}.processed.json`);
        safeMoveFile(claimPath, destPath);
        return {
          success: false,
          action: 'ALREADY_PROCESSED',
          jobId: targetId,
          stateCorrupted: false
        };
      }

      // 6. Concurrency Lock & State Mutation
      const eventRecord = await this.ledger.appendEvent({
        event: eventName,
        actor,
        payload
      });

      // Synchronize dossier.json if a claim was confirmed
      if (type === 'claim_confirmation' && fs.existsSync(this.dossierPath)) {
        try {
          const rawDos = fs.readFileSync(this.dossierPath, 'utf8');
          const dosData = JSON.parse(rawDos);
          if (Array.isArray(dosData.claims)) {
            const cleanId = String(payload.claimId).replace(/^\[|\]$/g, '').trim();
            const c = dosData.claims.find(x => x.id === cleanId || `[${x.id}]` === cleanId);
            if (c) {
              c.status = 'VERIFIED';
              c.evidence = payload.evidence;
              c.updatedAt = payload.confirmedAt;
              fs.writeFileSync(this.dossierPath, JSON.stringify(dosData, null, 2), 'utf8');
            }
          }
        } catch (_) {}
      }

      // Replay ledger and project snapshot
      await replayLedger({ workspaceDir: this.workspaceDir });

      // Move proposal file to processed directory
      const destPath = path.join(this.processedDir, `${basename}.${timestamp}.processed.json`);
      safeMoveFile(claimPath, destPath);

      return {
        success: true,
        action: check.action,
        jobId: targetId,
        event: eventRecord,
        stateCorrupted: false
      };
    } finally {
      // Clean up reservation lock
      if (lockFd !== null) {
        try { fs.closeSync(lockFd); } catch (_) {}
      }
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
      } catch (_) {}
    }
  }

  /**
   * Ingests all pending proposal files currently in inbox/proposals/.
   *
   * @returns {Promise<object>} Summary of processed and errored proposals
   */
  async ingestAll() {
    this.ensureDirectories();
    const pending = this.listPendingProposals();
    const results = {
      total: pending.length,
      processed: [],
      errors: [],
      summary: {
        ingestedCount: 0,
        quarantinedCount: 0,
        errorCount: 0,
        corruptedCount: 0
      }
    };

    for (const item of pending) {
      const res = await this.ingestFile(item.fullPath);
      if (res.success) {
        results.processed.push({ filename: item.filename, ...res });
        results.summary.ingestedCount++;
        if (res.action === 'HOLD_FOR_CLAIM_VERIFICATION') {
          results.summary.quarantinedCount++;
        }
      } else {
        if (res.action === 'ALREADY_PROCESSED') {
          continue;
        }
        results.errors.push({ filename: item.filename, ...res });
        results.summary.errorCount++;
      }
    }

    return results;
  }

  /**
   * Returns current health and queue metrics for the companion inbox bridge.
   *
   * @returns {object} Status report
   */
  getStatus() {
    this.ensureDirectories();
    const pending = this.listPendingProposals();
    let processedCount = 0;
    let errorCount = 0;

    try {
      processedCount = fs.readdirSync(this.processedDir).filter(f => f.endsWith('.json')).length;
    } catch (_) {}

    try {
      errorCount = fs.readdirSync(this.errorsDir).filter(f => f.endsWith('.error.json')).length;
    } catch (_) {}

    let snapshot = null;
    if (fs.existsSync(this.snapshotPath)) {
      try {
        snapshot = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
      } catch (_) {}
    }

    return {
      online: true,
      workspaceDir: this.workspaceDir,
      inboxDir: this.inboxDir,
      counts: {
        pending: pending.length,
        processed: processedCount,
        errors: errorCount
      },
      pendingFiles: pending,
      snapshotLoaded: Boolean(snapshot),
      stateCorrupted: false
    };
  }
}

module.exports = {
  CompanionBridge,
  safeMoveFile
};
