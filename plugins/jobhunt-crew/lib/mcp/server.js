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
const { DiscoveryEngine, BrowserSweeps, ATS_REGISTRY } = require('../discovery');
const { ApplyPackGenerator } = require('../honest-cv/apply-pack');
const { BlindReviewPanel } = require('../honest-cv/review-panel');
const { OutreachGenerator } = require('../crew/outreach');
const { StarRStoryBank } = require('../crew/interview-story-bank');
const { KsaOfferCalculator } = require('../crew/ksa-offer');
const { CadenceEngine } = require('../crew/cadence');
const { createBackup, restoreBackup } = require('../operational/backup');
const { scanClosingSoonAlerts } = require('../operational/alerts');
const { generateRetrospective } = require('../operational/retrospective');
const { exportDashboard } = require('../command-center/exporter');
const { ContactTracker } = require('../operational/contacts');
const { normalizeJobUrl, checkDuplicateRequisition, generateRequisitionKey } = require('../guardrails/dedup');
const { resolveWorkspace, workspaceRefusal } = require('../cli/shared');

// lib/operational/migrate-legacy.js is owned by another workstream and may not
// exist yet. Resolve it lazily so the server still starts without it.
function loadMigrateLegacy() {
  try {
    return require('../operational/migrate-legacy');
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
}

// A one-line value ending in a document extension is a path, not inline draft text:
// verifying the literal path string would "pass" with zero claims checked.
function looksLikeMissingFile(value) {
  return typeof value === 'string' && !/[\r\n]/.test(value) && /\.(md|markdown|txt|html?|json|docx?|pdf|rtf)$/i.test(value.trim());
}

const STORIES_FILE = 'stories.json';

/**
 * Loads interview stories saved by crew_interview_story into the bank and
 * returns the saved list. A story whose claim no longer validates against the
 * dossier is skipped rather than failing every story call.
 */
function loadSavedStories(workspace, bank) {
  const file = path.join(workspace, '.crew', STORIES_FILE);
  let saved = [];
  try {
    if (fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { saved = []; }
  if (!Array.isArray(saved)) saved = [];
  for (const story of saved) {
    try { bank.addStory({ ...story }); } catch (_) {}
  }
  return saved;
}

const SERVER_NAME = 'jobhunt-crew-mcp';
const SERVER_VERSION = '0.2.10';
const PROTOCOL_VERSION = '2024-11-05';
// Versions this server can speak; echo the client's if listed, else fall back.
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

class McpServer {
  constructor(options = {}) {
    // Precedence: explicit option (the --workspace flag), CREW_WORKSPACE, then cwd.
    this.workspace = resolveWorkspace({ workspace: options.workspace }, { guard: false });
    // Hosts launch MCP servers from the plugin folder or the home directory; refuse to write .crew/ there.
    this.workspaceError = workspaceRefusal(this.workspace);
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
      description: 'Inspects system health, runtime state, lock status, and PII denylist configuration. Reports the absolute workspace folder in use and whether a candidate dossier exists there.',
      inputSchema: {
        type: 'object',
        properties: {
          fix: { type: 'boolean', description: 'Attempt automatic remediation of non-critical issues', default: false }
        }
      },
      handler: (args) => this.toolDoctor(args)
    });

    this.tools.set('crew_confirm_claims', {
      name: 'crew_confirm_claims',
      description: 'Marks dossier claims as VERIFIED. Call ONLY after the candidate has confirmed each of those facts in this conversation; never to unblock a draft on your own. Unconfirmed claims block verification and packaging.',
      inputSchema: {
        type: 'object',
        properties: {
          claim_ids: { type: 'array', items: { type: 'string' }, description: 'Claim IDs the candidate confirmed' },
          all: { type: 'boolean', description: 'Confirm every claim (only when the candidate reviewed the full list)' },
          evidence: { type: 'string', description: 'Optional note on how the candidate confirmed it' },
          dossier_path: { type: 'string', description: 'Optional path to candidate dossier JSON' }
        }
      },
      handler: (args) => {
        const { confirmClaimsInFile, findDossierFile } = require('../cli/commands/claim');
        const ids = args.all === true ? 'all' : (Array.isArray(args.claim_ids) ? args.claim_ids : []);
        if (ids !== 'all' && ids.length === 0) throw new Error('Provide "claim_ids" or "all": true');
        const file = findDossierFile(this.workspace, args.dossier_path);
        if (!fs.existsSync(file)) throw new Error(`Dossier file not found: ${file}`);
        return confirmClaimsInFile(file, ids, args.evidence);
      }
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
          company: { type: 'string', description: 'Optional target employer name (taken from job_id when omitted)' },
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

    this.tools.set('crew_discover_sweep', {
      name: 'crew_discover_sweep',
      description: 'Sweeps one ATS board (greenhouse, lever, ashby, workday, smartrecruiters, oracle, ...) for live vacancies via DiscoveryEngine.sweepAts. Set ingest=true to record new vacancies in the ledger (deduplicated against tracked jobs).',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: 'ATS provider key' },
          target: {
            type: ['string', 'object'],
            description: 'Board token or company slug (string), or a board config object: Workday { tenant, dc, site }, Oracle { host, site }'
          },
          limit: { type: 'integer', description: 'Optional maximum vacancies to return' },
          ingest: { type: 'boolean', description: 'Record each new vacancy as a JOB_DISCOVERED ledger event', default: false }
        },
        required: ['provider', 'target']
      },
      handler: (args) => this.toolDiscoverSweep(args)
    });

    this.tools.set('crew_discover_smoke', {
      name: 'crew_discover_smoke',
      description: 'Smoke-checks discovery surfaces: lists ATS providers and attended browser boards, and evaluates a board session probe when supplied.',
      inputSchema: {
        type: 'object',
        properties: {
          board: { type: 'string', description: 'Optional browser board key (linkedin, bayt, gulftalent, naukrigulf, indeed)' },
          html: { type: 'string', description: 'Optional probed page HTML for session health evaluation' },
          logged_in_found: { type: 'boolean', description: 'Optional DOM probe: logged-in selector found' },
          login_wall_found: { type: 'boolean', description: 'Optional DOM probe: login wall selector found' }
        }
      },
      handler: (args) => this.toolDiscoverSmoke(args)
    });

    this.tools.set('crew_review_record', {
      name: 'crew_review_record',
      description: 'Records a blind review verdict for a job application into the append-only ledger as BLIND_REVIEW_RECORDED.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Vacancy ID the review belongs to' },
          verdict: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES'], description: 'Review panel verdict' },
          overall_score: { type: 'number', description: 'Overall panel score 0.0 to 5.0' },
          mode: { type: 'string', enum: ['standard', 'fast_lane'], description: 'Review mode used' },
          recommendations: { type: 'array', items: { type: 'string' }, description: 'Top panel recommendations' }
        },
        required: ['job_id', 'verdict']
      },
      handler: (args) => this.toolReviewRecord(args)
    });

    this.tools.set('crew_backup', {
      name: 'crew_backup',
      description: 'Creates a checksum-verified JSON backup of the .crew workspace directory plus dossier.json and search-config.json.',
      inputSchema: {
        type: 'object',
        properties: {
          out_file: { type: 'string', description: 'Optional output backup file path' }
        }
      },
      handler: (args) => this.toolBackup(args)
    });

    this.tools.set('crew_restore', {
      name: 'crew_restore',
      description: 'Restores a crew backup archive after checksum and ledger-chain verification.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to the backup archive JSON' }
        },
        required: ['file']
      },
      handler: (args) => this.toolRestore(args)
    });

    this.tools.set('crew_alerts', {
      name: 'crew_alerts',
      description: 'Scans the snapshot for open vacancies whose deadlines fall inside the alert window (default 48 hours).',
      inputSchema: {
        type: 'object',
        properties: {
          window_hours: { type: 'number', description: 'Alert window in hours', default: 48 }
        }
      },
      handler: (args) => this.toolAlerts(args)
    });

    this.tools.set('crew_retro', {
      name: 'crew_retro',
      description: 'Generates a retrospective funnel report from recent ledger events (default window 7 days).',
      inputSchema: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: 'Lookback window in days', default: 7 }
        }
      },
      handler: (args) => this.toolRetro(args)
    });

    this.tools.set('crew_export', {
      name: 'crew_export',
      description: 'Exports the offline single-file command-center dashboard HTML for the current snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          out_file: { type: 'string', description: 'Optional destination HTML file path' }
        }
      },
      handler: (args) => this.toolExport(args)
    });

    this.tools.set('crew_apply_pack', {
      name: 'crew_apply_pack',
      description: 'Builds a Stage 7 apply pack (screening answers, attended pre-fill plan, apply-pack.md) that stops at ready-to-submit.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Optional tracked vacancy ID (company, title, URL read from snapshot)' },
          company: { type: 'string', description: 'Employer name (required when job_id is absent)' },
          role_title: { type: 'string', description: 'Role title (required when job_id is absent)' },
          job_url: { type: 'string', description: 'Posting URL' },
          claims_used: { type: 'array', items: { type: 'string' }, description: 'Verified claim IDs cited in the pack' },
          review_verdict: { type: 'object', description: 'Optional blind review result object to embed' },
          cover_letter_text: { type: 'string', description: 'Final cover letter text; re-verified here, then saved in the pack folder as CoverLetter_<slug>.docx unless a different file of that name exists (it is kept and the pack returns blocked)' }
        }
      },
      handler: (args) => this.toolApplyPack(args)
    });

    this.tools.set('crew_read_resume', {
      name: 'crew_read_resume',
      description: 'Reads a resume file (.docx, .txt or .md) from the workspace folder and returns its text. PDF is not supported.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Resume file path inside the workspace folder' }
        },
        required: ['file']
      },
      handler: (args) => this.toolReadResume(args)
    });

    this.tools.set('crew_blind_review', {
      name: 'crew_blind_review',
      description: 'Runs the candidate-isolated dual-persona (Recruiter and Hiring Manager) blind review on a draft.',
      inputSchema: {
        type: 'object',
        properties: {
          job_title: { type: 'string', description: 'Target role title' },
          company: { type: 'string', description: 'Target employer' },
          requirements_text: { type: 'string', description: 'Job requirements text' },
          draft_text: { type: 'string', description: 'Draft document text (or use draft_path)' },
          draft_path: { type: 'string', description: 'Path to draft file (alternative to draft_text)' },
          document_type: { type: 'string', enum: ['cv', 'cover_letter'], description: 'Draft document type', default: 'cv' },
          mode: { type: 'string', enum: ['standard', 'fast_lane'], description: 'Review depth', default: 'standard' },
          dossier_path: { type: 'string', description: 'Optional dossier path used to scrub identity and audit isolation' }
        }
      },
      handler: (args) => this.toolBlindReview(args)
    });

    this.tools.set('crew_outreach', {
      name: 'crew_outreach',
      description: 'Drafts a sub-300-character outreach note for a recruiter, hiring manager, or peer, grounded in one verified claim. Draft only.',
      inputSchema: {
        type: 'object',
        properties: {
          persona: { type: 'string', enum: ['RECRUITER', 'HIRING_MANAGER', 'PEER'], description: 'Recipient persona', default: 'RECRUITER' },
          job_id: { type: 'string', description: 'Optional tracked vacancy ID' },
          company: { type: 'string', description: 'Employer name when job_id is absent' },
          role_title: { type: 'string', description: 'Role title when job_id is absent' },
          claim_id: { type: 'string', description: 'Optional claim ID to ground the note' },
          dossier_path: { type: 'string', description: 'Optional dossier path' }
        }
      },
      handler: (args) => this.toolOutreach(args)
    });

    this.tools.set('crew_interview_story', {
      name: 'crew_interview_story',
      description: 'Manages STAR+R interview stories bound to dossier claims: list confirmed stories, validate and add a story (saved to .crew/stories.json), or compile an interview pack.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'pack'], description: 'Operation to perform' },
          story: { type: 'object', description: 'Story object for add (situation, task, action, result, reflection, claimId)' },
          job_id: { type: 'string', description: 'Optional tracked vacancy ID for pack context' },
          company: { type: 'string', description: 'Employer name for pack when job_id is absent' },
          role_title: { type: 'string', description: 'Role title for pack when job_id is absent' },
          selected_story_ids: { type: 'array', items: { type: 'string' }, description: 'Optional story IDs for pack' },
          dossier_path: { type: 'string', description: 'Optional dossier path' }
        },
        required: ['action']
      },
      handler: (args) => this.toolInterviewStory(args)
    });

    this.tools.set('crew_ksa_offer', {
      name: 'crew_ksa_offer',
      description: 'Saudi labor offer calculations: salary split, GOSI, end-of-service benefits, non-compete checks, or a full offer evaluation.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['evaluate', 'salary', 'gosi', 'eosb', 'noncompete'], description: 'Calculation to run' },
          total_salary: { type: 'number', description: 'Monthly gross salary (evaluate, salary)' },
          basic: { type: 'number', description: 'Monthly basic salary when gross is unknown' },
          housing: { type: 'number', description: 'Monthly housing allowance (gosi wage object)' },
          is_saudi_national: { type: 'boolean', description: 'GOSI nationality branch: true for a Saudi national; omitted or false means non-Saudi (expatriate)', default: false },
          monthly_wage: { type: 'number', description: 'Monthly actual wage for EOSB: basic + housing + transport + regular allowances (eosb)' },
          tenure_years: { type: 'number', description: 'Service years for EOSB (eosb, evaluate)' },
          separation_type: { type: 'string', enum: ['TERMINATION', 'CONTRACT_EXPIRY', 'RESIGNATION'], description: 'EOSB separation type (eosb, evaluate)' },
          probation_days: { type: 'integer', description: 'Probation length in days (evaluate)' },
          non_compete_months: { type: 'number', description: 'Non-compete duration in months' },
          non_compete_scope: { type: 'string', description: 'Non-compete geographic scope text' },
          transport: { type: 'number', description: 'Monthly transport allowance (evaluate)' },
          qiwa_notice_date: { type: 'string', description: 'Qiwa service-transfer notice date (evaluate)' },
          title: { type: 'string', description: 'Job title for localized-profession screening (evaluate)' }
        },
        required: ['action']
      },
      handler: (args) => this.toolKsaOffer(args)
    });

    this.tools.set('crew_cadence', {
      name: 'crew_cadence',
      description: 'Follow-up cadence tracking: evaluate all submitted applications for day-7 and day-14 touchpoints, or calculate one submission.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['evaluate', 'calculate'], description: 'Operation to perform', default: 'evaluate' },
          submission_date: { type: 'string', description: 'ISO submission date (required for calculate)' },
          reference_date: { type: 'string', description: 'Optional ISO reference date' },
          day7_sent: { type: 'boolean', description: 'Whether the day-7 follow-up was sent (calculate)' },
          day14_sent: { type: 'boolean', description: 'Whether the day-14 follow-up was sent (calculate)' }
        }
      },
      handler: (args) => this.toolCadence(args)
    });

    this.tools.set('crew_migrate_legacy', {
      name: 'crew_migrate_legacy',
      description: 'Imports a legacy job-search workspace into the crew ledger. Requires lib/operational/migrate-legacy.js; reports clearly when that module is not present.',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string', description: 'Path to the legacy workspace to import' },
          dry_run: { type: 'boolean', description: 'Preview the migration without writing', default: false }
        },
        required: ['source_path']
      },
      handler: (args) => this.toolMigrateLegacy(args)
    });

    this.tools.set('crew_contacts', {
      name: 'crew_contacts',
      description: 'Local recruiter contact book (.crew/contacts.jsonl): add, list, get, search, or record an interaction.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'get', 'search', 'record_interaction'], description: 'Operation to perform' },
          id: { type: 'string', description: 'Contact ID (get, record_interaction)' },
          name: { type: 'string', description: 'Contact name (add, or get by name)' },
          company: { type: 'string', description: 'Company name (add, list filter)' },
          role: { type: 'string', description: 'Contact role/title (add)' },
          persona: { type: 'string', description: 'Persona RECRUITER, HIRING_MANAGER, or PEER (add, list filter)' },
          email: { type: 'string', description: 'Email address (add)' },
          linkedin: { type: 'string', description: 'LinkedIn/profile URL (add)' },
          profile_url: { type: 'string', description: 'Profile URL (add)' },
          job_id: { type: 'string', description: 'Related vacancy ID (add, list filter)' },
          notes: { type: 'string', description: 'Notes (add)' },
          query: { type: 'string', description: 'Search query (search)' },
          channel: { type: 'string', description: 'Interaction channel (record_interaction)' },
          summary: { type: 'string', description: 'Interaction summary (record_interaction)' },
          next_follow_up_at: { type: 'string', description: 'Next follow-up ISO date' },
          last_contacted_at: { type: 'string', description: 'Last contacted ISO date (add)' }
        },
        required: ['action']
      },
      handler: (args) => this.toolContacts(args)
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

  loadDossier(dossierPathArg, { required = false } = {}) {
    if (dossierPathArg) {
      const resolved = path.resolve(this.workspace, dossierPathArg);
      if (!fs.existsSync(resolved)) {
        if (required) throw new Error(`Dossier file not found: ${resolved}`);
        return null;
      }
      return JSON.parse(fs.readFileSync(resolved, 'utf8'));
    }
    // Exporter order: .crew/dossier.json first, then <workspace>/dossier.json.
    const candidates = [
      path.join(this.workspace, '.crew', 'dossier.json'),
      path.join(this.workspace, 'dossier.json')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    }
    if (required) throw new Error(`Dossier file not found: ${path.join(this.workspace, 'dossier.json')}`);
    return null;
  }

  resolveJobRecord(args) {
    if (args.job_id) {
      const snapshot = this.readSnapshot();
      const job = snapshot.jobs ? snapshot.jobs[args.job_id] : null;
      if (!job) throw new Error(`Job not found in snapshot: ${args.job_id}`);
      return {
        id: job.id || args.job_id,
        company: job.company || args.company || '',
        title: job.title || args.role_title || '',
        url: job.canonicalUrl || job.url || args.job_url || '',
        score: job.score
      };
    }
    return {
      id: args.job_id || 'job_target',
      company: args.company || '',
      title: args.role_title || args.job_title || '',
      url: args.job_url || ''
    };
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

    if (type === 'FOLLOW_UP_SENT') GuardrailEngine.validateFollowUpSent(payload, this.readSnapshot());

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
      return { workspace: this.workspace, ...snapshot };
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
      workspace: this.workspace,
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

    const snapJob = snapshot.jobs[job_id];
    const event = await this.appendLedgerEvent('JOB_TRIAGED', payload, 'agent:recon');
    let archivedJd = null;
    if (payload.shortlisted) {
      try {
        const engine = new DiscoveryEngine({ workspaceDir: this.workspace });
        archivedJd = engine.archiveShortlistedJd(
          { ...snapJob, title: snapJob.title, company: snapJob.company, url: snapJob.canonicalUrl || snapJob.url, description: snapJob.description },
          { shortlisted: true, score, verdict: status },
          {}
        );
      } catch (_) { archivedJd = null; }
    }
    return {
      success: true,
      job_id,
      score,
      status,
      eventId: event.id || event.seq,
      archivedJd
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

    // 5. Candidate dossier (same lookup order as loadDossier)
    const dossierPath = [path.join(this.crewDir, 'dossier.json'), path.join(this.workspace, 'dossier.json')]
      .find(p => fs.existsSync(p)) || null;
    checks.push({
      name: 'Candidate dossier (dossier.json)',
      pass: Boolean(dossierPath),
      critical: false,
      message: dossierPath ? 'FOUND' : 'MISSING'
    });

    const hasFailure = checks.some(c => c.critical && !c.pass);
    return {
      status: hasFailure ? 'FAIL' : 'PASS',
      workspace: this.workspace,
      dossier: { exists: Boolean(dossierPath), path: dossierPath },
      checks
    };
  }

  async toolVerifyDraft(args) {
    const { draft_path, dossier_path, claim_ids = [] } = args;
    if (!draft_path) throw new Error('Parameter "draft_path" is required');

    // Same lookup as every other tool (.crew/dossier.json, then dossier.json); never a test fixture.
    const dossier = this.loadDossier(dossier_path, { required: true });

    let draftText = draft_path;
    const resolvedDraftPath = path.resolve(this.workspace, draft_path);
    if (fs.existsSync(resolvedDraftPath)) {
      draftText = fs.readFileSync(resolvedDraftPath, 'utf8');
    } else if (looksLikeMissingFile(draft_path)) {
      throw new Error(`Draft file not found: ${resolvedDraftPath}`);
    }

    // The employer being applied to is a legitimate name in a cover letter.
    const targetCompany = args.company ||
      (args.job_id && ((this.readSnapshot().jobs || {})[args.job_id] || {}).company) || undefined;
    const result = ClaimVerifier.verifyDraft(dossier, draftText, { claimIds: claim_ids, targetCompany });

    // With a job_id the verdict is recorded, so apply packs and the submit gate can see it.
    let recorded = false;
    if (args.job_id) {
      await this.appendLedgerEvent('CLAIMS_VERIFIED', {
        jobId: args.job_id,
        passed: result.passed === true,
        violationsCount: (result.violations || []).length,
        violations: result.violations || []
      }, 'agent:inquisitor');
      recorded = true;
    }

    return {
      passed: result.passed,
      summary: result.summary,
      violations: result.violations,
      recorded
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

  async toolDiscoverSweep(args) {
    const { provider, target, limit } = args;
    if (!provider) throw new Error('Parameter "provider" is required');
    if (!target || (typeof target !== 'string' && (typeof target !== 'object' || Array.isArray(target)))) {
      throw new Error('Parameter "target" is required: a board slug string, or an object such as { tenant, dc, site } (Workday) or { host, site } (Oracle)');
    }
    const ingest = args.ingest === true;
    const engine = new DiscoveryEngine({ workspaceDir: this.workspace });
    const result = await engine.sweepAts(provider, target, typeof limit === 'number' ? { limit } : {});
    const found = Array.isArray(result) ? result : (result && Array.isArray(result.jobs) ? result.jobs : []);
    const capped = typeof limit === 'number' && limit > 0 ? found.slice(0, limit) : found;

    // Same dedup/ingest steps as the CLI `discover sweep` (lib/cli/commands/discover.js).
    const existingJobs = Object.values(this.readSnapshot().jobs || {});
    const jobs = [];
    let ingested = 0;
    let duplicates = 0;
    for (const cand of capped) {
      const cleanUrl = normalizeJobUrl(cand.url);
      const reqKey = generateRequisitionKey(cand.company, cand.title, cleanUrl, {
        location: cand.location,
        requisitionId: cand.requisitionId
      });
      const candidateObj = {
        id: cand.id || `job_${reqKey.slice(0, 10)}`,
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
      const isDuplicate = checkDuplicateRequisition(existingJobs, candidateObj, { throwOnError: false }).isDuplicate;
      if (isDuplicate) duplicates++;
      else if (ingest) {
        await this.ledger.appendEvent({ event: 'JOB_DISCOVERED', payload: candidateObj, actor: 'agent:recon' });
        ingested++;
      }
      // Within one sweep a repeated posting counts as a duplicate whether or not it is ingested.
      if (!isDuplicate) existingJobs.push(candidateObj);
      // The model gets a slim row; rawPayload (full posting JSON) stays in the ledger only.
      jobs.push({
        id: candidateObj.id,
        title: candidateObj.title,
        company: candidateObj.company,
        location: candidateObj.location,
        url: candidateObj.url,
        postedAt: candidateObj.postedAt,
        remoteStatus: candidateObj.remoteStatus,
        department: candidateObj.department,
        duplicate: isDuplicate
      });
    }
    if (ingested > 0) {
      await replayLedger({ workspaceDir: this.workspace, ledgerPath: this.ledgerPath, snapshotPath: this.snapshotPath, rebuild: false });
    }
    return { provider, target, found: capped.length, ingested, duplicates, count: jobs.length, jobs };
  }

  async toolDiscoverSmoke(args) {
    const boards = BrowserSweeps.getTargetBoards();
    const atsProviders = ATS_REGISTRY
      ? (Array.isArray(ATS_REGISTRY) ? ATS_REGISTRY.map(p => p.id || p.name || String(p)) : Object.keys(ATS_REGISTRY))
      : [];
    const out = { atsProviders, browserBoards: boards };
    if (args.board) {
      out.board = BrowserSweeps.getBoardSpec(args.board);
      if (!out.board) throw new Error(`Unknown browser board: ${args.board}`);
      if (args.html || args.logged_in_found !== undefined || args.login_wall_found !== undefined) {
        out.session = BrowserSweeps.evaluateSessionHealth(args.board, {
          html: args.html || '',
          loggedInFound: args.logged_in_found,
          loginWallFound: args.login_wall_found
        });
      }
    }
    return out;
  }

  async toolReviewRecord(args) {
    const { job_id, verdict, overall_score, mode, recommendations } = args;
    if (!job_id) throw new Error('Parameter "job_id" is required');
    if (!verdict) throw new Error('Parameter "verdict" is required');
    // Same flat event the CLI `review record` writes; the reducer has no REVIEW_RECORDED case.
    const event = await this.appendLedgerEvent('BLIND_REVIEW_RECORDED', {
      jobId: job_id,
      verdict: String(verdict).toUpperCase(),
      score: typeof overall_score === 'number' ? overall_score : null,
      mode: mode || 'standard',
      recommendations: Array.isArray(recommendations) ? recommendations : []
    }, 'agent:critic');
    return { success: true, job_id, verdict, eventId: event.id || event.seq };
  }

  async toolBackup(args) {
    return createBackup({
      workspaceDir: this.workspace,
      // The archive holds the profile, so out_file must name a path inside the workspace.
      outFile: args.out_file ? this.resolveInWorkspace(args.out_file, 'Backup file') : undefined
    });
  }

  async toolRestore(args) {
    if (!args.file) throw new Error('Parameter "file" is required');
    return restoreBackup({
      file: path.resolve(this.workspace, args.file),
      workspaceDir: this.workspace
    });
  }

  async toolAlerts(args) {
    const windowHours = typeof args.window_hours === 'number' && args.window_hours > 0 ? args.window_hours : 48;
    const alerts = scanClosingSoonAlerts(this.readSnapshot(), windowHours);
    return { windowHours, count: alerts.length, alerts };
  }

  async toolRetro(args) {
    const days = typeof args.days === 'number' && args.days > 0 ? args.days : 7;
    const events = this.ledger.readEvents();
    return generateRetrospective(events, { days });
  }

  async toolExport(args) {
    const outFile = args.out_file
      ? path.resolve(this.workspace, args.out_file)
      : path.join(this.workspace, 'command-center-export.html');
    const result = await exportDashboard({ workspace: this.workspace, outFile });
    // Do not return the full HTML payload over MCP; report where it landed.
    return {
      outFile: result.outFile || outFile,
      sizeBytes: result.sizeBytes,
      exportedAt: result.exportedAt,
      lastEventId: result.lastEventId,
      jobCount: result.jobCount
    };
  }

  async toolApplyPack(args) {
    const job = this.resolveJobRecord(args);
    if (!job.company) throw new Error('Parameter "company" is required when job_id is absent or has no company');
    if (!job.title) throw new Error('Parameter "role_title" is required when job_id is absent or has no title');
    const dossier = this.loadDossier(args.dossier_path) || { candidate: {}, claims: [] };
    const screeningAnswers = ApplyPackGenerator.generateScreeningAnswers(dossier, job);
    const preFillPlan = ApplyPackGenerator.buildPreFillPlan(job, dossier);
    const snapshot = this.readSnapshot();
    const recorded = ApplyPackGenerator.checksFromApplication(
      job.id && snapshot.applications ? snapshot.applications[job.id] : null,
      job.id && snapshot.jobs ? snapshot.jobs[job.id] : null
    );
    const blockers = ApplyPackGenerator.submissionBlockers(recorded);
    // The letter saved in the pack must itself pass the verifier, whatever was verified earlier.
    const coverLetterText = typeof args.cover_letter_text === 'string' && args.cover_letter_text.trim() ? args.cover_letter_text : '';
    if (coverLetterText) {
      const check = ClaimVerifier.verifyDraft(dossier, coverLetterText, { targetCompany: job.company });
      if (check.passed !== true) {
        throw new Error(`GUARDRAIL_VIOLATION: cover_letter_text failed claim verification (${(check.violations || []).length} violations). Fix it, check it with crew_verify_draft, then build the pack.`);
      }
    }
    const written = ApplyPackGenerator.writeApplyPack(this.workspace, job.company, job.title, {
      jobUrl: job.url,
      matchScore: typeof job.score === 'number' ? job.score : undefined,
      claimsUsed: Array.isArray(args.claims_used) ? args.claims_used : [],
      reviewVerdict: this.packReviewVerdict(args.review_verdict, recorded.reviewVerdict),
      verification: recorded.verification,
      coverLetterText,
      blockers,
      screeningAnswers,
      preFillPlan
    });
    return {
      // "blocked" while a check is missing or a cover letter was not saved; a job already marked ready is not blocked by missing checks.
      status: blockers.length ? 'blocked' : 'ready-to-submit',
      blockers,
      slug: written.slug,
      filePath: written.filePath,
      relativePath: written.relativePath,
      artifacts: written.artifacts,
      artifactNotes: written.artifactNotes,
      screeningAnswers,
      safetyGate: preFillPlan.safetyGate
    };
  }

  /**
   * The review shown in a pack. The recorded verdict and score win and a
   * passed-in result only adds its detail; a verdict that is not recorded is
   * labelled so, because the submit gate will not accept it.
   */
  packReviewVerdict(passedIn, recorded) {
    const detail = passedIn && typeof passedIn === 'object' ? passedIn : null;
    if (!recorded) return detail && detail.verdict ? { ...detail, verdict: `${detail.verdict} (not recorded)` } : detail;
    return {
      ...(detail || {}),
      verdict: recorded.verdict,
      ...(recorded.overallScore != null ? { overallScore: recorded.overallScore } : {})
    };
  }

  /** Resolves a tool path argument and refuses a path that leaves the workspace. Links are not followed here (toolReadResume adds a realpath check). */
  resolveInWorkspace(value, label) {
    const file = path.resolve(this.workspace, String(value));
    const rel = path.relative(this.workspace, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`${label} must be inside the workspace folder.`);
    }
    return file;
  }

  async toolReadResume(args) {
    if (!args.file) throw new Error('Parameter "file" is required');
    // Workspace files only: this tool must not become a way to read arbitrary local files.
    const file = this.resolveInWorkspace(args.file, 'Resume file');
    const rel = path.relative(this.workspace, file);
    if (!['.docx', '.txt', '.md'].includes(path.extname(file).toLowerCase())) {
      throw new Error('Unsupported resume file type. Use .docx, .txt or .md, or paste the resume text instead.');
    }
    if (!fs.existsSync(file)) throw new Error(`Resume file not found: ${file}`);
    // A link or junction inside the workspace must not lead outside it.
    const realRel = path.relative(fs.realpathSync(this.workspace), fs.realpathSync(file));
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error('Resume file must be inside the workspace folder.');
    }
    if (fs.statSync(file).size > 5 * 1024 * 1024) {
      throw new Error('Resume file is larger than 5 MB. Paste the resume text instead.');
    }
    const { readResumeFile } = require('../honest-cv/intake-wizard');
    const text = readResumeFile(file);
    return { file: rel, characters: text.length, text };
  }

  async toolBlindReview(args) {
    let draftText = args.draft_text;
    if (!draftText && args.draft_path) {
      const resolved = path.resolve(this.workspace, args.draft_path);
      if (!fs.existsSync(resolved)) throw new Error(`Draft file not found: ${resolved}`);
      draftText = fs.readFileSync(resolved, 'utf8');
    }
    if (!draftText) throw new Error('Parameter "draft_text" or "draft_path" is required');
    const dossier = this.loadDossier(args.dossier_path);
    return BlindReviewPanel.evaluate(
      { title: args.job_title || '', company: args.company || '', requirementsText: args.requirements_text || '' },
      { type: args.document_type || 'cv', content: draftText },
      { mode: args.mode || 'standard', ...(dossier ? { dossier } : {}) }
    );
  }

  async toolOutreach(args) {
    const job = this.resolveJobRecord(args);
    const dossier = this.loadDossier(args.dossier_path) || {};
    return OutreachGenerator.generateOutreach({
      persona: args.persona || 'RECRUITER',
      jobRecord: { company: job.company || undefined, title: job.title || undefined },
      dossier,
      claimId: args.claim_id || undefined
    });
  }

  async toolInterviewStory(args) {
    const { action } = args;
    if (!action) throw new Error('Parameter "action" is required');
    const dossier = this.loadDossier(args.dossier_path) || {};
    const bank = new StarRStoryBank(dossier);
    const saved = loadSavedStories(this.workspace, bank);
    switch (action) {
      case 'list':
        return { stories: bank.getStoriesForRole({}) };
      case 'add': {
        if (!args.story || typeof args.story !== 'object') throw new Error('Parameter "story" is required for action "add"');
        // Own id namespace: the bank numbers id-less dossier stories by position, which would collide with saved ones.
        let id = args.story.id;
        for (let n = saved.length + 1; !id; n++) {
          if (!bank.stories.has(`saved_story_${n}`)) id = `saved_story_${n}`;
        }
        const validated = bank.addStory({ ...args.story, id });
        // StarRStoryBank is in-memory, so added stories are kept in .crew/stories.json (same id replaces).
        // The input is stored, not the validated copy, so status and rubric are re-derived from the dossier on each load.
        const storiesPath = path.join(this.crewDir, STORIES_FILE);
        fs.mkdirSync(this.crewDir, { recursive: true });
        fs.writeFileSync(storiesPath, JSON.stringify([...saved.filter(s => s.id !== id), { ...args.story, id }], null, 2), 'utf8');
        return { success: true, persisted: true, storiesPath, story: validated };
      }
      case 'pack': {
        const job = this.resolveJobRecord(args);
        return bank.generateInterviewPack(
          { company: job.company || undefined, title: job.title || undefined },
          Array.isArray(args.selected_story_ids) ? args.selected_story_ids : null
        );
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async toolKsaOffer(args) {
    const { action } = args;
    if (!action) throw new Error('Parameter "action" is required');
    // Not stated means non-Saudi (expatriate), the same default as the CLI and the library.
    const isSaudi = args.is_saudi_national === true;
    switch (action) {
      case 'salary': {
        const amount = typeof args.total_salary === 'number' ? args.total_salary : args.basic;
        if (typeof amount !== 'number') throw new Error('Parameter "total_salary" (or "basic") is required for action "salary"');
        return KsaOfferCalculator.calculateSalaryStructure(amount, { isGross: typeof args.total_salary === 'number' });
      }
      case 'gosi': {
        if (typeof args.basic !== 'number' && typeof args.total_salary !== 'number') {
          throw new Error('Parameter "basic" (with optional "housing") or "total_salary" is required for action "gosi"');
        }
        const wage = typeof args.basic === 'number'
          ? { basic: args.basic, housing: typeof args.housing === 'number' ? args.housing : 0 }
          : KsaOfferCalculator.calculateSalaryStructure(args.total_salary);
        return KsaOfferCalculator.calculateGosi(wage, isSaudi);
      }
      case 'eosb': {
        if (typeof args.monthly_wage !== 'number' || typeof args.tenure_years !== 'number') {
          throw new Error('Parameters "monthly_wage" and "tenure_years" are required for action "eosb"');
        }
        return KsaOfferCalculator.calculateEosb(args.monthly_wage, args.tenure_years, args.separation_type || 'TERMINATION');
      }
      case 'noncompete':
        return KsaOfferCalculator.validateNonCompete({
          durationMonths: args.non_compete_months,
          geographicScope: args.non_compete_scope
        });
      case 'evaluate':
        return KsaOfferCalculator.evaluateOffer({
          totalSalary: args.total_salary,
          basic: args.basic,
          housing: args.housing,
          transport: args.transport,
          isSaudiNational: typeof args.is_saudi_national === 'boolean' ? isSaudi : undefined,
          tenureYears: args.tenure_years,
          separationType: args.separation_type,
          probationDays: args.probation_days,
          nonCompeteMonths: args.non_compete_months,
          nonCompeteScope: args.non_compete_scope,
          qiwaNoticeDate: args.qiwa_notice_date,
          title: args.title
        });
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async toolCadence(args) {
    const action = args.action || 'evaluate';
    const referenceDate = args.reference_date ? new Date(args.reference_date) : new Date();
    if (action === 'calculate') {
      if (!args.submission_date) throw new Error('Parameter "submission_date" is required for action "calculate"');
      return CadenceEngine.calculateCadence(args.submission_date, referenceDate, {
        day7FollowUpSent: args.day7_sent === true,
        day14FollowUpSent: args.day14_sent === true
      });
    }
    if (action === 'evaluate') {
      const snapshot = this.readSnapshot();
      const applications = snapshot.applications || {};
      const results = CadenceEngine.evaluateApplications(applications, referenceDate);
      return { count: results.length, applications: results };
    }
    throw new Error(`Unknown action: ${action}`);
  }

  async toolContacts(args) {
    const action = args.action === 'recordInteraction' ? 'record_interaction' : args.action;
    if (!action) throw new Error('Parameter "action" is required');
    const tracker = new ContactTracker({ workspaceDir: this.workspace });
    switch (action) {
      case 'add': {
        if (!args.name) throw new Error('Parameter "name" is required for action "add"');
        const contact = tracker.addContact({
          id: args.id,
          name: args.name,
          company: args.company || '',
          role: args.role || '',
          persona: args.persona,
          email: args.email || '',
          profileUrl: args.profile_url || args.linkedin || args.profileUrl || '',
          jobId: args.job_id || args.jobId || null,
          notes: args.notes || '',
          lastContactedAt: args.last_contacted_at,
          nextFollowUpAt: args.next_follow_up_at
        });
        return { success: true, contact };
      }
      case 'list': {
        const filter = {};
        if (args.company) filter.company = args.company;
        if (args.persona) filter.persona = args.persona;
        if (args.job_id || args.jobId) filter.jobId = args.job_id || args.jobId;
        const contacts = tracker.listContacts(filter);
        return { count: contacts.length, contacts };
      }
      case 'get': {
        const key = args.id || args.name || args.query;
        if (!key) throw new Error('Parameter "id" (or "name") is required for action "get"');
        let contact = tracker.getContact(key);
        if (!contact) {
          const hits = tracker.searchContacts(key);
          contact = hits.find(c => String(c.name || '').toLowerCase() === String(key).toLowerCase()) || hits[0] || null;
        }
        if (!contact) throw new Error(`Contact not found: ${key}`);
        return { contact };
      }
      case 'search': {
        const contacts = tracker.searchContacts(args.query || args.name || '');
        return { count: contacts.length, contacts };
      }
      case 'record_interaction': {
        let id = args.id;
        if (!id && args.name) {
          const hits = tracker.searchContacts(args.name);
          if (hits[0]) id = hits[0].id;
        }
        if (!id) throw new Error('Parameter "id" is required for action "record_interaction"');
        const contact = tracker.recordInteraction(id, {
          channel: args.channel,
          summary: args.summary || args.notes || '',
          at: args.at || args.last_contacted_at,
          nextFollowUpAt: args.next_follow_up_at
        });
        return { success: true, contact };
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async toolMigrateLegacy(args) {
    if (!args.source_path) throw new Error('Parameter "source_path" is required');
    const mod = loadMigrateLegacy();
    if (!mod) {
      throw new Error('NOT_AVAILABLE: lib/operational/migrate-legacy.js is not present yet. Legacy migration is delivered by a separate workstream; the MCP tool crew_migrate_legacy is registered and will activate once that module lands.');
    }
    const fn = mod.migrateLegacy || mod.runMigration || mod.migrate || (typeof mod === 'function' ? mod : null);
    if (typeof fn !== 'function') {
      throw new Error('NOT_AVAILABLE: lib/operational/migrate-legacy.js does not export a migrate function (expected migrateLegacy, runMigration, or migrate).');
    }
    const fromDir = path.resolve(this.workspace, args.source_path);
    return fn({
      fromDir,
      from: fromDir,
      sourceDir: fromDir,
      sourcePath: fromDir,
      source_path: fromDir,
      workspaceDir: this.workspace,
      workspace: this.workspace,
      dryRun: args.dry_run === true,
      dry_run: args.dry_run === true
    });
  }

  // ==========================================================================
  // JSON-RPC 2.0 Protocol Lifecycle
  // ==========================================================================

  static _result(id, result) {
    return { jsonrpc: '2.0', id, result };
  }

  static _error(id, code, message, data) {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
  }

  sendResponse(id, result) {
    process.stdout.write(JSON.stringify(McpServer._result(id, result)) + '\n');
  }

  sendError(id, code, message, data) {
    process.stdout.write(JSON.stringify(McpServer._error(id, code, message, data)) + '\n');
  }

  /**
   * Runs one tool by name with plain arguments. Shared by MCP tools/call and
   * the `crew tool` CLI bridge so hosts without MCP get identical behaviour.
   */
  async callTool(name, args = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    if (this.workspaceError) throw new Error(this.workspaceError);
    return tool.handler(args || {});
  }

  /**
   * Transport-independent JSON-RPC dispatch. Returns the response message,
   * or null for notifications (which must never be answered).
   */
  async dispatch(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return McpServer._error(null, -32600, 'Invalid Request');
    }
    const { id, method, params } = request;

    if (id === undefined || id === null) {
      if (method === 'notifications/initialized') {
        process.stderr.write(`[MCP] Client connection initialized successfully.\n`);
      }
      return null;
    }

    try {
      switch (method) {
        case 'initialize': {
          const requested = params && params.protocolVersion;
          return McpServer._result(id, {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
          });
        }

        case 'ping':
          return McpServer._result(id, {});

        case 'tools/list':
          return McpServer._result(id, {
            tools: Array.from(this.tools.values()).map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema
            }))
          });

        case 'tools/call': {
          if (!params || !params.name) {
            return McpServer._error(id, -32602, 'Invalid params: "name" required');
          }
          if (!this.tools.has(params.name)) {
            return McpServer._error(id, -32601, `Tool not found: ${params.name}`);
          }
          try {
            const rawResult = await this.callTool(params.name, params.arguments);
            return McpServer._result(id, {
              content: [{ type: 'text', text: typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult, null, 2) }],
              isError: false
            });
          } catch (toolErr) {
            // Guardrail or domain violation is returned as isError: true per MCP spec
            return McpServer._result(id, {
              content: [{ type: 'text', text: toolErr.message || String(toolErr) }],
              isError: true
            });
          }
        }

        default:
          return McpServer._error(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return McpServer._error(id, -32603, `Internal error: ${err.message}`);
    }
  }

  async handleRequest(request) {
    const response = await this.dispatch(request);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  }

  start() {
    process.stderr.write(`[MCP] Starting ${SERVER_NAME} v${SERVER_VERSION} (stdio transport)...\n`);
    if (this.workspaceError) process.stderr.write(`[MCP] ${this.workspaceError}\n`);
    this.rl = readline.createInterface({
      input: process.stdin,
      terminal: false
    });

    const pending = new Set();
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        this.sendError(null, -32700, `Parse error: ${err.message}`);
        return;
      }
      const p = this.handleRequest(parsed).finally(() => pending.delete(p));
      pending.add(p);
    });

    this.rl.on('close', async () => {
      process.stderr.write(`[MCP] Standard input closed. Shutting down.\n`);
      // Finish in-flight tool calls so their responses are not lost on exit.
      await Promise.allSettled([...pending]);
      process.exit(0);
    });
  }

  /**
   * Stateless Streamable HTTP transport (JSON responses, no SSE stream) for
   * hosts that only reach remote MCP servers, e.g. ChatGPT connectors.
   * Binds to loopback; every request must carry the secret token, either as
   * the last path segment (/mcp/<token>) or as `Authorization: Bearer <token>`.
   */
  startHttp(options = {}) {
    const http = require('http');
    const crypto = require('crypto');
    const host = options.host || '127.0.0.1';
    const port = options.port === undefined ? 8787 : Number(options.port);
    const token = String(options.token || '');
    if (token.length < 16) throw new Error('HTTP transport requires a token of at least 16 characters');
    const tokenBuf = Buffer.from(token);
    const matches = (candidate) => {
      const buf = Buffer.from(String(candidate || ''));
      return buf.length === tokenBuf.length && crypto.timingSafeEqual(buf, tokenBuf);
    };
    const MAX_BODY = 5 * 1024 * 1024;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);
      const auth = String(req.headers.authorization || '');
      const authorized = (segments[0] === 'mcp' && segments.length === 2 && matches(segments[1])) ||
        (segments[0] === 'mcp' && segments.length === 1 && auth.startsWith('Bearer ') && matches(auth.slice(7)));
      const sendJson = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };

      if (!authorized) return sendJson(404, { error: 'not found' });
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        return res.end();
      }

      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          sendJson(413, McpServer._error(null, -32600, 'Request too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', async () => {
        if (res.writableEnded) return;
        let parsed;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          return sendJson(400, McpServer._error(null, -32700, `Parse error: ${err.message}`));
        }
        const batch = Array.isArray(parsed) ? parsed : [parsed];
        const responses = (await Promise.all(batch.map(m => this.dispatch(m)))).filter(Boolean);
        if (responses.length === 0) {
          res.writeHead(202);
          return res.end();
        }
        sendJson(200, Array.isArray(parsed) ? responses : responses[0]);
      });
    });

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        this.httpServer = server;
        const addr = server.address();
        process.stderr.write(`[MCP] ${SERVER_NAME} v${SERVER_VERSION} (HTTP transport) on http://${host}:${addr.port}/mcp/<token>\n`);
        resolve(server);
      });
    });
  }

  stop() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }
  }
}

module.exports = {
  McpServer,
  loadSavedStories,
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS
};
