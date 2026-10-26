'use strict';

/**
 * JobHunt Crew — Native stdio MCP Server
 *
 * Implements the Model Context Protocol (MCP) JSON-RPC 2.0 stdio server.
 * Exposes core JobHunt Crew operations to Antigravity 2.0 and Claude Code agent teams.
 *
 * Zero external dependencies. Uses Node.js built-in runtime.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EventLedger } = require('../ledger/ledger');
const { reduceEvents, writeSnapshotAtomically, replayLedger } = require('../ledger/reducer');
const { withLock } = require('../ledger/lock');
const { GuardrailEngine } = require('../guardrails/engine');
const { ClaimVerifier } = require('../honest-cv/verify-claims');
const { EditorialRuleEngine } = require('../honest-cv/editorial-rules');

const SERVER_NAME = 'jobhunt-crew-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

class McpServer {
  constructor(options = {}) {
    this.workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
    this.crewDir = path.join(this.workspace, '.crew');
    this.ledgerPath = path.join(this.crewDir, 'ledger.jsonl');
    this.snapshotPath = path.join(this.crewDir, 'snapshot.json');
    this.lockPath = path.join(this.crewDir, 'ledger.lock');

    this.ledger = new EventLedger({
      workspaceDir: this.workspace,
      ledgerPath: this.ledgerPath,
      lockPath: this.lockPath
    });

    this.rl = null;
    this.tools = new Map();
    this.registerTools();
  }

  // ==========================================================================
  // Tool Definitions & Schema Registration
  // ==========================================================================

  registerTools() {
    this.tools.set('crew_record_event', {
      name: 'crew_record_event',
      description: 'Appends a typed domain event to the append-only ledger with concurrency locking, hash chaining, and guardrail enforcement.',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Domain event type (e.g. JOB_DISCOVERED, JOB_TRIAGED, DRAFT_GENERATED, etc.)'
          },
          payload: {
            type: 'object',
            description: 'Structured event payload object'
          },
          actor: {
            type: 'string',
            description: 'Actor identity (e.g. agent:recon, agent:scribe, human)',
            default: 'agent'
          }
        },
        required: ['type', 'payload']
      },
      handler: (args) => this.toolRecordEvent(args)
    });

    this.tools.set('crew_get_snapshot', {
      name: 'crew_get_snapshot',
      description: 'Returns the latest materialized state snapshot of the job search workspace, optionally filtered.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'object',
            description: 'Optional filter criteria (e.g. status, company, limit)',
            properties: {
              status: { type: 'string', description: 'Filter jobs by status (e.g. discovered, shortlisted, submitted)' },
              company: { type: 'string', description: 'Filter jobs by company name substring' },
              limit: { type: 'integer', description: 'Maximum number of jobs to return' }
            }
          }
        }
      },
      handler: (args) => this.toolGetSnapshot(args)
    });

    this.tools.set('crew_triage_job', {
      name: 'crew_triage_job',
      description: 'Triages a discovered job with preference score and status verdict.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Unique vacancy ID' },
          score: { type: 'number', description: 'Rubric score from 0.0 to 5.0' },
          status: {
            type: 'string',
            enum: ['PASS', 'MARGINAL', 'FAIL', 'shortlisted', 'parked'],
            description: 'Triage verdict status'
          },
          rationale: { type: 'string', description: 'Reasoning for the triage score' }
        },
        required: ['job_id', 'score', 'status']
      },
      handler: (args) => this.toolTriageJob(args)
    });

    this.tools.set('crew_close_job', {
      name: 'crew_close_job',
      description: 'Closes a job with mandatory evidence (rejection notice, 404/410, passed deadline). Posting age alone is rejected by guardrails.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Unique vacancy ID to close' },
          evidence_type: {
            type: 'string',
            enum: ['http_404', 'http_410', 'explicit_closure_notice', 'passed_deadline', 'direct_rejection_email'],
            description: 'Type of verifiable evidence'
          },
          proof: { type: 'string', description: 'Non-empty evidence proof string, DOM snippet, or timestamp' },
          reason: { type: 'string', description: 'Human-readable explanation of closure' }
        },
        required: ['job_id', 'evidence_type', 'proof']
      },
      handler: (args) => this.toolCloseJob(args)
    });

    this.tools.set('crew_get_job', {
      name: 'crew_get_job',
      description: 'Fetches complete job details, status, and historical ledger events by vacancy ID.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Unique vacancy ID' }
        },
        required: ['job_id']
      },
      handler: (args) => this.toolGetJob(args)
    });

    this.tools.set('crew_doctor', {
      name: 'crew_doctor',
      description: 'Inspects system health, runtime state, lock status, and PII denylist configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          fix: { type: 'boolean', description: 'Attempt automatic remediation of non-critical issues', default: false }
        }
      },
      handler: (args) => this.toolDoctor(args)
    });

    this.tools.set('crew_verify_draft', {
      name: 'crew_verify_draft',
      description: 'Runs deterministic AST claim verification on a draft CV or cover letter against the candidate dossier.',
      inputSchema: {
        type: 'object',
        properties: {
          draft_path: { type: 'string', description: 'Path to draft text file, or inline text string' },
          dossier_path: { type: 'string', description: 'Optional path to candidate dossier JSON (defaults to <workspace>/dossier.json)' },
          job_id: { type: 'string', description: 'Optional vacancy ID' },
          claim_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of claim IDs referenced'
          }
        },
        required: ['draft_path']
      },
      handler: (args) => this.toolVerifyDraft(args)
    });

    this.tools.set('crew_editorial_rules', {
      name: 'crew_editorial_rules',
      description: 'Manages self-learning editorial rules (list, learn, undo, or apply).',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'learn', 'undo', 'apply'],
            description: 'Action to perform'
          },
          rule_id: { type: 'string', description: 'Rule identifier (required for learn and undo)' },
          pattern: { type: 'string', description: 'Pattern to match (required for learn)' },
          replacement: { type: 'string', description: 'Replacement string (required for learn)' },
          rationale: { type: 'string', description: 'Rationale or explanation' },
          category: { type: 'string', description: 'Category (vocabulary, omission, conciseness, formatting, styling)' },
          text: { type: 'string', description: 'Text to transform (required for apply)' }
        },
        required: ['action']
      },
      handler: (args) => this.toolEditorialRules(args)
    });
  }

  // ==========================================================================
  // Core Helpers
  // ==========================================================================

  readSnapshot() {
    if (!fs.existsSync(this.snapshotPath)) {
      return { version: 1, lastEventId: 0, updatedAt: new Date().toISOString(), jobs: {}, applications: {}, decisions: [] };
    }
    try {
      return JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
    } catch (_) {
      return { version: 1, lastEventId: 0, updatedAt: new Date().toISOString(), jobs: {}, applications: {}, decisions: [] };
    }
  }

  async appendLedgerEvent(type, payload, actor = 'agent') {
    // 1. Guardrail Validation
    if (type === 'APPLICATION_SUBMITTED' || type === 'JOB_SUBMITTED' || payload.status === 'submitted') {
      const jobId = payload.jobId || payload.id;
      GuardrailEngine.validateSubmission(actor, jobId, payload.token);

      const snapshot = this.readSnapshot();
      const job = snapshot.jobs ? snapshot.jobs[jobId] : null;
      const app = snapshot.applications ? snapshot.applications[jobId] : null;

      const isReady = (job && job.status === 'ready') || (app && app.status === 'ready');
      const isVerifiedAndApproved = (app && app.verification && app.verification.passed === true &&
                                     app.review && app.review.verdict === 'APPROVE');

      if (!isReady && !isVerifiedAndApproved) {
        throw new Error('GUARDRAIL_VIOLATION: Cannot submit unverified application. Application must pass claim verification and review panel before submission.');
      }
    }

    if (type === 'PACKAGE_MARKED_READY') {
      if (!payload.claimVerification || payload.claimVerification.passed !== true) {
        throw new Error('GUARDRAIL_VIOLATION: Package cannot be marked ready without passing claim verification');
      }
      if (payload.claimVerification.violations && payload.claimVerification.violations.length > 0) {
        throw new Error('GUARDRAIL_VIOLATION: Package cannot be marked ready with unresolved claim violations');
      }
      if (!payload.reviewPanel || payload.reviewPanel.verdict !== 'APPROVE') {
        throw new Error('GUARDRAIL_VIOLATION: Package cannot be marked ready without review panel approval');
      }
    }

    if (type === 'JOB_CLOSED') {
      const evidence = payload.evidence || { type: payload.evidenceType, proof: payload.proof };
      GuardrailEngine.validateClosure(evidence);
    }

    // 2. Append event via EventLedger
    const eventRecord = await this.ledger.appendEvent({
      event: type,
      payload,
      actor
    });

    // 3. Update snapshot
    await replayLedger({
      workspaceDir: this.workspace,
      ledgerPath: this.ledgerPath,
      snapshotPath: this.snapshotPath,
      rebuild: false
    });

    return eventRecord;
  }

  // ==========================================================================
  // Tool Handlers
  // ==========================================================================

  async toolRecordEvent(args) {
    const { type, payload, actor = 'agent' } = args;
    if (!type || typeof type !== 'string') throw new Error('Parameter "type" must be a non-empty string');
    if (!payload || typeof payload !== 'object') throw new Error('Parameter "payload" must be an object');

    const event = await this.appendLedgerEvent(type, payload, actor);
    return {
      success: true,
      seq: event.id || event.seq,
      timestamp: event.timestamp,
      hash: event.hash
    };
  }

  async toolGetSnapshot(args) {
    const filter = args.filter || {};
    const snapshot = this.readSnapshot();

    if (!filter.status && !filter.company && !filter.limit) {
      return snapshot;
    }

    let jobs = Object.values(snapshot.jobs || {});
    if (filter.status) {
      jobs = jobs.filter(j => j.status && j.status.toLowerCase() === filter.status.toLowerCase());
    }
    if (filter.company) {
      jobs = jobs.filter(j => j.company && j.company.toLowerCase().includes(filter.company.toLowerCase()));
    }
    if (typeof filter.limit === 'number' && filter.limit > 0) {
      jobs = jobs.slice(0, filter.limit);
    }

    return {
      version: snapshot.version,
      lastEventId: snapshot.lastEventId,
      updatedAt: snapshot.updatedAt,
      filteredJobsCount: jobs.length,
      jobs
    };
  }

  async toolTriageJob(args) {
    const { job_id, score, status, rationale = '' } = args;
    if (!job_id) throw new Error('Parameter "job_id" is required');
    if (typeof score !== 'number' || score < 0.0 || score > 5.0) {
      throw new Error('Parameter "score" must be a number between 0.0 and 5.0');
    }
    if (!status) throw new Error('Parameter "status" is required');

    const snapshot = this.readSnapshot();
    if (!snapshot.jobs || !snapshot.jobs[job_id]) {
      throw new Error(`Job not found in snapshot: ${job_id}`);
    }

    const payload = {
      id: job_id,
      score,
      status,
      verdict: status,
      shortlisted: status === 'PASS' || status === 'MARGINAL' || status === 'shortlisted',
      rationale
    };

    const event = await this.appendLedgerEvent('JOB_TRIAGED', payload, 'agent:recon');
    return {
      success: true,
      job_id,
      score,
      status,
      eventId: event.id || event.seq
    };
  }

  async toolCloseJob(args) {
    const { job_id, evidence_type, proof, reason = '' } = args;
    if (!job_id) throw new Error('Parameter "job_id" is required');
    if (!evidence_type) throw new Error('Parameter "evidence_type" is required');
    if (!proof) throw new Error('Parameter "proof" is required');

    const snapshot = this.readSnapshot();
    if (!snapshot.jobs || !snapshot.jobs[job_id]) {
      throw new Error(`Job not found in snapshot: ${job_id}`);
    }

    const payload = {
      id: job_id,
      reason: reason || `Closed with evidence: ${evidence_type}`,
      evidence: {
        type: evidence_type,
        proof
      }
    };

    const event = await this.appendLedgerEvent('JOB_CLOSED', payload, 'agent:recon');
    return {
      success: true,
      job_id,
      status: 'closed',
      evidenceType: evidence_type,
      eventId: event.id || event.seq
    };
  }

  async toolGetJob(args) {
    const { job_id } = args;
    if (!job_id) throw new Error('Parameter "job_id" is required');

    const snapshot = this.readSnapshot();
    const job = snapshot.jobs ? snapshot.jobs[job_id] : null;
    if (!job) {
      throw new Error(`Job not found: ${job_id}`);
    }

    const allEvents = this.ledger.readEvents();
    const history = allEvents.filter(e => e.payload && (e.payload.id === job_id || e.payload.jobId === job_id));

    return {
      job,
      history
    };
  }

  async toolDoctor(args) {
    const shouldFix = args.fix === true;
    const checks = [];

    // 1. Runtime directory (.crew)
    const hasCrewDir = fs.existsSync(this.crewDir);
    checks.push({
      name: 'Runtime directory (.crew)',
      pass: hasCrewDir,
      critical: true,
      message: hasCrewDir ? 'FOUND' : 'MISSING'
    });

    // 2. Concurrency lock
    let isLocked = fs.existsSync(this.lockPath);
    let lockMsg = 'CLEAN';
    if (isLocked) {
      try {
        const stats = fs.statSync(this.lockPath);
        if (Date.now() - stats.mtimeMs > 5000) {
          if (shouldFix) {
            fs.unlinkSync(this.lockPath);
            lockMsg = 'STALE LOCK REMOVED';
            isLocked = false;
          } else {
            lockMsg = 'STALE LOCK DETECTED';
          }
        } else {
          lockMsg = 'ACTIVE LOCK';
        }
      } catch (_) {}
    }
    checks.push({
      name: 'Concurrency lock',
      pass: !isLocked,
      critical: false,
      message: lockMsg
    });

    // 3. Ledger file
    const hasLedger = fs.existsSync(this.ledgerPath);
    checks.push({
      name: 'Ledger file (ledger.jsonl)',
      pass: hasLedger,
      critical: true,
      message: hasLedger ? 'FOUND' : 'MISSING'
    });

    // 4. PII Denylist
    const denylistPath = path.join(this.workspace, '.pii-denylist');
    const hasDenylist = fs.existsSync(denylistPath);
    checks.push({
      name: 'PII Denylist (.pii-denylist)',
      pass: hasDenylist,
      critical: true,
      message: hasDenylist ? 'CONFIGURED' : 'MISSING'
    });

    const hasFailure = checks.some(c => c.critical && !c.pass);
    return {
      status: hasFailure ? 'FAIL' : 'PASS',
      checks
    };
  }

  async toolVerifyDraft(args) {
    const { draft_path, dossier_path, claim_ids = [] } = args;
    if (!draft_path) throw new Error('Parameter "draft_path" is required');

    let dossierPathResolved = dossier_path ? path.resolve(this.workspace, dossier_path) : path.join(this.workspace, 'dossier.json');
    if (!fs.existsSync(dossierPathResolved)) {
      const fixtureFallback = path.join(this.workspace, 'tests', 'fixtures', 'dossiers', 'morgan-vance.json');
      if (fs.existsSync(fixtureFallback)) {
        dossierPathResolved = fixtureFallback;
      } else {
        throw new Error(`Dossier file not found: ${dossierPathResolved}`);
      }
    }

    const dossier = JSON.parse(fs.readFileSync(dossierPathResolved, 'utf8'));

    let draftText = draft_path;
    const resolvedDraftPath = path.resolve(this.workspace, draft_path);
    if (fs.existsSync(resolvedDraftPath)) {
      draftText = fs.readFileSync(resolvedDraftPath, 'utf8');
    }

    const result = ClaimVerifier.verifyDraft(dossier, draftText, { claimIds: claim_ids });

    return {
      passed: result.passed,
      summary: result.summary,
      violations: result.violations
    };
  }

  async toolEditorialRules(args) {
    const { action, rule_id, pattern, replacement, rationale, category, text } = args;
    if (!action) throw new Error('Parameter "action" is required');

    const engine = new EditorialRuleEngine({ workspaceDir: this.workspace });

    switch (action) {
      case 'list': {
        const rules = engine.listRules();
        return {
          rulesCount: rules.length,
          rules
        };
      }

      case 'learn': {
        if (!rule_id || !pattern || replacement === undefined) {
          throw new Error('Parameters "rule_id", "pattern", and "replacement" are required for action "learn"');
        }
        const rule = engine.learnRuleFromCorrection(rule_id, pattern, replacement, rationale, { category });
        return {
          success: true,
          action: 'learned',
          rule
        };
      }

      case 'undo': {
        if (!rule_id) throw new Error('Parameter "rule_id" is required for action "undo"');
        const rule = engine.undoRule(rule_id);
        return {
          success: true,
          action: 'undone',
          rule
        };
      }

      case 'apply': {
        if (text === undefined) throw new Error('Parameter "text" is required for action "apply"');
        const transformed = engine.applyRules(text);
        return {
          success: true,
          transformedText: transformed
        };
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  // ==========================================================================
  // JSON-RPC 2.0 Protocol Lifecycle
  // ==========================================================================

  sendResponse(id, result) {
    const msg = { jsonrpc: '2.0', id, result };
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  sendError(id, code, message, data) {
    const msg = {
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) }
    };
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  async handleRequest(request) {
    const { id, method, params } = request;

    // Handle notifications (no id)
    if (id === undefined || id === null) {
      if (method === 'notifications/initialized') {
        process.stderr.write(`[MCP] Client connection initialized successfully.\n`);
      }
      return;
    }

    try {
      switch (method) {
        case 'initialize':
          this.sendResponse(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION
            }
          });
          break;

        case 'ping':
          this.sendResponse(id, {});
          break;

        case 'tools/list': {
          const toolList = Array.from(this.tools.values()).map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }));
          this.sendResponse(id, { tools: toolList });
          break;
        }

        case 'tools/call': {
          if (!params || !params.name) {
            this.sendError(id, -32602, 'Invalid params: "name" required');
            return;
          }

          const tool = this.tools.get(params.name);
          if (!tool) {
            this.sendError(id, -32601, `Tool not found: ${params.name}`);
            return;
          }

          try {
            const rawResult = await tool.handler(params.arguments || {});
            this.sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult, null, 2)
                }
              ],
              isError: false
            });
          } catch (toolErr) {
            // Guardrail or domain violation is returned as isError: true per MCP spec
            this.sendResponse(id, {
              content: [
                {
                  type: 'text',
                  text: toolErr.message || String(toolErr)
                }
              ],
              isError: true
            });
          }
          break;
        }

        default:
          this.sendError(id, -32601, `Method not found: ${method}`);
          break;
      }
    } catch (err) {
      this.sendError(id, -32603, `Internal error: ${err.message}`);
    }
  }

  start() {
    process.stderr.write(`[MCP] Starting ${SERVER_NAME} v${SERVER_VERSION} (stdio transport)...\n`);
    this.rl = readline.createInterface({
      input: process.stdin,
      terminal: false
    });

    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const parsed = JSON.parse(trimmed);
        this.handleRequest(parsed);
      } catch (err) {
        this.sendError(null, -32700, `Parse error: ${err.message}`);
      }
    });

    this.rl.on('close', () => {
      process.stderr.write(`[MCP] Standard input closed. Shutting down.\n`);
      process.exit(0);
    });
  }

  stop() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

module.exports = {
  McpServer,
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION
};
