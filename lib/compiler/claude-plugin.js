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
   * Generates the canonical .claude-plugin/plugin.json manifest.
   */
  generateManifest() {
    const manifest = {
      name: 'jobhunt-crew',
      version: this.version,
      description: 'Deterministic multi-agent job search and honest CV tailoring platform with verified claims and append-only ledger.',
      author: {
        name: 'JobHunt Crew Authors'
      },
      license: 'MIT',
      metadata: {
        suggestedPrompts: [
          'Set up JobHunt Crew with my resume dossier',
          'Run job discovery sweep across target cities and boards',
          'Tailor a claim-verified CV and apply pack for this job description',
          'Review contract offer against Saudi Labor Law standards',
          'Run crew doctor diagnostics to inspect ledger and connectors'
        ]
      }
    };
    return manifest;
  }

  /**
   * Generates rules/AGENTS.md (Plain markdown with NO frontmatter).
   */
  generateRules() {
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
   * Compiles the 5 modular skill definitions.
   */
  compileSkills() {
    return {
      setup: {
        name: 'setup',
        description: 'Interactive single-question onboarding wizard that parses your resume, suggests target job titles, and initializes your local job search workspace.',
        content: this._buildSetupSkill()
      },
      'honest-cv': {
        name: 'honest-cv',
        description: 'End-to-end claim-verified CV and cover letter tailoring pipeline with blind review panel and attended browser form pre-filling stopping before submit.',
        content: this._buildHonestCvSkill()
      },
      contacto: {
        name: 'contacto',
        description: 'Drafts concise under 300 character outreach notes and follow-up messages for recruiters, hiring managers, and peers anchored in verified dossier claims.',
        content: this._buildContactoSkill()
      },
      'interview-prep': {
        name: 'interview-prep',
        description: 'Interactive mock interview simulator and STAR plus R story bank companion tied to verified candidate claims with cultural and company signal analysis.',
        content: this._buildInterviewPrepSkill()
      },
      'offer-review': {
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
