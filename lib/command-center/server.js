'use strict';

/**
 * JobHunt Crew — Local Command Center HTTP Server & REST API
 *
 * Implements:
 * 1. Strict 127.0.0.1 loopback binding with active remoteAddress & Host header validation.
 * 2. Polymorphic cryptographic session token authentication (X-Session-Token, Bearer, ?token=, Cookie).
 * 3. Complete REST API endpoints (/api/health, /api/snapshot, /api/decisions, /api/decision, /api/jobs, /api/runs, /api/export).
 * 4. Deterministic EventLedger recording with GuardrailEngine validation (human-only submission token).
 * 5. Static file serving with strict path traversal containment protection.
 * 6. Non-blocking graceful shutdown and zero external dependencies.
 *
 * @module lib/command-center/server
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventLedger } = require('../ledger/ledger');
const { replayLedger, reduceEvents } = require('../ledger/reducer');
const { GuardrailEngine } = require('../guardrails/engine');
const { CareerDossier } = require('../honest-cv/dossier');
const { exportDashboard, loadDossierForWorkspace, publicDossierView } = require('./exporter');
const { VERSION } = require('../cli/shared');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};

class CommandCenterServer {
  /**
   * @param {Object} [options]
   * @param {string} [options.workspaceDir] Workspace root directory (default: process.cwd())
   * @param {number} [options.port=8080] Port to listen on (0 for dynamic)
   * @param {string} [options.token] Session token (auto-generated if omitted)
   * @param {string} [options.publicDir] Static public directory
   */
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir ? path.resolve(options.workspaceDir) : process.cwd();
    this.requestedPort = options.port !== undefined ? parseInt(options.port, 10) : 8080;
    this.port = this.requestedPort;
    this.host = '127.0.0.1'; // Non-negotiable loopback binding
    this.token = options.token || crypto.randomBytes(24).toString('hex');
    this.publicDir = options.publicDir ? path.resolve(options.publicDir) : path.join(__dirname, 'public');

    this.crewDir = path.join(this.workspaceDir, '.crew');
    this.ledgerPath = path.join(this.crewDir, 'ledger.jsonl');
    this.snapshotPath = path.join(this.crewDir, 'snapshot.json');
    this.lockPath = path.join(this.crewDir, 'ledger.lock');
    this.dossierPath = path.join(this.workspaceDir, 'dossier.json');

    this.ledger = new EventLedger({
      workspaceDir: this.workspaceDir,
      ledgerPath: this.ledgerPath,
      lockPath: this.lockPath
    });

    this.server = null;
    this.startTime = null;
    this.sockets = new Set();
    this.decisionsLog = [];
  }

  /**
   * Constant-time string comparison preventing timing attacks.
   */
  _timingSafeMatch(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    const bufA = Buffer.from(provided);
    const bufB = Buffer.from(expected);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  /**
   * Extracts and validates the session token from headers, query params, or cookies.
   */
  _authenticate(req, parsedUrl) {
    // 1. X-Session-Token header
    const xToken = req.headers['x-session-token'];
    if (xToken && this._timingSafeMatch(xToken, this.token)) return true;

    // 2. Authorization: Bearer <token> header
    const auth = req.headers['authorization'];
    if (auth && typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const bearerToken = auth.slice(7).trim();
      if (this._timingSafeMatch(bearerToken, this.token)) return true;
    }

    // 3. Query parameter ?token=<token>
    const queryToken = parsedUrl.searchParams.get('token');
    if (queryToken && this._timingSafeMatch(queryToken, this.token)) return true;

    // 4. Session Cookie crew_session=<token>
    const cookieHeader = req.headers['cookie'];
    if (cookieHeader) {
      const match = cookieHeader.match(/(?:^|;\s*)crew_session=([^;]+)/);
      if (match && this._timingSafeMatch(match[1], this.token)) return true;
    }

    return false;
  }

  /**
   * Safe path resolution with directory containment check preventing traversal attacks.
   */
  _resolveSafePublicPath(urlPath) {
    let decoded;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch (_) {
      return null;
    }

    if (decoded.includes('\0')) return null;

    if (decoded === '/' || decoded === '') {
      decoded = '/index.html';
    }

    const cleanSuffix = path.normalize(decoded).replace(/^(\.\.[\/\\])+/, '');
    const resolvedPath = path.resolve(this.publicDir, '.' + cleanSuffix);

    const relative = path.relative(this.publicDir, resolvedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }

    return resolvedPath;
  }

  /**
   * Reads request body with a 1MB limit.
   */
  _readRequestBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      let bytes = 0;
      const MAX_BYTES = 1024 * 1024; // 1MB

      req.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          req.destroy(new Error('Payload too large'));
          reject(new Error('PAYLOAD_TOO_LARGE'));
          return;
        }
        body += chunk;
      });

      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  /**
   * Helper to write JSON responses with standard security headers.
   */
  _sendJson(res, statusCode, data) {
    const payload = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; img-src 'self' data:;",
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(payload);
  }

  /**
   * Reads the current state from snapshot.json or replays the ledger.
   */
  async _getSnapshotState(rebuild = false) {
    if (rebuild || !fs.existsSync(this.snapshotPath)) {
      return await replayLedger({
        workspaceDir: this.workspaceDir,
        ledgerPath: this.ledgerPath,
        snapshotPath: this.snapshotPath,
        rebuild: true
      });
    }

    try {
      const raw = fs.readFileSync(this.snapshotPath, 'utf8');
      return JSON.parse(raw);
    } catch (_) {
      return await replayLedger({
        workspaceDir: this.workspaceDir,
        ledgerPath: this.ledgerPath,
        snapshotPath: this.snapshotPath,
        rebuild: true
      });
    }
  }

  /**
   * Main HTTP request router.
   */
  async _handleRequest(req, res) {
    // 1. Loopback Address Verification
    const remote = req.socket.remoteAddress;
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!isLoopback) {
      req.socket.destroy();
      return;
    }

    // 2. Host header rebinding guard
    const hostHeader = req.headers['host'];
    if (hostHeader) {
      const hostOnly = hostHeader.split(':')[0].toLowerCase();
      if (hostOnly !== '127.0.0.1' && hostOnly !== 'localhost') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: Host header mismatch' }));
        return;
      }
    }

    const parsedUrl = new URL(req.url, `http://${this.host}`);
    const pathname = parsedUrl.pathname;

    // 3. Session Authentication Gate
    const isAuthenticated = this._authenticate(req, parsedUrl);
    if (!isAuthenticated) {
      res.writeHead(401, {
        'Content-Type': 'application/json; charset=utf-8',
        'WWW-Authenticate': 'Bearer realm="JobHunt Crew Command Center"',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
      });
      res.end(JSON.stringify({
        error: 'Unauthorized',
        message: 'Missing or invalid session token. Provide X-Session-Token header, Bearer token, or ?token= query parameter.'
      }));
      return;
    }

    // If query token is used on root, set session cookie for browser asset loading
    if (pathname === '/' && parsedUrl.searchParams.get('token')) {
      res.setHeader('Set-Cookie', `crew_session=${this.token}; HttpOnly; SameSite=Strict; Path=/`);
    }

    // 4. REST API Routing
    try {
      if (pathname === '/api/health' && req.method === 'GET') {
        return this._handleGetHealth(req, res);
      }
      if (pathname === '/api/snapshot' && req.method === 'GET') {
        return await this._handleGetSnapshot(req, res, parsedUrl);
      }
      if (pathname === '/api/decisions' && req.method === 'GET') {
        return await this._handleGetDecisions(req, res);
      }
      if (pathname === '/api/dossier' && req.method === 'GET') {
        return this._handleGetDossier(req, res);
      }
      if (pathname === '/api/decision' && req.method === 'POST') {
        return await this._handlePostDecision(req, res);
      }
      if (pathname === '/api/jobs' && req.method === 'GET') {
        return await this._handleGetJobs(req, res, parsedUrl);
      }
      if (pathname === '/api/runs' && req.method === 'GET') {
        return await this._handleGetRuns(req, res, parsedUrl);
      }
      if ((pathname === '/api/export' || pathname === '/export') && req.method === 'GET') {
        return await this._handleGetExport(req, res);
      }

      // API 404
      if (pathname.startsWith('/api/')) {
        return this._sendJson(res, 404, { error: `Endpoint not found: ${req.method} ${pathname}` });
      }

      // 5. Static File Serving
      return this._handleStaticFile(req, res, pathname);
    } catch (err) {
      console.error(`[COMMAND_CENTER_ERROR] ${err.message}`, err.stack);
      this._sendJson(res, 500, {
        error: 'Internal Server Error',
        message: err.message
      });
    }
  }

  // ==========================================================================
  // REST Endpoint Handlers
  // ==========================================================================

  _handleGetHealth(req, res) {
    const uptimeSeconds = this.startTime ? Number(((Date.now() - this.startTime) / 1000).toFixed(2)) : 0;
    const ledgerExists = fs.existsSync(this.ledgerPath);
    const snapshotExists = fs.existsSync(this.snapshotPath);

    let snapshotMeta = { exists: snapshotExists, lastEventId: 0, updatedAt: null };
    if (snapshotExists) {
      try {
        const snap = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
        snapshotMeta.lastEventId = snap.lastEventId || 0;
        snapshotMeta.updatedAt = snap.updatedAt || null;
      } catch (_) {}
    }

    this._sendJson(res, 200, {
      status: 'ok',
      server: 'jobhunt-crew-command-center',
      version: VERSION,
      uptimeSeconds,
      workspace: this.workspaceDir,
      timestamp: new Date().toISOString(),
      storage: {
        ledgerExists,
        ledgerPath: this.ledgerPath,
        ledgerSize: ledgerExists ? fs.statSync(this.ledgerPath).size : 0,
        snapshotExists,
        snapshotPath: this.snapshotPath,
        snapshotLastEventId: snapshotMeta.lastEventId,
        snapshotUpdatedAt: snapshotMeta.updatedAt
      },
      memory: process.memoryUsage()
    });
  }

  async _handleGetSnapshot(req, res, parsedUrl) {
    const rebuild = parsedUrl.searchParams.get('rebuild') === 'true';
    const state = await this._getSnapshotState(rebuild);
    this._sendJson(res, 200, state);
  }

  _handleGetDossier(req, res) {
    const dossier = loadDossierForWorkspace(this.workspaceDir);
    if (!dossier) {
      return this._sendJson(res, 404, { error: 'Dossier not found', dossier: null });
    }
    return this._sendJson(res, 200, publicDossierView(dossier));
  }

  async _handleGetDecisions(req, res) {
    const state = await this._getSnapshotState();
    const unconfirmedClaims = [];
    const shortlistedRoles = [];
    const readyPacks = [];
    const outreachPending = [];
    const excludedRoles = [];

    // 1. Unconfirmed Claims from dossier.json (.crew fallback, exporter order)
    {
      try {
        const parsed = loadDossierForWorkspace(this.workspaceDir);
        const claims = parsed && Array.isArray(parsed.claims) ? parsed.claims : [];
        for (const c of claims) {
          if (c.status === 'CONFIRM') {
            unconfirmedClaims.push({
              claimId: c.id,
              employerId: c.employerId,
              category: c.category,
              text: c.text,
              clarificationPrompt: c.clarificationPrompt,
              status: c.status
            });
          }
        }
      } catch (_) {}
    }

    // 2. Roles, Packs, Outreach, Exclusions from Snapshot
    const jobs = Object.values(state.jobs || {});
    for (const job of jobs) {
      if (job.status === 'shortlisted') {
        shortlistedRoles.push({
          jobId: job.id,
          title: job.title,
          company: job.company,
          location: job.location,
          score: job.score,
          url: job.canonicalUrl || job.url,
          channel: job.channel
        });
      } else if (job.status === 'excluded' || (job.status === 'closed' && job.closedReason === 'not_interested')) {
        excludedRoles.push({
          jobId: job.id,
          title: job.title,
          company: job.company,
          closedReason: job.closedReason
        });
      }
    }

    const apps = Object.values(state.applications || {});
    for (const app of apps) {
      if (app.status === 'ready' || (app.prefill && app.prefill.status === 'ready-to-submit')) {
        const job = state.jobs && state.jobs[app.jobId] ? state.jobs[app.jobId] : {};
        readyPacks.push({
          jobId: app.jobId,
          company: job.company || 'Enterprise',
          title: job.title || 'Role',
          applyPackPath: app.applyPackPath || `applications/${app.jobId}/apply-pack.md`,
          verdict: (app.review && app.review.verdict) || 'APPROVE',
          verifiedClaimsCount: app.draft && app.draft.claimsUsed ? app.draft.claimsUsed.length : 0
        });
      }
    }

    const outreachMap = state.outreach || {};
    for (const [jobId, out] of Object.entries(outreachMap)) {
      if (out && !out.approved) {
        outreachPending.push({
          jobId,
          persona: out.persona,
          channel: out.channel || 'linkedin',
          charCount: Array.from(out.text || '').length,
          text: out.text
        });
      }
    }

    const totalPending = unconfirmedClaims.length + shortlistedRoles.length + readyPacks.length + outreachPending.length;

    this._sendJson(res, 200, {
      totalPending,
      counts: {
        unconfirmedClaims: unconfirmedClaims.length,
        shortlistedRoles: shortlistedRoles.length,
        readyPacks: readyPacks.length,
        outreachPending: outreachPending.length,
        excludedRoles: excludedRoles.length
      },
      decisions: {
        unconfirmedClaims,
        shortlistedRoles,
        readyPacks,
        outreachPending,
        excludedRoles
      }
    });
  }

  async _handlePostDecision(req, res) {
    let rawBody = '';
    try {
      rawBody = await this._readRequestBody(req);
    } catch (_) {
      return this._sendJson(res, 400, { error: 'Request body exceeds 1MB limit' });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (_) {
      return this._sendJson(res, 400, { error: 'Malformed JSON payload' });
    }

    const decType = String(body.type || body.decision || body.action || '').toUpperCase();
    const jobId = body.jobId || (body.payload && body.payload.jobId);
    const claimId = body.claimId || (body.payload && body.payload.claimId);
    const actor = body.actor || 'human:web';
    const decisionId = body.id || `dec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    try {
      let eventName = 'DECISION_RECORDED';
      let payload = Object.assign({}, body.payload || {});

      if (decType === 'ROLE_SHORTLISTED' || decType === 'SHORTLIST' || decType === 'SELECT') {
        eventName = 'JOB_SELECTED';
        payload.jobId = jobId;
        payload.decision = 'apply';
        payload.decisionType = 'apply';
        payload.decisionId = decisionId;
      } else if (decType === 'ROLE_PARKED' || decType === 'PARK') {
        eventName = 'DECISION_RECORDED';
        payload.jobId = jobId;
        payload.decision = 'park';
        payload.decisionType = 'park';
        payload.decisionId = decisionId;
        payload.reason = body.reason || payload.reason || 'User parked via Command Center';
      } else if (decType === 'ROLE_EXCLUDED' || decType === 'EXCLUDE' || decType === 'NOT_INTERESTED') {
        eventName = 'JOB_CLOSED';
        payload.jobId = jobId;
        payload.reason = body.reason || payload.reason || 'not_interested';
        payload.evidence = {
          type: 'explicit_closure_notice',
          proof: 'User marked vacancy not interested via Command Center'
        };
      } else if (decType === 'CLAIM_CONFIRMED' || decType === 'CONFIRM_CLAIM') {
        eventName = 'CLAIM_CONFIRMED';
        payload.claimId = claimId;
        payload.evidence = body.evidence || payload.evidence || 'Confirmed by candidate via Command Center';
        payload.confirmedAt = new Date().toISOString();

        // Mutate dossier.json if present
        if (fs.existsSync(this.dossierPath) && claimId) {
          try {
            const rawDossier = fs.readFileSync(this.dossierPath, 'utf8');
            const dossier = JSON.parse(rawDossier);
            if (Array.isArray(dossier.claims)) {
              const c = dossier.claims.find(x => x.id === claimId || `[${x.id}]` === claimId);
              if (c) {
                c.status = 'VERIFIED';
                c.evidence = payload.evidence;
                c.updatedAt = payload.confirmedAt;
                fs.writeFileSync(this.dossierPath, JSON.stringify(dossier, null, 2), 'utf8');
              }
            }
          } catch (dErr) {
            console.warn(`[DOSSIER_SYNC_WARNING] ${dErr.message}`);
          }
        }
      } else if (decType === 'PACK_APPROVED' || decType === 'APPROVE_PACK') {
        eventName = 'DECISION_RECORDED';
        payload.jobId = jobId;
        payload.decision = 'pack_approved';
        payload.decisionType = 'pack_approved';
        payload.verdict = 'APPROVE';
        payload.decisionId = decisionId;
      } else if (decType === 'APPLICATION_SUBMITTED' || decType === 'MARK_SUBMITTED' || decType === 'SUBMIT') {
        eventName = 'APPLICATION_SUBMITTED';
        payload.jobId = jobId;
        const subToken = body.token || payload.token;

        // Guardrail verification (strict human-only submit)
        GuardrailEngine.validateSubmission(actor, jobId, subToken);
        payload.token = subToken;
        payload.submittedAt = new Date().toISOString();
      } else if (decType === 'OUTREACH_APPROVED' || decType === 'APPROVE_OUTREACH') {
        eventName = 'OUTREACH_APPROVED';
        payload.jobId = jobId;
        payload.persona = body.persona || payload.persona || 'RECRUITER';
        payload.text = body.text || payload.text || '';
        payload.approvedAt = new Date().toISOString();
      } else if (decType === 'EXCLUSION_RESTORED' || decType === 'RESTORE_EXCLUSION') {
        eventName = 'EXCLUSION_RESTORED';
        payload.jobId = jobId;
        payload.restoredAt = new Date().toISOString();
      } else {
        // Fallback generic recording
        eventName = 'DECISION_RECORDED';
        payload.decisionId = decisionId;
        payload.type = decType.toLowerCase();
        payload.jobId = jobId;
      }

      // Append event to ledger under atomic lock
      const recordedEvent = await this.ledger.appendEvent({
        event: eventName,
        actor,
        payload
      });

      // Synchronously update snapshot
      await replayLedger({
        workspaceDir: this.workspaceDir,
        ledgerPath: this.ledgerPath,
        snapshotPath: this.snapshotPath,
        rebuild: false
      });

      if (jobId && (eventName === 'JOB_SELECTED' || payload.decisionType === 'shortlist_confirm' || decType === 'SHORTLIST_CONFIRM')) {
        try {
          const state = await this._getSnapshotState();
          const snapJob = state.jobs ? state.jobs[jobId] : null;
          if (snapJob) {
            const { DiscoveryEngine } = require('../discovery');
            const engine = new DiscoveryEngine({ workspaceDir: this.workspaceDir });
            engine.archiveShortlistedJd(
              { ...snapJob, url: snapJob.canonicalUrl || snapJob.url, description: snapJob.description || (body.payload && body.payload.description) || body.description },
              { shortlisted: true, score: snapJob.score, verdict: 'shortlisted' },
              {}
            );
          }
        } catch (_) {}
      }

      this.decisionsLog.push(body);

      this._sendJson(res, 200, {
        status: 'recorded',
        decisionId,
        eventId: recordedEvent.id !== undefined ? recordedEvent.id : recordedEvent.seq,
        eventType: eventName,
        jobId: jobId || null,
        timestamp: recordedEvent.timestamp
      });
    } catch (gErr) {
      const isGuardrail = gErr.message && gErr.message.includes('GUARDRAIL_VIOLATION');
      this._sendJson(res, isGuardrail ? 400 : 500, {
        error: isGuardrail ? 'Guardrail Violation' : 'Decision Processing Error',
        message: gErr.message
      });
    }
  }

  async _handleGetJobs(req, res, parsedUrl) {
    const state = await this._getSnapshotState();
    let jobs = Object.values(state.jobs || {});

    // Filters
    const statusParam = parsedUrl.searchParams.get('status');
    if (statusParam && statusParam !== 'all') {
      const allowed = statusParam.split(',').map(s => s.trim().toLowerCase());
      jobs = jobs.filter(j => allowed.includes(String(j.status || '').toLowerCase()));
    }

    const minScore = parseFloat(parsedUrl.searchParams.get('minScore'));
    if (!isNaN(minScore)) {
      jobs = jobs.filter(j => typeof j.score === 'number' && j.score >= minScore);
    }

    const locationQuery = (parsedUrl.searchParams.get('location') || parsedUrl.searchParams.get('country') || '').toLowerCase();
    if (locationQuery) {
      jobs = jobs.filter(j => String(j.location || '').toLowerCase().includes(locationQuery));
    }

    const titleQuery = (parsedUrl.searchParams.get('title') || parsedUrl.searchParams.get('role') || '').toLowerCase();
    if (titleQuery) {
      jobs = jobs.filter(j => String(j.title || '').toLowerCase().includes(titleQuery));
    }

    const companyQuery = (parsedUrl.searchParams.get('company') || '').toLowerCase();
    if (companyQuery) {
      jobs = jobs.filter(j => String(j.company || '').toLowerCase().includes(companyQuery));
    }

    const channelQuery = (parsedUrl.searchParams.get('channel') || '').toLowerCase();
    if (channelQuery) {
      jobs = jobs.filter(j => String(j.channel || '').toLowerCase() === channelQuery);
    }

    // Sorting
    const sort = parsedUrl.searchParams.get('sort') || 'score_desc';
    jobs.sort((a, b) => {
      if (sort === 'score_desc') return (b.score || 0) - (a.score || 0);
      if (sort === 'score_asc') return (a.score || 0) - (b.score || 0);
      if (sort === 'date_desc') return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
      if (sort === 'date_asc') return new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0);
      if (sort === 'company_asc') return String(a.company || '').localeCompare(String(b.company || ''));
      if (sort === 'title_asc') return String(a.title || '').localeCompare(String(b.title || ''));
      return 0;
    });

    const total = Object.keys(state.jobs || {}).length;
    const filtered = jobs.length;
    const limit = Math.min(Math.max(parseInt(parsedUrl.searchParams.get('limit'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(parsedUrl.searchParams.get('offset'), 10) || 0, 0);

    const paginated = jobs.slice(offset, offset + limit);

    this._sendJson(res, 200, {
      total,
      filtered,
      limit,
      offset,
      jobs: paginated
    });
  }

  async _handleGetRuns(req, res, parsedUrl) {
    const limit = Math.min(Math.max(parseInt(parsedUrl.searchParams.get('limit'), 10) || 100, 1), 500);
    const fromId = parseInt(parsedUrl.searchParams.get('fromId'), 10) || undefined;
    const toId = parseInt(parsedUrl.searchParams.get('toId'), 10) || undefined;
    const actor = parsedUrl.searchParams.get('actor') || undefined;
    const event = parsedUrl.searchParams.get('event') || undefined;

    const events = this.ledger.readEvents({ limit, fromId, toId, actor, event });

    // Aggregate summary
    const agentSummary = {};
    for (const e of events) {
      const act = e.actor || 'system';
      if (!agentSummary[act]) {
        agentSummary[act] = { eventCount: 0, lastActive: e.timestamp };
      }
      agentSummary[act].eventCount++;
      if (new Date(e.timestamp) > new Date(agentSummary[act].lastActive)) {
        agentSummary[act].lastActive = e.timestamp;
      }
    }

    this._sendJson(res, 200, {
      totalEvents: events.length,
      returnedEvents: events.length,
      agentRunsSummary: agentSummary,
      events
    });
  }

  async _handleGetExport(req, res) {
    const state = await this._getSnapshotState();
    const result = await exportDashboard({
      workspace: this.workspaceDir,
      snapshot: state,
      publicDir: this.publicDir
    });

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(result.html),
      'Cache-Control': 'no-cache, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(result.html);
  }

  // ==========================================================================
  // Static Asset Serving
  // ==========================================================================

  _handleStaticFile(req, res, pathname) {
    const safePath = this._resolveSafePublicPath(pathname);
    if (!safePath) {
      return this._sendJson(res, 403, { error: 'Forbidden: Path traversal prohibited' });
    }

    if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
      const ext = path.extname(safePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const stream = fs.createReadStream(safePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
      });
      stream.pipe(res);
      return;
    }

    // SPA fallback: If client accepts text/html, serve index.html
    const acceptsHtml = (req.headers['accept'] || '').includes('text/html');
    const indexPath = path.join(this.publicDir, 'index.html');
    if (acceptsHtml && fs.existsSync(indexPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
      });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    this._sendJson(res, 404, { error: `File not found: ${pathname}` });
  }

  // ==========================================================================
  // Server Lifecycle Management
  // ==========================================================================

  /**
   * Starts the HTTP server on 127.0.0.1.
   * @returns {Promise<{port: number, host: string, token: string, url: string}>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));

      this.server.on('connection', socket => {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
      });

      this.server.listen(this.requestedPort, this.host, () => {
        const address = this.server.address();
        this.port = typeof address === 'object' ? address.port : this.requestedPort;
        this.startTime = Date.now();
        const accessUrl = `http://${this.host}:${this.port}/?token=${this.token}`;
        resolve({
          port: this.port,
          host: this.host,
          token: this.token,
          url: accessUrl
        });
      });

      this.server.on('error', reject);
    });
  }

  /**
   * Gracefully shuts down the HTTP server.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise(resolve => {
      if (!this.server) return resolve();

      this.server.close(() => {
        this.server = null;
        resolve();
      });

      setTimeout(() => {
        for (const socket of this.sockets) {
          socket.destroy();
        }
        this.sockets.clear();
        resolve();
      }, 2000).unref();
    });
  }

  getAddress() {
    return `http://${this.host}:${this.port}`;
  }

  getBaseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  getAuthUrl() {
    return `http://${this.host}:${this.port}/?token=${this.token}`;
  }
}

module.exports = {
  CommandCenterServer,
  MIME_TYPES
};
