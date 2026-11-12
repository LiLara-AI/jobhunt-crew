'use strict';

/**
 * JobHunt Crew — Self-Learning Editorial Rules Engine
 *
 * Implements persistent, versioned, traceable, and reversible editorial rules
 * learned from candidate corrections, with verification guards preventing
 * the introduction of unverified metrics, tools, or credentials.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const fs = require('fs');
const path = require('path');
const { ClaimVerifier } = require('./verify-claims');

const RULE_CATEGORIES = {
  VOCABULARY: 'vocabulary',
  OMISSION: 'omission',
  CONCISENESS: 'conciseness',
  FORMATTING: 'formatting',
  STYLING: 'styling'
};

class EditorialRuleEngine {
  /**
   * @param {Object} options Workspace directory and file paths
   */
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.crewDir = path.join(this.workspaceDir, '.crew');
    this.filePath = options.filePath || path.join(this.crewDir, 'editorial-rules.json');
    this.rules = new Map();
    this.salaryDisclosurePolicy = options.salaryDisclosurePolicy || 'mandatory_only';

    if (options.autoLoad !== false && fs.existsSync(this.filePath)) {
      this.loadSync();
    }
  }

  /**
   * Learns a new editorial rule from user correction.
   */
  learnRuleFromCorrection(id, originalPattern, preferredReplacement, rationale, options = {}) {
    if (!id || typeof id !== 'string') {
      throw new Error('RULE_ERROR: Rule ID must be a non-empty string');
    }
    if (!originalPattern) {
      throw new Error('RULE_ERROR: Pattern is required');
    }

    const category = options.category || RULE_CATEGORIES.VOCABULARY;
    const actor = options.actor || 'human';
    const now = new Date().toISOString();

    const existing = this.rules.get(id);
    const version = existing ? existing.version + 1 : 1;
    const history = existing ? [...existing.history] : [];

    history.push({
      action: existing ? 'updated' : 'created',
      version,
      actor,
      timestamp: now,
      note: options.note || rationale || 'Learned from user correction'
    });

    const rule = {
      id,
      version,
      category,
      scope: options.scope || 'global',
      pattern: originalPattern,
      isRegex: options.isRegex || false,
      caseSensitive: options.caseSensitive || false,
      replacement: preferredReplacement !== undefined ? preferredReplacement : '',
      rationale: rationale || '',
      active: true,
      createdBy: actor,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      undoneAt: null,
      history
    };

    this.rules.set(id, rule);
    this.saveSync();
    return rule;
  }

  /**
   * Deactivates a rule while preserving its full history and audit trail.
   */
  undoRule(id, actor = 'human') {
    const rule = this.rules.get(id);
    if (!rule) {
      throw new Error(`Rule not found: ${id}`);
    }

    rule.active = false;
    rule.undoneAt = new Date().toISOString();
    rule.history.push({
      action: 'undone',
      version: rule.version,
      actor,
      timestamp: rule.undoneAt,
      note: 'Rule deactivated via undo'
    });

    this.saveSync();
    return rule;
  }

  /**
   * Reactivates a previously undone rule.
   */
  reactivateRule(id, actor = 'human') {
    const rule = this.rules.get(id);
    if (!rule) {
      throw new Error(`Rule not found: ${id}`);
    }

    rule.active = true;
    rule.undoneAt = null;
    rule.updatedAt = new Date().toISOString();
    rule.history.push({
      action: 'reactivated',
      version: rule.version,
      actor,
      timestamp: rule.updatedAt,
      note: 'Rule reactivated'
    });

    this.saveSync();
    return rule;
  }

  /**
   * Applies all active rules to draft text.
   * Optionally guards against unverified claims if dossier is provided.
   */
  applyRules(text, options = {}) {
    let result = text;
    const matchesApplied = [];

    for (const rule of this.rules.values()) {
      if (!rule.active) continue;

      let regex;
      if (rule.pattern instanceof RegExp) {
        regex = rule.pattern;
      } else if (rule.isRegex) {
        regex = new RegExp(rule.pattern, rule.caseSensitive ? 'g' : 'gi');
      } else {
        // Escape literal string pattern
        const escaped = rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(escaped, rule.caseSensitive ? 'g' : 'gi');
      }

      if (regex.test(result)) {
        result = result.replace(regex, rule.replacement);
        matchesApplied.push(rule.id);
      }
    }

    // Safety Verification Guard: If candidate dossier is provided, verify transformed draft
    if (options.dossier) {
      const verification = ClaimVerifier.verifyDraft(options.dossier, result);
      if (!verification.passed) {
        const error = new Error(`EDITORIAL_GUARD_VIOLATION: Applying editorial rules introduced unverified claim`);
        error.verification = verification;
        error.appliedRules = matchesApplied;
        throw error;
      }
    }

    return result;
  }

  /**
   * Lists rules with optional filtering.
   */
  listRules(filter = {}) {
    let list = Array.from(this.rules.values());

    if (filter.active !== undefined) {
      list = list.filter(r => r.active === filter.active);
    }
    if (filter.category) {
      list = list.filter(r => r.category === filter.category);
    }
    if (filter.scope) {
      list = list.filter(r => r.scope === filter.scope);
    }

    return list;
  }

  /**
   * Loads rules synchronously from .crew/editorial-rules.json.
   */
  loadSync() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      this.salaryDisclosurePolicy = data.salaryDisclosurePolicy || this.salaryDisclosurePolicy;
      if (Array.isArray(data.rules)) {
        for (const r of data.rules) {
          this.rules.set(r.id, r);
        }
      }
    } catch (_) {}
  }

  /**
   * Saves rules synchronously and atomically to .crew/editorial-rules.json.
   */
  saveSync() {
    try {
      if (!fs.existsSync(this.crewDir)) {
        fs.mkdirSync(this.crewDir, { recursive: true });
      }

      const payload = {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        salaryDisclosurePolicy: this.salaryDisclosurePolicy,
        rules: Array.from(this.rules.values())
      };

      const tmpFile = `${this.filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpFile, this.filePath);
    } catch (_) {}
  }

  /**
   * Exports human-readable Markdown summary.
   */
  exportMarkdown() {
    const lines = [
      '# Editorial Rules',
      '',
      `> Salary Disclosure Policy: **${this.salaryDisclosurePolicy}**`,
      '',
      '## Active Rules'
    ];

    const activeRules = this.listRules({ active: true });
    if (activeRules.length === 0) {
      lines.push('_No active editorial rules._');
    } else {
      for (const r of activeRules) {
        lines.push(`- **${r.id}** [${r.category}]: Replace \`${r.pattern}\` with \`${r.replacement}\` — _${r.rationale || 'User preference'}_`);
      }
    }

    lines.push('');
    return lines.join('\n');
  }
}

module.exports = {
  EditorialRuleEngine,
  RULE_CATEGORIES
};
