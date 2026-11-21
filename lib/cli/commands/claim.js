'use strict';

/**
 * JobHunt Crew — CLI Claim Verification Command
 * @module lib/cli/commands/claim
 */

const fs = require('fs');
const path = require('path');
const { ClaimVerifier } = require('../../honest-cv/verify-claims');
const { parseArgs, resolveWorkspace } = require('../shared');

/**
 * Marks dossier claims as confirmed by the candidate. Intake stores every
 * parsed fact as CONFIRM and the verifier blocks drafts built on those, so
 * without this step no application can ever be packaged.
 * @returns {{confirmed: string[], alreadyVerified: string[], unknown: string[], remaining: number}}
 */
function confirmClaimsInFile(dossierFile, ids, evidence) {
  const dossier = JSON.parse(fs.readFileSync(dossierFile, 'utf8'));
  const claims = Array.isArray(dossier.claims) ? dossier.claims : [];
  const wanted = ids === 'all' ? claims.map(c => c.id) : ids.map(String);
  const out = { confirmed: [], alreadyVerified: [], unknown: [], remaining: 0 };
  const now = new Date().toISOString();
  for (const id of wanted) {
    const claim = claims.find(c => String(c.id) === id);
    if (!claim) { out.unknown.push(id); continue; }
    if (claim.status === 'VERIFIED') { out.alreadyVerified.push(id); continue; }
    claim.status = 'VERIFIED';
    claim.evidence = evidence || 'Confirmed by candidate';
    claim.clarificationPrompt = null;
    claim.updatedAt = now;
    const log = dossier.claimVerificationAppendix && dossier.claimVerificationAppendix.verificationLog;
    if (Array.isArray(log)) log.push({ claimId: claim.id, action: 'VERIFIED', actor: 'candidate', timestamp: now });
    out.confirmed.push(id);
  }
  out.remaining = claims.filter(c => c.status && c.status !== 'VERIFIED').length;
  if (out.confirmed.length > 0) fs.writeFileSync(dossierFile, JSON.stringify(dossier, null, 2));
  return out;
}

function findDossierFile(workspace, explicit) {
  if (explicit) return path.resolve(workspace, String(explicit));
  const inCrew = path.join(workspace, '.crew', 'dossier.json');
  return fs.existsSync(inCrew) ? inCrew : path.join(workspace, 'dossier.json');
}

async function runClaim(subcommand, rawArgs = []) {
  if (subcommand === 'confirm') {
    const { flags } = parseArgs(rawArgs);
    const ids = flags.all ? 'all' : String(flags.id || flags.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (ids !== 'all' && ids.length === 0) {
      console.error('[ERROR] Usage: crew claim confirm --id <C-01,C-02> | --all [--evidence <text>] [--dossier <path>]');
      return 1;
    }
    const file = findDossierFile(resolveWorkspace(flags), flags.dossier);
    if (!fs.existsSync(file)) {
      console.error(`[ERROR] Dossier file not found: ${file}`);
      return 1;
    }
    const res = confirmClaimsInFile(file, ids, flags.evidence);
    console.log(`[CLAIM CONFIRM] Confirmed: ${res.confirmed.join(', ') || 'none'}. Already verified: ${res.alreadyVerified.length}. Unknown ids: ${res.unknown.join(', ') || 'none'}. Still unconfirmed: ${res.remaining}.`);
    return res.unknown.length > 0 ? 1 : 0;
  }
  if (subcommand !== 'verify') {
    console.error(`[ERROR] Unknown claim subcommand: ${subcommand}. Usage: crew claim verify --dossier <path> --draft <path> [--company <target employer>] [--json] | crew claim confirm --id <ids> | --all`);
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

  const result = ClaimVerifier.verifyDraft(dossier, draftText, { targetCompany: flags.company });

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
  runClaim,
  confirmClaimsInFile,
  findDossierFile
};
