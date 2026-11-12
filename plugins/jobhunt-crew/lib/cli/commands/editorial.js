'use strict';

/**
 * JobHunt Crew — CLI Editorial Rules Commands
 *
 * Exposes the self-learning editorial rule engine (lib/honest-cv/editorial-rules)
 * on the CLI: list learned rules, learn from a correction, undo a rule, and
 * apply active rules to draft text.
 *
 * @module lib/cli/commands/editorial
 */

const fs = require('fs');
const path = require('path');
const { EditorialRuleEngine } = require('../../honest-cv/editorial-rules');
const { parseArgs, resolveWorkspace } = require('../shared');

function readTextArg(value) {
  if (typeof value === 'string' && fs.existsSync(value)) {
    return fs.readFileSync(path.resolve(value), 'utf8');
  }
  return value;
}

async function runEditorial(subcommand, rawArgs = []) {
  const { flags, positional } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const engine = new EditorialRuleEngine({ workspaceDir: targetDir });

  if (subcommand === 'list') {
    const filter = {};
    if (flags.active === true) filter.active = true;
    if (flags.inactive === true) filter.active = false;
    if (flags.category) filter.category = flags.category;
    const rules = engine.listRules(filter);
    if (flags.json) {
      console.log(JSON.stringify(rules, null, 2));
      return 0;
    }
    console.log(`[EDITORIAL] ${rules.length} rule(s):`);
    for (const r of rules) {
      console.log(`  - ${r.id} [${r.category}] (${r.active ? 'active' : 'undone'}, v${r.version}): "${r.pattern}" -> "${r.replacement}"`);
    }
    return 0;
  }

  if (subcommand === 'learn') {
    const id = flags.id || flags.i || positional[0];
    const pattern = flags.pattern || flags.original;
    const replacement = flags.replacement !== undefined ? flags.replacement : (flags.preferred || '');
    const rationale = flags.rationale || flags.note || '';
    if (!id || !pattern) {
      console.error('[ERROR] Missing required flags: --id <id> --pattern <text> [--replacement <text>] [--rationale <text>]');
      return 1;
    }
    try {
      const rule = engine.learnRuleFromCorrection(id, pattern, replacement, rationale, {
        category: flags.category,
        scope: flags.scope,
        isRegex: flags.regex === true,
        caseSensitive: flags.caseSensitive === true || flags['case-sensitive'] === true,
        actor: flags.actor || 'human'
      });
      console.log(JSON.stringify(rule, null, 2));
      return 0;
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      return 1;
    }
  }

  if (subcommand === 'undo') {
    const id = flags.id || flags.i || positional[0];
    if (!id) {
      console.error('[ERROR] Missing required flag: --id <rule-id>');
      return 1;
    }
    try {
      const rule = engine.undoRule(id, flags.actor || 'human');
      console.log(JSON.stringify(rule, null, 2));
      return 0;
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      return 1;
    }
  }

  if (subcommand === 'apply') {
    const draftArg = flags.draft || flags.text || positional[0];
    if (!draftArg) {
      console.error('[ERROR] Missing required input: --draft <path|text>');
      return 1;
    }
    let dossier;
    if (flags.dossier) {
      try {
        dossier = JSON.parse(fs.readFileSync(path.resolve(flags.dossier), 'utf8'));
      } catch (err) {
        console.error(`[ERROR] Failed to read dossier file at ${flags.dossier}: ${err.message}`);
        return 1;
      }
    }
    try {
      const result = engine.applyRules(readTextArg(draftArg), { dossier });
      if (flags.out) {
        const outFile = path.resolve(flags.out);
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, result, 'utf8');
        console.log(`[EDITORIAL] Applied rules. Output written to: ${outFile}`);
      } else {
        console.log(result);
      }
      return 0;
    } catch (err) {
      console.error(`[ERROR] ${err.message}`);
      return 1;
    }
  }

  console.error(`[ERROR] Unknown editorial subcommand: ${subcommand}. Usage: crew editorial <list|learn|undo|apply> [options]`);
  return 1;
}

module.exports = {
  runEditorial
};
