'use strict';

/**
 * JobHunt Crew — Claude Code & Cowork Plugin Compiler
 *
 * Compiles primary source modules into an installable Claude plugin bundle
 * adhering to strict Claude Desktop / CLI validator specifications.
 *
 * @module lib/compiler/claude-plugin
 */

const fs = require('fs');
const path = require('path');
const { MiniZipBuilder } = require('../honest-cv/doc-generator');

// Folder the CLI entry scripts ship in inside the Claude bundle (claude.ai rejects bin/).
const BUNDLE_CLI_DIR = 'cli';

class ClaudePluginCompiler {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir ? path.resolve(options.workspaceDir) : path.resolve(__dirname, '../..');
    this.outDir = options.outDir ? path.resolve(options.outDir) : path.join(this.workspaceDir, 'dist', 'claude-plugin');
    this.version = options.version || this._getPackageVersion();
    this.clean = options.clean !== false;
    this.zip = options.zip === true;
    this.zipPath = options.zipPath ? path.resolve(options.zipPath) : path.join(path.dirname(this.outDir), 'jobhunt-crew-plugin.zip');
  }

  _getPackageVersion() {
    try {
      const pkgPath = path.join(this.workspaceDir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return pkg.version || '0.1.0';
    } catch (_) {
      return '0.1.0';
    }
  }

  /**
   * Sanitizes text intended for YAML frontmatter description fields.
   * STRICT INVARIANT: ZERO '<' or '>' characters permitted.
   */
  static sanitizeDescription(text) {
    if (!text || typeof text !== 'string') return '';
    return text
      .replace(/<[^>]*>/g, '') // Strip XML/HTML tags
      .replace(/[<>]/g, '')    // Purge any remaining angle brackets
      .replace(/\s+/g, ' ')    // Normalize whitespace
      .trim();
  }

  /**
   * Escapes a string for a YAML double-quoted scalar.
   * Backslash and quote must be escaped or the frontmatter fails to parse.
   */
  static _yamlDoubleQuoted(value) {
    const escaped = String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\u0008/g, '\\b')
      .replace(/\f/g, '\\f')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }

  /**
   * Formats YAML frontmatter with strict XML-free guarantee.
   */
  static formatFrontmatter(metadata = {}) {
    const lines = ['---'];
    if (metadata.name) {
      lines.push(`name: ${metadata.name}`);
    }
    if (metadata.description) {
      const cleanDesc = ClaudePluginCompiler.sanitizeDescription(metadata.description);
      lines.push(`description: ${ClaudePluginCompiler._yamlDoubleQuoted(cleanDesc)}`);
    }
    lines.push('---');
    return lines.join('\n') + '\n\n';
  }

  /**
   * Rewrites multi-host agent frontmatter into the subset Claude accepts:
   * name + sanitized description + model inherit. Foreign tool names and
   * host-specific keys (mainAgent, commandExecutionPolicy, ...) are dropped
   * so the Cowork sync validator accepts the bundle. Source files in
   * agents/ stay untouched for their native hosts.
   */
  static sanitizeAgentForClaude(content) {
    const text = String(content || '');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return text;
    const fm = m[1];
    const nameM = fm.match(/^name:\s*(.+)$/m);
    const descM = fm.match(/^description:\s*"((?:[^"\\]|\\.)*)"\s*$/m) || fm.match(/^description:\s*(.+)$/m);
    const name = nameM ? nameM[1].trim() : 'agent';
    const desc = descM ? descM[1].trim().replace(/\\"/g, '"') : '';
    const lines = ['---', 'name: ' + name];
    if (desc) lines.push('description: ' + ClaudePluginCompiler._yamlDoubleQuoted(ClaudePluginCompiler.sanitizeDescription(desc)));
    lines.push('model: inherit', '---', '');
    return lines.join('\n') + '\n' + text.slice(m[0].length);
  }

  /**
   * Generates the canonical .claude-plugin/plugin.json manifest.
   */
  generateManifest() {
    // Prefer the checked-in manifest so the bundle never drifts from the repo.
    try {
      const onDisk = path.join(this.workspaceDir, '.claude-plugin', 'plugin.json');
      if (fs.existsSync(onDisk)) {
        const parsed = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
        if (parsed && parsed.name === 'jobhunt-crew') return parsed;
      }
    } catch (_) { /* fall through to generated manifest */ }
    const manifest = {
      name: 'jobhunt-crew',
      version: this.version,
      description: 'Deterministic multi-agent job search and honest CV tailoring platform with verified claims and append-only ledger.',
      author: {
        name: 'JobHunt Crew Authors'
      },
      license: 'MIT',
      keywords: ['job-hunt', 'cv', 'claim-verification', 'mcp', 'agents']
    };
    return manifest;
  }

  /**
   * Generates rules/AGENTS.md (Plain markdown with NO frontmatter).
   */
  generateRules() {
    // Prefer the checked-in rules file so all hosts read identical rules.
    try {
      const onDiskRules = path.join(this.workspaceDir, 'rules', 'AGENTS.md');
      if (fs.existsSync(onDiskRules)) {
        const text = fs.readFileSync(onDiskRules, 'utf8');
        if (text.trim().length > 0 && !text.startsWith('---')) return text;
      }
    } catch (_) { /* fall through to generated rules */ }
    return `# JobHunt Crew — Core Operating Rules & Deterministic Guardrails

These operating rules are active across all interactions in Claude Code and Claude Cowork.
Every agent and automated routine MUST strictly adhere to these 5 foundational guardrails.

---

## 1. 100% Local File State — Zero External SQL / Database Queries
- All state, job discoveries, applications, and logs reside strictly in local workspace files:
  - Local append-only ledger: \`.crew/ledger.jsonl\`
  - Materialized state snapshot: \`.crew/snapshot.json\`
  - Candidate profile: \`dossier.json\` / \`CareerDossier.md\`
  - Tailored packages: \`Applications/<Company>_<Role>/apply-pack.md\`
- **STRICT PROHIBITION**: Never query external SQL databases, remote Supabase connectors, or cloud datastores. All state transitions are local ledger events.

---

## 2. Strict Human-in-the-Loop Agency — No Auto-Submissions
- JobHunt Crew operates as an attended accelerator, NEVER as an unattended bot.
- **NEVER** automatically submit a job application on any platform.
- **NEVER** click the final "Submit", "Submit Application", "Confirm", or "Save Profile" buttons on external job boards or ATS platforms (Workday, Greenhouse, Lever, Taleo, Oracle Cloud).
- **NEVER** manage candidate passwords, payment information, or account credentials.
- In attended browser pre-filling, the agent fills form fields up to the final submission gate, marks status as \`ready-to-submit\`, and leaves the final review and submission action strictly to the human user.

---

## 3. Deterministic Claim Verification — Zero Fabrication
- Every metric, credential, past title, employer, duration, and achievement cited in tailored CVs, cover letters, outreach notes, and interview prep MUST be anchored directly in \`dossier.json\` or \`CareerDossier.md\`.
- All factual claims must map to a verified claim tag in the candidate dossier.
- Before any application package (\`apply-pack.md\`) is approved, the deterministic AST verification engine (\`lib/honest-cv/verify-claims.js\`) must be executed.
- If any claim, number, or achievement is unverified or modified, it must be flagged with \`[CONFIRM]\` and blocked from production delivery until explicitly verified and confirmed by the candidate.

---

## 4. Zero Age Penalty for Open Vacancies
- In job discovery sweeps, **NEVER** drop, disqualify, or penalize an open vacancy solely because of its posting date (e.g. > 30, 60, or 90 days old).
- Premier employers, giga-projects, and government entities (particularly in KSA and the GCC) keep requisitions open continuously until an ideal hire is finalized.
- A vacancy remains valid and eligible for evaluation as long as the page is live and accepting applications. Only disqualify roles if there is an explicit closure notice ("No longer accepting applications", "Job closed", HTTP 404/410) or a passed application deadline.

---

## 5. Optimal Task-Specific Model Routing
When executing tasks across the crew, route each function to its assigned model tier:
- **Dispatcher** (Fast tier): Work-state inspection and queue-driven waking.
- **Recon** (Fast tier): High-throughput 4-channel job discovery, dedup, and 5-dimension rubric scoring.
- **Scribe** (High-capability tier): Deep reasoning, high-fidelity narrative synthesis, claim-grounded CV/cover letter drafting.
- **Inquisitor** (High-capability tier + Script): Deterministic AST claim verification, [CONFIRM] gating, keyword gap benchmarking.
- **Critic** (High-capability tier): Candidate-isolated blind Recruiter + Hiring Manager review panel.
- **Liaison** (Fast tier): Inbound email signals, 7/14-day follow-up cadences, outreach drafting, daily briefing.
- **Navigator** (Fast tier): Attended browser sessions, login health, ready-to-save profile sync.
`;
  }

  /**
   * Compiles the 7 modular skill definitions.
   */
  /**
   * Reads a checked-in skills/<key>/SKILL.md when present, returning its
   * frontmatter name/description and body. Returns null when absent so the
   * generated fallback builders below are used instead.
   */
  _readDiskSkill(skillKey) {
    try {
      const skillPath = path.join(this.workspaceDir, 'skills', skillKey, 'SKILL.md');
      if (!fs.existsSync(skillPath)) return null;
      const raw = fs.readFileSync(skillPath, 'utf8');
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      if (!fm) return null;
      const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
      const descMatch = fm[1].match(/^description:\s*"?([^"\n]*)"?$/m);
      const body = raw.slice(fm[0].length);
      if (!nameMatch || !descMatch || body.trim().length === 0) return null;
      return { name: nameMatch[1].trim(), description: descMatch[1].trim(), content: body };
    } catch (_) {
      return null;
    }
  }

  compileSkills() {
    return {
      setup: this._readDiskSkill('setup') || {
        name: 'setup',
        description: 'Interactive single-question onboarding wizard that parses your resume, suggests target job titles, and initializes your local job search workspace.',
        content: this._buildSetupSkill()
      },
      update: this._readDiskSkill('update') || {
        name: 'update',
        description: 'Refreshes an existing JobHunt Crew workspace: replays the ledger, updates dossier claims, learns editorial rules from corrections, and re-checks health.',
        content: this._buildUpdateSkill()
      },
      'honest-cv': this._readDiskSkill('honest-cv') || {
        name: 'honest-cv',
        description: 'End-to-end claim-verified CV and cover letter tailoring pipeline with blind review panel and attended browser form pre-filling stopping before submit.',
        content: this._buildHonestCvSkill()
      },
      'apply-multi-vacancy': this._readDiskSkill('apply-multi-vacancy') || {
        name: 'apply-multi-vacancy',
        description: 'Evaluates several openings at one employer, recommends apply or skip per role, and builds one convergent CV with per-role cover letters.',
        content: this._buildApplyMultiVacancySkill()
      },
      contacto: this._readDiskSkill('contacto') || {
        name: 'contacto',
        description: 'Drafts concise under 300 character outreach notes and follow-up messages for recruiters, hiring managers, and peers anchored in verified dossier claims.',
        content: this._buildContactoSkill()
      },
      'interview-prep': this._readDiskSkill('interview-prep') || {
        name: 'interview-prep',
        description: 'Interactive mock interview simulator and STAR plus R story bank companion tied to verified candidate claims with cultural and company signal analysis.',
        content: this._buildInterviewPrepSkill()
      },
      'offer-review': this._readDiskSkill('offer-review') || {
        name: 'offer-review',
        description: 'Evaluates employment contracts and job offers against Saudi Labor Law, calculating end-of-service benefits, salary splits, GOSI, and non-compete clauses.',
        content: this._buildOfferReviewSkill()
      }
    };
  }

  // Individual skill content builders (clean-room, 0 PII, 0 forbidden legacy tokens)
  _buildSetupSkill() {
    return `# Setup Skill — JobHunt Crew

This skill conducts a strict one-question-per-turn interactive onboarding interview:
1. Environment & Workspace Check: Verify local Node.js environment and initialize \`.crew/\`.
2. Resume / Dossier Upload: Prompt user for CV/resume file or text without blocking choice modals.
3. Title Finder: Analyze experience and suggest Lateral, Stretch, and Pivot titles quoting verbatim resume lines.
4. Country & City Selection: Two-step cascading location selector (e.g., Saudi Arabia -> Riyadh, Jeddah, NEOM, Remote).
5. Work Mode & Salary Floor: Multi-select work modes (On-site, Hybrid, Remote) and 3-option salary disclosure policy.
6. Work Authorization & Notice Period: Factual attributes with zero recommendation bias.
7. Knockouts: Expandable sector knockout tree and company exclusion list.
8. Boards & Watchlist: Confirm target job boards and enterprise watchlist.
9. Workspace Initialization: Write \`dossier.json\`, initialize \`.crew/ledger.jsonl\`, and compile snapshot.
`;
  }

  _buildHonestCvSkill() {
    return `# Honest-CV Tailoring & Application Pipeline

Executes the 8-stage claim-verified application pipeline:
1. Intake & Positioning: Parse job description, extract core competencies, identify level match.
2. Claim Grounding: Select relevant verified achievements strictly from candidate dossier claims.
3. Draft Generation: Generate tailored CV and cover letter preserving candidate voice.
4. Human-Voice Pass: Remove generic AI filler, buzzwords, and unsubstantiated superlatives.
5. Blind Review Panel: Candidate-isolated evaluation simulating Recruiter and Hiring Manager personas.
6. Deterministic AST Verifier Gate: Run \`verify-claims.js\` to guarantee 100% factual match against dossier.
7. Stage 7 Apply Pack: Generate \`Applications/<Company>_<Role>/apply-pack.md\` with form answers.
8. Attended Browser Pre-Filling: Pre-fill application form fields in Chrome, stopping strictly before submit.
`;
  }

  _buildContactoSkill() {
    return `# Contacto — Professional Outreach Generator

Generates concise, highly targeted networking and follow-up communications:
- Hard Constraint: Under 300 characters for LinkedIn connection requests.
- 3 Personas: Hiring Manager (impact focus), Recruiter (skills/fit focus), Peer (technical connection).
- Zero Fabrication: Every cited accomplishment must anchor to a verified claim in \`dossier.json\`.
- Draft-Only: Never sends automated messages; outputs formatted drafts for human copy-paste.
`;
  }

  _buildInterviewPrepSkill() {
    return `# Interview-Prep & STAR+R Story Bank

Provides realistic interview preparation grounded in factual candidate claims:
- Interactive Simulator: One question at a time across Recruiter Screen, Hiring Manager, and Executive rounds.
- Immediate Feedback: Rubric scoring on clarity, evidence, and structure.
- STAR+R Architecture: Situation, Task, Action, Result, and Reflection.
- Claim Binding: Every story metric and technology must reference a valid dossier claim ID.
- Company Intelligence: Analyzes JD requirements and company culture signals.
`;
  }

  _buildOfferReviewSkill() {
    return `# Offer-Review & GCC / KSA Contract Negotiator

Analyzes job offers and employment contracts against statutory labor standards:
- Saudi Labor Law Standards:
  - Standard Salary Breakdown: 65% Basic, 25% Housing, 10% Transportation.
  - GOSI Contributions: Saudi Nationals (21.5% total) vs Non-Saudi Residents (2% occupational hazard).
  - End-of-Service Benefits (Article 84 & 85 EOSB calculations).
  - Probation Period: 90 to 180 days statutory limits.
  - Non-Compete Review: Article 83 reasonableness (max 2 years, defined geographic scope).
- Negotiation Strategy: Collaborative, non-adversarial counter-scripts grounded in market benchmarks.
`;
  }

  _buildUpdateSkill() {
    return `# Update Skill — Refresh an Existing Workspace

Brings an existing JobHunt Crew workspace back in sync:
1. Load Current State: Read the local snapshot and note open confirmation items, stale applications, and pending decisions.
2. Replay Before Editing: Replay the append-only ledger so the snapshot reflects every recorded event. Never edit the snapshot by hand.
3. Apply One Change at a Time: New or corrected career facts enter the dossier as new verified claims and stay flagged until the candidate confirms the exact wording.
4. Learn Editorial Rules: Drafting preferences and corrections are taught to the editorial engine as reusable rules instead of being hard-coded into prompts.
5. Re-Verify Affected Drafts: Any live draft citing a changed claim is re-run through deterministic claim verification before packaging.
6. Health Check and Backup: Run workspace diagnostics and offer a local backup after significant updates.
`;
  }

  _buildApplyMultiVacancySkill() {
    return `# Apply Multi-Vacancy — Several Roles, One Employer

Handles applications to several openings at the same employer with one convergent narrative:
1. Collect the Vacancies: Gather each posting title, level, department, and requirements.
2. Triage Apply Versus Skip: Roles below target seniority or outside the specialization get an explicit skip with the reason stated; the rest get apply.
3. Build the Convergent CV: One headline and one core verified claim set serve every chosen role, drafted and verified once.
4. Per-Role Cover Letters: Each chosen role gets its own letter and focus area while facts and metrics stay identical to the convergent CV.
5. Package Per Role: Produce one application pack per chosen role, all pointing at the same convergent CV artifact.
6. Order the Submissions: Recommend a submission order with strongest fit first; every final submit stays with the human.
`;
  }

  /**
   * Packages the output directory into a zip archive using MiniZipBuilder.
   */
  packageZip(zipPath) {
    const targetZip = zipPath ? path.resolve(zipPath) : this.zipPath;
    const zipDir = path.dirname(targetZip);
    if (!fs.existsSync(zipDir)) {
      fs.mkdirSync(zipDir, { recursive: true });
    }

    const zip = new MiniZipBuilder();

    const addDirRecursive = (dir, baseDir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          addDirRecursive(fullPath, baseDir);
        } else if (entry.isFile()) {
          const content = fs.readFileSync(fullPath);
          zip.addFile(relPath, content);
        }
      }
    };

    addDirRecursive(this.outDir, this.outDir);
    const buffer = zip.build();
    fs.writeFileSync(targetZip, buffer);
    return targetZip;
  }

  /**
   * Points bundle docs (skills, agents, rules, README) at
   * cli/ instead of bin/ and drops package.json "bin" (no PATH executables).
   */
  static _rewriteBinPaths(outDir) {
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'lib' && entry.name !== BUNDLE_CLI_DIR) walk(full);
        } else if (entry.name.endsWith('.md')) {
          const text = fs.readFileSync(full, 'utf8');
          const next = text.replace(/\bbin\/crew/g, `${BUNDLE_CLI_DIR}/crew`);
          if (next !== text) fs.writeFileSync(full, next, 'utf8');
        }
      }
    };
    walk(outDir);
    const pkgPath = path.join(outDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      delete pkg.bin; // no PATH executables in a claude.ai-hosted plugin; scripts run via `node`
      if (Array.isArray(pkg.files)) pkg.files = pkg.files.map(f => (f === 'bin' ? BUNDLE_CLI_DIR : f));
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    }
  }

  /**
   * Copies a source directory tree into the bundle, skipping symlinks.
   */
  _copyDirRecursive(srcDir, destDir) {
    if (!fs.existsSync(srcDir)) return 0;
    let copied = 0;
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destDir, entry.name);
      if (entry.isDirectory()) copied += this._copyDirRecursive(src, dest);
      else if (entry.isFile()) { fs.copyFileSync(src, dest); copied++; }
    }
    return copied;
  }

  /**
   * Executes the complete compilation build.
   */
  async build() {
    if (this.clean && fs.existsSync(this.outDir)) {
      fs.rmSync(this.outDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.outDir, { recursive: true });

    // 1. Manifest
    const pluginDir = path.join(this.outDir, '.claude-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    const manifest = this.generateManifest();
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    // 2. Rules
    const rulesDir = path.join(this.outDir, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'AGENTS.md'), this.generateRules(), 'utf8');

    // 3. Skills
    const skills = this.compileSkills();
    const skillsBaseDir = path.join(this.outDir, 'skills');
    fs.mkdirSync(skillsBaseDir, { recursive: true });

    for (const [skillKey, skillDef] of Object.entries(skills)) {
      const targetSkillDir = path.join(skillsBaseDir, skillKey);
      fs.mkdirSync(targetSkillDir, { recursive: true });

      const frontmatter = ClaudePluginCompiler.formatFrontmatter({
        name: skillDef.name,
        description: skillDef.description
      });
      const fullSkillContent = frontmatter + skillDef.content;
      fs.writeFileSync(path.join(targetSkillDir, 'SKILL.md'), fullSkillContent, 'utf8');
    }

    // 4. Agents (frontmatter normalized for Claude; cross-host manifests
    //    are NOT copied: gemini-extension.json / mcp_config.json declare
    //    stdio MCP servers, which the Cowork sync validator rejects, and
    //    their hosts read them from the repository root instead)
    const agentsSrc = path.join(this.workspaceDir, 'agents');
    if (fs.existsSync(agentsSrc)) {
      const agentsOut = path.join(this.outDir, 'agents');
      fs.mkdirSync(agentsOut, { recursive: true });
      for (const entry of fs.readdirSync(agentsSrc)) {
        if (entry.endsWith('.md')) {
          const rawAgent = fs.readFileSync(path.join(agentsSrc, entry), 'utf8');
          fs.writeFileSync(path.join(agentsOut, entry), ClaudePluginCompiler.sanitizeAgentForClaude(rawAgent), 'utf8');
        }
      }
    }

    // 5. Engine runtime so a standalone bundle (zip upload, no repo clone) runs.
    //    claude.ai's validator rejects a top-level bin/ ("may not ship bin/
    //    executables"), so the entry scripts ship as cli/ in this bundle only.
    const dirMap = { bin: BUNDLE_CLI_DIR, lib: 'lib', templates: 'templates' };
    for (const [from, to] of Object.entries(dirMap)) {
      this._copyDirRecursive(path.join(this.workspaceDir, from), path.join(this.outDir, to));
    }
    for (const fileName of ['package.json', 'LICENSE', 'NOTICE', 'README.md']) {
      const src = path.join(this.workspaceDir, fileName);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(this.outDir, fileName));
    }
    ClaudePluginCompiler._rewriteBinPaths(this.outDir);

    let writtenZipPath = null;
    if (this.zip) {
      writtenZipPath = this.packageZip(this.zipPath);
    }

    return {
      outDir: this.outDir,
      version: this.version,
      skillsCount: Object.keys(skills).length,
      manifestPath: path.join(pluginDir, 'plugin.json'),
      rulesPath: path.join(rulesDir, 'AGENTS.md'),
      zipPath: writtenZipPath
    };
  }
}

module.exports = { ClaudePluginCompiler };
