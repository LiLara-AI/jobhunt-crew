'use strict';

/**
 * JobHunt Crew — CLI Claim Verification Command
 * @module lib/cli/commands/claim
 */

const fs = require('fs');
const path = require('path');
const { ClaimVerifier } = require('../../honest-cv/verify-claims');
const { parseArgs, resolveWorkspace } = require('../shared');

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

  // Relative paths are relative to the workspace (Cowork runs commands from a different cwd).
  const workspace = resolveWorkspace(flags);
  const dossierFile = path.resolve(workspace, String(dossierPath));
  const draftFile = path.resolve(workspace, String(draftPath));

  let dossier;
  try {
    const raw = fs.readFileSync(dossierFile, 'utf8');
    dossier = JSON.parse(raw);
  } catch (err) {
    console.error(`[ERROR] Failed to read dossier file at ${dossierFile}: ${err.message}`);
    return 1;
  }

  let draftText = draftPath;
  if (!fs.existsSync(draftFile) && /^[^\r\n]*\.(md|markdown|txt|html?|json|docx?|pdf|rtf)$/i.test(String(draftPath).trim())) {
    console.error(`[ERROR] Draft file not found: ${draftFile}`);
    return 1;
  }
  if (fs.existsSync(draftFile)) {
    try {
      draftText = fs.readFileSync(draftFile, 'utf8');
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

module.exports = {
  runClaim
};
