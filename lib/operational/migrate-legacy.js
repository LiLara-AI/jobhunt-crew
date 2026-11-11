'use strict';

/**
 * JobHunt Crew — Legacy Workspace Migration Engine
 *
 * Imports an older file-based job-search workspace into the current local
 * state model:
 * - master career profile markdown      -> .crew/dossier.json
 * - editorial guidelines markdown       -> .crew/editorial-rules.json
 * - applied / shortlist / to-do queues  -> hash-chained .crew/ledger.jsonl
 *                                          plus .crew/snapshot.json
 *
 * The source tree is only ever read. The target workspace receives new
 * local state; nothing is transmitted anywhere. Re-running the import
 * skips jobs that are already present in the ledger, and refuses to
 * overwrite an existing dossier unless `force` is set.
 *
 * Zero external dependencies.
 *
 * @module lib/operational/migrate-legacy
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventLedger } = require('../ledger/ledger');
const { replayLedger } = require('../ledger/reducer');

const PROFILE_FILENAME = 'Master-Career-Profile.md';
const EDITORIAL_FILENAME = 'editorial-rules.md';

function shortHash(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 8);
}

function slugify(value, fallback = 'item') {
  const slug = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug.slice(0, 28) || fallback;
}

function stripTemplate(text) {
  return String(text || '').replace(/\{\{[^}]*\}\}/g, '').trim();
}

function cleanCell(text) {
  return stripTemplate(String(text || '').replace(/\*\*/g, '').trim());
}

function extractMetrics(text) {
  const found = [];
  const pattern = /(SAR\s?[\d,]+(?:\.\d+)?\s?[KM]?|\$[\d,]+(?:\.\d+)?\s?[KM]?|\d+(?:\.\d+)?%|\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s?(?:x|ms|rps|users|orders|engineers|hubs|regions))/gi;
  let match;
  while ((match = pattern.exec(String(text || ''))) !== null) {
    const value = match[1].trim();
    if (!found.includes(value)) found.push(value);
    if (found.length >= 8) break;
  }
  return found;
}

/**
 * Locates a named file at the root of `rootDir`, inside a list of likely
 * sub-directories, or anywhere within a bounded recursive walk.
 */
function locateFile(rootDir, relativeCandidates, filename, maxDepth = 4) {
  for (const candidate of relativeCandidates) {
    const full = path.join(rootDir, candidate);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  let found = null;
  const walk = (dir, depth) => {
    if (found || depth > maxDepth || !fs.existsSync(dir)) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) { found = full; return; }
      if (entry.isDirectory()) walk(full, depth + 1);
      if (found) return;
    }
  };
  walk(rootDir, 0);
  return found;
}

function discoverLegacySources(fromDir) {
  const root = path.resolve(fromDir);
  const queueDir = path.join('Agent-System', 'Queues');
  return {
    root,
    profile: locateFile(root, [PROFILE_FILENAME, 'Master-Career-Profile.template.md'], PROFILE_FILENAME),
    editorial: locateFile(root, [EDITORIAL_FILENAME, 'editorial-rules.default.md'], EDITORIAL_FILENAME),
    applied: locateFile(root, [path.join(queueDir, 'data-applied.js'), 'data-applied.js'], 'data-applied.js'),
    shortlist: locateFile(root, [path.join(queueDir, 'data-' + 'shortlist.js'), 'data-' + 'shortlist.js'], 'data-' + 'shortlist.js'),
    todo: locateFile(root, [path.join(queueDir, 'data-todo.js'), 'data-todo.js'], 'data-todo.js')
  };
}

/**
 * Parses a browser-global queue assignment file without executing it.
 * The object literal is normalized into JSON (bare keys quoted, trailing
 * commas dropped). Returns null when the file cannot be understood.
 */
function parseLegacyQueueFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let body = raw.slice(start, end + 1);
  body = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[\s{,])\/\/[^\n]*/g, '$1')
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return { data: JSON.parse(body), raw };
  } catch (_) {
    return null;
  }
}

function mapClaimStatus(rawStatus) {
  const normalized = String(rawStatus || '').toUpperCase();
  return normalized.includes('VERIFIED') ? 'VERIFIED' : 'CONFIRM';
}

function parseYearRange(dateText) {
  const years = String(dateText || '').match(/\b(19|20)\d{2}\b/g) || [];
  const isCurrent = /present|current/i.test(String(dateText || ''));
  const startYear = years.length ? parseInt(years[0], 10) : 2020;
  const endYear = isCurrent ? null : (years.length > 1 ? parseInt(years[years.length - 1], 10) : startYear);
  return { startYear, endYear, isCurrent };
}

/**
 * Parses the legacy master profile into the current dossier shape.
 * Content under the internal-notes marker contributes only compensation
 * numbers; identity-document and birth-date lines are never carried over.
 */
function parseLegacyProfile(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const dossier = {
    schemaVersion: '1.0.0',
    updatedAt: new Date().toISOString(),
    candidate: {
      name: '[Candidate Name]', email: 'user@example.org', phone: '+1 555-0100',
      location: '', workAuthorization: '', noticePeriodDays: 30, currentTitle: '', summary: '',
      salaryFloor: { currency: 'SAR', minimumBase: 0, targetTotal: 0, disclosurePolicy: 'mandatory_only' }
    },
    employers: [], claims: [], degrees: [], certifications: [],
    skills: { languages: [], frameworks: [], infrastructure: [], databases: [], architecturalDomains: [] },
    preferences: {
      targetTitles: [], targetLocations: [],
      knockouts: { excludedIndustries: [], excludedSubIndustries: [], excludedCompanies: [], seniorityFloor: '' },
      jobBoards: [], schedule: { startHour: 8, timezone: 'Asia/Riyadh', autoPrep: false }
    },
    claimVerificationAppendix: { verifiedCount: 0, pendingCount: 0, verificationLog: [] }
  };

  const titleMatch = String(markdown).match(/^#\s+(.+?)\s+—\s+Master Career Profile/m) || String(markdown).match(/^#\s+(.+)$/m);
  if (titleMatch) {
    const name = stripTemplate(titleMatch[1].replace(/^Career Dossier\s+—\s+/i, ''));
    if (name) dossier.candidate.name = name;
  }

  let section = '';
  let currentEmployer = null;
  let internal = false;
  const claimsById = new Map();

  const upsertClaim = claim => {
    const previous = claimsById.get(claim.id);
    claimsById.set(claim.id, previous ? { ...previous, ...claim } : claim);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/INTERNAL\s+—\s+NOT PROFILE CONTENT/i.test(line) && line.startsWith('#')) internal = true;

    if (!internal) {
      if (/^##\s+Contact/i.test(line)) { section = 'contact'; continue; }
      if (/^##\s+Positioning/i.test(line)) { section = 'summary'; continue; }
      if (/^##\s+Experience/i.test(line)) { section = 'experience'; continue; }
      if (/^##\s+Skills/i.test(line)) { section = 'skills'; continue; }
      if (/^##\s+Tools/i.test(line)) { section = 'tools'; continue; }
      if (/^##\s+Education/i.test(line)) { section = 'education'; continue; }
      if (/^##\s+Languages/i.test(line)) { section = 'languages'; continue; }
      if (/^##\s+Work authorization/i.test(line)) { section = 'auth'; continue; }
      if (/^##\s+Claim Verification Appendix/i.test(line)) { section = 'appendix'; continue; }
      if (/^##\s/.test(line)) { section = 'other'; continue; }

      if (section === 'contact') {
        const field = line.match(/^-\s*\*\*([^*]+):\*\*\s*(.+)$/);
        if (field) {
          const value = stripTemplate(field[2]);
          const label = field[1].toLowerCase();
          if (label.includes('location') && value) dossier.candidate.location = value;
          if ((label.includes('mobile') || label.includes('phone')) && value) dossier.candidate.phone = value;
          if (label.includes('email') && value) dossier.candidate.email = value;
        }
      } else if (section === 'summary' && line && !line.startsWith('>') && !line.startsWith('-')) {
        const value = stripTemplate(line);
        if (value) dossier.candidate.summary = dossier.candidate.summary ? `${dossier.candidate.summary} ${value}` : value;
      } else if (section === 'experience') {
        const heading = line.match(/^###\s+(.+?)\s+—\s+(.+)$/);
        if (heading) {
          const companyName = stripTemplate(heading[1]) || 'Employer';
          currentEmployer = {
            id: `emp_${slugify(companyName, 'employer')}`,
            name: companyName, location: '', startYear: 2020, endYear: null, isCurrent: false,
            title: stripTemplate(heading[2])
          };
          dossier.employers.push(currentEmployer);
          continue;
        }
        if (currentEmployer && line.startsWith('*') && line.endsWith('*') && !currentEmployer.location) {
          const parts = line.replace(/^\*+|\*+$/g, '').split('·').map(part => stripTemplate(part));
          const range = parseYearRange(parts[0] || '');
          currentEmployer.startYear = range.startYear;
          currentEmployer.endYear = range.endYear;
          currentEmployer.isCurrent = range.isCurrent;
          if (parts[1]) currentEmployer.location = parts[1];
          continue;
        }
        const bullet = line.match(/^-\s+(.*?)\s*\[([A-Za-z][A-Za-z0-9_-]*)\]\.?$/);
        if (bullet && currentEmployer) {
          const text = stripTemplate(bullet[1]);
          if (text) {
            upsertClaim({
              id: bullet[2], employerId: currentEmployer.id, category: 'experience', text,
              metrics: extractMetrics(text), tools: [], role: currentEmployer.title, status: 'CONFIRM',
              evidence: null, clarificationPrompt: 'Imported from a legacy profile; confirm before use.',
              updatedAt: dossier.updatedAt
            });
          }
        }
      } else if (section === 'skills') {
        const group = line.match(/^-\s*\*\*([^*]+):\*\*\s*(.+)$/);
        if (group) {
          const terms = stripTemplate(group[2]).split(/[·,]/).map(term => term.trim()).filter(Boolean);
          for (const term of terms) {
            if (!dossier.skills.architecturalDomains.includes(term)) dossier.skills.architecturalDomains.push(term);
          }
        }
      } else if (section === 'tools' && line && !line.startsWith('*(')) {
        const tools = stripTemplate(line.replace(/^[A-Za-z ]+:\s*/, '')).split(/[·,]/).map(term => term.trim()).filter(Boolean);
        for (const tool of tools) {
          if (tool && !dossier.skills.frameworks.includes(tool)) dossier.skills.frameworks.push(tool);
        }
      } else if (section === 'education' && line.startsWith('-')) {
        const item = cleanCell(line.replace(/^-\s*/, ''));
        const yearMatch = item.match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? parseInt(yearMatch[0], 10) : 2020;
        if (/certif|accredit|license|licence/i.test(item)) {
          dossier.certifications.push({ name: item.replace(/,?\s*\d{4}.*$/, ''), issuer: '', year });
        } else if (item) {
          dossier.degrees.push({ degree: item.replace(/,?\s*\d{4}.*$/, ''), institution: '', year });
        }
      } else if (section === 'auth') {
        const field = line.match(/^-\s*\*\*([^*]+):\*\*\s*(.+)$/);
        if (field) {
          const value = stripTemplate(field[2]);
          const label = field[1].toLowerCase();
          if (label.includes('status') && value) dossier.candidate.workAuthorization = value;
          if (label.includes('notice')) {
            const days = value.match(/(\d+)\s*(?:day|month)/i);
            if (days) dossier.candidate.noticePeriodDays = /month/i.test(value) ? parseInt(days[1], 10) * 30 : parseInt(days[1], 10);
          }
        }
      } else if (section === 'appendix' && line.startsWith('|')) {
        const cells = line.split('|').map(cell => cell.trim());
        // cells: ['', '[C-01]', category, claim text, source, status, notes, '']
        const idMatch = (cells[1] || '').match(/\[?([A-Za-z][A-Za-z0-9_-]*)\]?/);
        const claimText = cleanCell(cells[3] || '');
        if (idMatch && claimText && !/^claim id$/i.test(cells[1]) && !/^:?-{2,}/.test(cells[1])) {
          const source = cleanCell(cells[4] || '');
          let employer = dossier.employers.find(e => source.toLowerCase().includes(e.name.toLowerCase()));
          if (!employer && dossier.employers.length > 0) employer = dossier.employers[0];
          if (!employer) {
            employer = { id: 'emp_legacy', name: source || 'Legacy Employer', location: '', startYear: 2020, endYear: null, isCurrent: false, title: '' };
            dossier.employers.push(employer);
          }
          const status = mapClaimStatus(cells[5]);
          upsertClaim({
            id: idMatch[1], employerId: employer.id,
            category: slugify(cleanCell(cells[2] || 'general'), 'general').replace(/_/g, '-'),
            text: claimText, metrics: extractMetrics(claimText), tools: [], role: employer.title || '',
            status,
            evidence: status === 'VERIFIED' ? (cleanCell(cells[6] || '') || 'Legacy appendix status') : null,
            clarificationPrompt: status === 'VERIFIED' ? null : 'Imported from a legacy profile; confirm before use.',
            updatedAt: dossier.updatedAt
          });
        }
      }
    } else {
      // Internal notes: compensation numbers only.
      const currency = line.match(/\*\*Currency:\*\*\s*([A-Z]{3})/i);
      if (currency) dossier.candidate.salaryFloor.currency = currency[1].toUpperCase();
      const floor = line.match(/Minimum Base Salary:\*\*\s*([\d,]+)/i);
      if (floor) dossier.candidate.salaryFloor.minimumBase = parseInt(floor[1].replace(/,/g, ''), 10) || 0;
      const target = line.match(/Total Target Comp:\*\*\s*([\d,]+)/i);
      if (target) dossier.candidate.salaryFloor.targetTotal = parseInt(target[1].replace(/,/g, ''), 10) || 0;
    }
  }

  if (dossier.employers.length === 0 && claimsById.size > 0) {
    dossier.employers.push({ id: 'emp_legacy', name: 'Legacy Employer', location: '', startYear: 2020, endYear: null, isCurrent: false, title: '' });
    for (const claim of claimsById.values()) claim.employerId = 'emp_legacy';
  }
  const current = dossier.employers.find(e => e.isCurrent) || dossier.employers[0];
  if (current && current.title) dossier.candidate.currentTitle = current.title;

  dossier.claims = Array.from(claimsById.values());
  dossier.claimVerificationAppendix.verifiedCount = dossier.claims.filter(c => c.status === 'VERIFIED').length;
  dossier.claimVerificationAppendix.pendingCount = dossier.claims.filter(c => c.status === 'CONFIRM').length;
  return dossier;
}

const SALARY_POLICY_MAP = {
  NEVER_UNLESS_MANDATORY: 'mandatory_only',
  NEGOTIABLE_PLACEHOLDER_THEN_FLOOR: 'negotiable_placeholder',
  ALWAYS_DISCLOSE_TARGET: 'always_disclose'
};

/**
 * Converts legacy editorial markdown into the current JSON rule file shape.
 * Every bullet is preserved as a guideline entry; explicit
 * "Use X rather than Y" lines also become active vocabulary rules.
 */
function parseLegacyEditorial(markdown) {
  const guidelines = [];
  const rules = [];
  let heading = '';
  let salaryDisclosurePolicy = 'mandatory_only';

  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const policy = line.match(/`(NEVER_UNLESS_MANDATORY|NEGOTIABLE_PLACEHOLDER_THEN_FLOOR|ALWAYS_DISCLOSE_TARGET)`/);
    if (policy && /active policy/i.test(line)) salaryDisclosurePolicy = SALARY_POLICY_MAP[policy[1]];
    if (/^#{1,3}\s/.test(line)) { heading = line.replace(/^#{1,3}\s+/, '').trim(); continue; }
    if (/^-\s+/.test(line)) {
      const text = stripTemplate(line.replace(/^-\s+/, '').replace(/\*\*/g, ''));
      if (text) guidelines.push({ heading, text });
      const swap = line.match(/[Uu]se\s+"([^"]+)"\s+rather than\s+"([^"]+)"/);
      if (swap) {
        const id = `LEGACY-VOCAB-${shortHash(swap[2]).toUpperCase()}`;
        if (!rules.some(r => r.id === id)) {
          rules.push({
            id, version: 1, category: 'vocabulary', scope: 'global',
            pattern: swap[2], isRegex: false, caseSensitive: false, replacement: swap[1],
            rationale: 'Imported legacy editorial preference', active: true,
            createdBy: 'legacy-migration', createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(), undoneAt: null,
            history: [{ action: 'created', version: 1, actor: 'legacy-migration', timestamp: new Date().toISOString(), note: 'Imported from legacy editorial markdown' }]
          });
        }
      }
    }
  }
  return { salaryDisclosurePolicy, rules, guidelines };
}

// Legacy queue statuses mapped onto snapshot-safe job statuses. No imported
// record ever becomes an application-submission event: historical rows are
// evidence of past human action, not a new authorization to submit.
const LEGACY_STATUS_MAP = {
  new: 'shortlisted', shortlisted: 'shortlisted', shortlist: 'shortlisted',
  applied: 'applied', screening: 'screen', screen: 'screen',
  interview: 'interview', interviewing: 'interview',
  offer: 'offer', closed: 'closed', rejected: 'closed', withdrawn: 'closed'
};

function mapLegacyStatus(rawStatus) {
  return LEGACY_STATUS_MAP[String(rawStatus || '').trim().toLowerCase()] || 'discovered';
}

function legacyJobId(kind, record) {
  const basis = record.id || `${record.company || ''}|${record.title || ''}|${record.link || record.url || ''}`;
  return `legacy_${slugify(record.company || kind, kind)}_${shortHash(basis)}`;
}

function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      fs.copyFileSync(tmp, filePath);
      fs.unlinkSync(tmp);
    } else {
      throw err;
    }
  }
}

/**
 * Runs the full legacy import.
 * @param {Object} options
 * @param {string} options.fromDir - Legacy workspace root (read-only)
 * @param {string} [options.workspaceDir] - Target workspace root
 * @param {boolean} [options.force=false] - Overwrite an existing dossier
 * @param {boolean} [options.dryRun=false] - Parse and report only, write nothing
 * @returns {Promise<Object>} Migration report
 */
async function migrateLegacy(options = {}) {
  const fromDir = options.fromDir || options.from || options.sourceDir;
  if (!fromDir) throw new Error('MIGRATE_ERROR: A legacy source directory is required (--from <dir>)');
  const workspaceDir = path.resolve(options.workspaceDir || options.workspace || process.cwd());
  const sources = discoverLegacySources(fromDir);
  if (!fs.existsSync(sources.root)) throw new Error(`MIGRATE_ERROR: Legacy source directory not found: ${sources.root}`);

  const warnings = [];
  const report = {
    fromDir: sources.root, workspaceDir, dryRun: Boolean(options.dryRun),
    sourcesFound: {
      profile: Boolean(sources.profile), editorial: Boolean(sources.editorial),
      applied: Boolean(sources.applied), shortlist: Boolean(sources.shortlist), todo: Boolean(sources.todo)
    },
    imported: { employers: 0, claims: 0, editorialRules: 0, editorialGuidelines: 0, jobs: 0, todos: 0, ledgerEvents: 0 },
    skipped: { dossier: false, jobs: 0, todos: 0 },
    filesWritten: [], warnings
  };

  const crewDir = path.join(workspaceDir, '.crew');
  const ledgerPath = path.join(crewDir, 'ledger.jsonl');
  const snapshotPath = path.join(crewDir, 'snapshot.json');
  const dossierPath = path.join(crewDir, 'dossier.json');
  const editorialPath = path.join(crewDir, 'editorial-rules.json');
  const legacyActor = 'agent:legacy-migration';

  // --- Dossier -------------------------------------------------------------
  let dossier = null;
  if (sources.profile) {
    dossier = parseLegacyProfile(fs.readFileSync(sources.profile, 'utf8'));
    report.imported.employers = dossier.employers.length;
    report.imported.claims = dossier.claims.length;
    // Records with no discovered vacancy link still need a valid employer
    // anchor if claims exist; parseLegacyProfile guarantees one.
    try {
      const { CareerDossier } = require('../honest-cv/dossier');
      const validated = new CareerDossier(JSON.parse(JSON.stringify(dossier)));
      dossier = JSON.parse(validated.toJson());
    } catch (err) {
      warnings.push(`Dossier validation note: ${err.message}`);
    }
    dossier.legacyImport = { sourceFile: path.basename(sources.profile), importedAt: new Date().toISOString() };
    if (!options.dryRun) {
      if (fs.existsSync(dossierPath) && !options.force) {
        report.skipped.dossier = true;
        warnings.push('Existing .crew/dossier.json kept; pass force to overwrite it.');
      } else {
        writeJsonAtomically(dossierPath, dossier);
        report.filesWritten.push(dossierPath);
      }
    }
  } else {
    warnings.push('No master career profile found in the legacy tree.');
  }

  // --- Editorial rules ------------------------------------------------------
  if (sources.editorial) {
    const parsed = parseLegacyEditorial(fs.readFileSync(sources.editorial, 'utf8'));
    report.imported.editorialRules = parsed.rules.length;
    report.imported.editorialGuidelines = parsed.guidelines.length;
    if (!options.dryRun) {
      let existing = null;
      if (fs.existsSync(editorialPath)) {
        try { existing = JSON.parse(fs.readFileSync(editorialPath, 'utf8')); } catch (_) { existing = null; }
      }
      const mergedRules = existing && Array.isArray(existing.rules) ? [...existing.rules] : [];
      for (const rule of parsed.rules) {
        if (!mergedRules.some(r => r.id === rule.id)) mergedRules.push(rule);
      }
      const mergedGuidelines = existing && Array.isArray(existing.legacyGuidelines) ? [...existing.legacyGuidelines] : [];
      for (const guideline of parsed.guidelines) {
        if (!mergedGuidelines.some(g => g.text === guideline.text && g.heading === guideline.heading)) mergedGuidelines.push(guideline);
      }
      writeJsonAtomically(editorialPath, {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        salaryDisclosurePolicy: (existing && existing.salaryDisclosurePolicy) || parsed.salaryDisclosurePolicy,
        rules: mergedRules,
        legacyGuidelines: mergedGuidelines
      });
      report.filesWritten.push(editorialPath);
    }
  } else {
    warnings.push('No legacy editorial rules file found.');
  }

  // --- Queues -> ledger ------------------------------------------------------
  const ledger = new EventLedger({ workspaceDir, ledgerPath });
  const existingEvents = options.dryRun ? [] : ledger.readEvents();
  const knownJobIds = new Set();
  const knownTodoIds = new Set();
  for (const event of existingEvents) {
    const payload = event.payload || {};
    if ((event.event || event.type) === 'JOB_DISCOVERED' && (payload.id || payload.jobId)) knownJobIds.add(payload.id || payload.jobId);
    if ((event.event || event.type) === 'LEGACY_TODO_IMPORTED' && payload.todoId) knownTodoIds.add(payload.todoId);
  }

  const plannedEvents = [];
  const planJob = (kind, record, mappedStatus, score) => {
    const jobId = legacyJobId(kind, record);
    if (knownJobIds.has(jobId) || plannedEvents.some(e => e.payload.id === jobId && e.event === 'JOB_DISCOVERED')) {
      report.skipped.jobs += 1;
      return;
    }
    plannedEvents.push({
      event: 'JOB_DISCOVERED', actor: legacyActor,
      payload: {
        id: jobId, jobId, title: record.title || 'Imported role', company: record.company || 'Unknown company',
        location: record.location || 'Unknown', url: record.link || record.url || '',
        channel: String(record.source || `legacy-${kind}`).toLowerCase(),
        legacyId: record.id || null, legacyStatus: record.status || null
      }
    });
    if (mappedStatus === 'closed') {
      plannedEvents.push({
        event: 'JOB_CLOSED', actor: legacyActor,
        payload: {
          id: jobId, jobId, reason: String(record.status || 'closed').toLowerCase(),
          evidence: { type: 'explicit_closure_notice', proof: record.notes || 'Legacy record marked closed before import' }
        }
      });
    } else {
      plannedEvents.push({
        event: 'JOB_TRIAGED', actor: legacyActor,
        payload: {
          id: jobId, jobId, status: mappedStatus,
          score: typeof score === 'number' ? score : null,
          rationale: record.notes || record.jobSummary || `Imported legacy ${kind} record`,
          legacyStatus: record.status || null, legacyAppliedDate: record.appliedDate || null,
          legacyFollowUpDate: record.followUpDate || null, legacySalary: record.salary || null
        }
      });
    }
    report.imported.jobs += 1;
  };

  const loadQueue = (filePath, label) => {
    if (!filePath) { warnings.push(`No legacy ${label} queue found.`); return null; }
    const parsed = parseLegacyQueueFile(filePath);
    if (!parsed) { warnings.push(`Legacy ${label} queue could not be parsed; left untouched at ${filePath}`); return null; }
    return parsed.data;
  };

  const applied = loadQueue(sources.applied, 'applied');
  for (const item of (applied && Array.isArray(applied.items) ? applied.items : [])) {
    planJob('applied', item, mapLegacyStatus(item.status), null);
  }
  const shortlist = loadQueue(sources.shortlist, 'shortlist');
  for (const role of (shortlist && Array.isArray(shortlist.roles) ? shortlist.roles : [])) {
    const score = typeof role.fit === 'number' ? Number((role.fit / 20).toFixed(2)) : null;
    planJob('shortlist', role, mapLegacyStatus(role.status || 'shortlisted'), score);
  }
  const todo = loadQueue(sources.todo, 'to-do');
  for (const item of (todo && Array.isArray(todo.items) ? todo.items : [])) {
    const todoId = item.id || `todo_${shortHash(JSON.stringify(item))}`;
    if (knownTodoIds.has(todoId)) { report.skipped.todos += 1; continue; }
    plannedEvents.push({
      event: 'LEGACY_TODO_IMPORTED', actor: legacyActor,
      payload: { todoId, who: item.who || null, priority: item.priority || null, added: item.added || null, title: item.title || '', reply: item.reply || null }
    });
    report.imported.todos += 1;
  }

  report.imported.ledgerEvents = plannedEvents.length;
  report.plannedEvents = plannedEvents.map(e => ({ event: e.event, jobId: e.payload.jobId || e.payload.todoId || null }));

  if (!options.dryRun) {
    for (const planned of plannedEvents) {
      await ledger.appendEvent(planned);
    }
    if (plannedEvents.length > 0 || fs.existsSync(ledgerPath)) {
      const snapshot = await replayLedger({ workspaceDir, ledgerPath, snapshotPath, rebuild: true });
      report.snapshotLastEventId = snapshot.lastEventId;
      report.snapshotJobCount = Object.keys(snapshot.jobs || {}).length;
      if (!report.filesWritten.includes(ledgerPath) && plannedEvents.length > 0) report.filesWritten.push(ledgerPath);
      if (fs.existsSync(snapshotPath)) report.filesWritten.push(snapshotPath);
    }
    const chain = ledger.verifyChainIntegrity();
    report.ledgerChainValid = chain.valid;
    if (!chain.valid) warnings.push(`Ledger chain check after import: ${chain.reason}`);
  }

  report.dossier = dossier ? { employers: dossier.employers.length, claims: dossier.claims.length } : null;
  return report;
}

function parseMigrateArgs(argv = []) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from') options.fromDir = argv[++i];
    else if (arg.startsWith('--from=')) options.fromDir = arg.slice('--from='.length);
    else if (arg === '--workspace' || arg === '-w') options.workspaceDir = argv[++i];
    else if (arg.startsWith('--workspace=')) options.workspaceDir = arg.slice('--workspace='.length);
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
  }
  return options;
}

/**
 * CLI-callable handler for `crew migrate legacy`.
 * Accepts either a raw argv array or an options object.
 */
async function runMigrateLegacy(input = {}) {
  const options = Array.isArray(input) ? parseMigrateArgs(input) : input;
  const report = await migrateLegacy(options);
  return report;
}

module.exports = {
  migrateLegacy,
  runMigrateLegacy,
  parseMigrateArgs,
  discoverLegacySources,
  parseLegacyQueueFile,
  parseLegacyProfile,
  parseLegacyEditorial,
  mapLegacyStatus,
  LEGACY_STATUS_MAP
};

if (require.main === module) {
  runMigrateLegacy(process.argv.slice(2))
    .then(report => { console.log(JSON.stringify(report, null, 2)); })
    .catch(err => { console.error(err.message); process.exit(1); });
}
