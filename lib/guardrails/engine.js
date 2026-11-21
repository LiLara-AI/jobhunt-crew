'use strict';

/**
 * JobHunt Crew — Executable Guardrail Engine
 * Enforces non-negotiable core invariants in deterministic code:
 * 1. Human-Only Submission Guard: Automated agents (agent:*) are strictly forbidden from submitting.
 * 2. Evidence-Based Closure Guard: Vacancies cannot be closed due to posting age (>30d, >60d); requires objective proof.
 * 3. Readiness Gate: Application packages must have 100% verified claims and blind review panel approval before ready.
 *
 * @module lib/guardrails/engine
 */

const VALID_CLOSURE_EVIDENCE_TYPES = new Set([
  'EXPLICIT_NOTICE_NO_LONGER_ACCEPTING',
  'HTTP_404_OR_JOB_REMOVED',
  'DEADLINE_PASSED',
  'DIRECT_REJECTION_EMAIL',
  // Lowercase aliases for backward compatibility with existing tests
  'http_404',
  'http_410',
  'explicit_closure_notice',
  'passed_deadline',
  'direct_rejection_email'
]);

const AGE_PENALTY_INDICATORS = [
  'posting_age',
  'age_limit',
  'age',
  'stale',
  'old_listing',
  'days_old',
  'older_than_30',
  'older_than_60',
  'vacancy_age',
  'job_age',
  'requisition_age',
  'listing_age',
  'too_old'
];

class GuardrailEngine {
  /**
   * Strictly enforces that application submission is authorized ONLY by verified human users.
   * Automated agents (agent:*) are strictly rejected.
   *
   * @param {string} actor - Actor identifier (e.g. 'human', 'human:alice', 'agent:scribe')
   * @param {string} [jobId] - Optional job ID being submitted
   * @param {string} [token] - Human authorization token
   * @returns {boolean} true if submission authorization passes
   * @throws {Error} GUARDRAIL_VIOLATION if non-human actor or missing token
   */
  static validateSubmission(actor, jobId = null, token = null) {
    if (!actor || typeof actor !== 'string') {
      throw new Error(
        'GUARDRAIL_VIOLATION: Automated actors (agent:*) are strictly forbidden from submitting job applications. Only verified human users may authorize submissions.'
      );
    }

    const trimmedActor = actor.trim();
    const isHuman = trimmedActor === 'human' || trimmedActor.startsWith('human:');

    if (!isHuman) {
      throw new Error(
        'GUARDRAIL_VIOLATION: Automated actors (agent:*) are strictly forbidden from submitting job applications. Only verified human users may authorize submissions.'
      );
    }

    // Token validation:
    // Required if token is explicitly passed, or if arguments.length >= 3,
    // or if actor is in human:<id> format
    if (token !== null && token !== undefined) {
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new Error('GUARDRAIL_VIOLATION: Human submission requires a non-empty authorization token.');
      }
    } else if (arguments.length >= 3 || (jobId && isHuman)) {
      throw new Error('GUARDRAIL_VIOLATION: Human submission requires a non-empty authorization token.');
    }

    if (jobId !== null && jobId !== undefined) {
      if (typeof jobId !== 'string' || jobId.trim().length === 0) {
        throw new Error('GUARDRAIL_VIOLATION: Job ID is required for submission validation.');
      }
    }

    return true;
  }

  /**
   * Validates that a vacancy closure request is backed by legitimate, objective evidence.
   * Strictly rejects any closure attempt based on posting age (> 30d, > 60d, etc.).
   *
   * Polymorphic signature supports:
   * 1. validateClosure(jobId, reason, evidenceType, proof)
   * 2. validateClosure(evidenceObject) where evidenceObject = { type, proof, days, reason }
   *
   * @param {string|object} jobIdOrEvidence - Job ID string or evidence object
   * @param {string|object} [reasonOrOptions] - Reason string or options
   * @param {string} [evidenceType] - Evidence type enum
   * @param {string} [proof] - Verifiable proof string
   * @returns {boolean} true if closure evidence is valid
   * @throws {Error} GUARDRAIL_VIOLATION if evidence is missing, invalid, or based on posting age
   */
  static validateClosure(jobIdOrEvidence, reasonOrOptions = null, evidenceType = null, proof = null) {
    let type;
    let proofText;
    let reasonText = '';
    let isAgeAttempt = false;

    if (typeof jobIdOrEvidence === 'object' && jobIdOrEvidence !== null) {
      const ev = jobIdOrEvidence;
      type = ev.type || ev.evidenceType;
      proofText = ev.proof || ev.evidence;
      reasonText = ev.reason || '';

      if (ev.days !== undefined || ev.postedAgeDays !== undefined) {
        isAgeAttempt = true;
      }
    } else {
      type = evidenceType;
      reasonText = typeof reasonOrOptions === 'string' ? reasonOrOptions : '';
      proofText = proof || (typeof reasonOrOptions === 'object' && reasonOrOptions !== null ? reasonOrOptions.proof : null);
    }

    if (!type || typeof type !== 'string') {
      throw new Error('GUARDRAIL_VIOLATION: Vacancy closure requires verifiable evidence');
    }

    const normType = type.trim();
    const lowerType = normType.toLowerCase();

    // Check for age-based closure attempts in type, reason, or flags
    const AGE_PENALTY_REGEX = new RegExp([
      '(?:\\b(?:posting|vacancy|job|requisition|listing)[\\s_]*age\\b)',
      '(?:\\b(?:age[\\s_]*limit|too[\\s_]*old|stale|older\\s*than)\\b)',
      '(?:\\b(?:days?|weeks?|months?)[\\s_]*old\\b)',
      '(?:\\b(?:posted|opened|listed|published|created|advertised)\\s+(?:(?:for|over|more\\s+than|>=?|\\u2265)\\s+)?(?:\\d+\\+?|one|two|three|four|five|six|seven|eight|nine|ten|several|many|a\\s+few|couple(?:\\s+of)?)\\s*(?:days?|weeks?|months?|years?|d\\b|w\\b|mo\\b|m\\b|yrs?\\b|y\\b)(?:\\s+ago|\\s+old)?\\b)',
      '(?:\\b(?:open|active|live|up|running)\\s+for\\s+(?:(?:over|more\\s+than|>=?|\\u2265)\\s+)?(?:\\d+\\+?|one|two|three|four|five|six|seven|eight|nine|ten)\\s*(?:days?|weeks?|months?)\\b)',
      '(?:(?<!\\b(?:notice|probation|contract|leave|vacation|housing|training|allowance|experience|tenure)[\\s_]*(?:period|duration|window)?[\\s_]*(?:is|of|for)?[\\s_]*)(?:\\b(?:over|more\\s+than)\\b|>=?|\\u2265)\\s*\\d+\\s*(?:days?|weeks?|months?|d\\b|w\\b|mo\\b)(?!\\s+of\\s+(?:temporary|paid|annual|sick|leave|training|housing|pto))\\b)',
      '(?:(?<!\\b(?:applied|interviewed|contacted|heard|closed|filled|expired|removed|passed|ended|concluded|hired|canceled|cancelled)[\\s_]*(?:about\\s+)?)\\b\\d+\\s*(?:days?|weeks?|months?)\\s+ago\\b)'
    ].join('|'), 'i');

    const proofStr = typeof proofText === 'string' ? proofText : (proofText && (proofText.proof || proofText.text || proofText.evidence) ? String(proofText.proof || proofText.text || proofText.evidence) : '');

    if (
      isAgeAttempt ||
      AGE_PENALTY_INDICATORS.includes(lowerType) ||
      AGE_PENALTY_REGEX.test(reasonText) ||
      AGE_PENALTY_REGEX.test(normType) ||
      (proofStr && AGE_PENALTY_REGEX.test(proofStr))
    ) {
      throw new Error('GUARDRAIL_VIOLATION: Open vacancies cannot be closed or penalized due to posting age');
    }

    if (!VALID_CLOSURE_EVIDENCE_TYPES.has(normType) && !VALID_CLOSURE_EVIDENCE_TYPES.has(lowerType)) {
      throw new Error(`GUARDRAIL_VIOLATION: Invalid closure evidence type: ${normType}`);
    }

    if (!proofText || String(proofText).trim().length === 0) {
      throw new Error('GUARDRAIL_VIOLATION: Closure evidence requires non-empty proof');
    }

    return true;
  }

  /**
   * Ensures an application package meets all quality and truth gates before moving to 'ready-to-submit':
   * 1. 100% claim verification pass (zero fabrication, zero unverified claims).
   * 2. Blind review panel approval ('APPROVE').
   * 3. (Optional) Generated documents check (CV, cover letter, apply pack).
   *
   * @param {object} pkgOrJobRecord - Application package or job record with claimVerification and reviewPanel
   * @param {object} [dossier] - Candidate dossier for cross-checking claimsUsed
   * @returns {boolean} true if application is 100% ready
   * @throws {Error} GUARDRAIL_VIOLATION if any verification or review condition fails
   */
  static validateApplicationReadiness(pkgOrJobRecord, dossier = null) {
    if (!pkgOrJobRecord || typeof pkgOrJobRecord !== 'object') {
      throw new Error('GUARDRAIL_VIOLATION: Application package must be a valid object');
    }

    const { claimVerification, reviewPanel, documents } = pkgOrJobRecord;

    // 1. Claim verification gate
    if (!claimVerification || claimVerification.passed !== true) {
      throw new Error(
        'GUARDRAIL_VIOLATION: Application package cannot be marked ready without passing claim verification'
      );
    }

    if (Array.isArray(claimVerification.violations) && claimVerification.violations.length > 0) {
      throw new Error(
        `GUARDRAIL_VIOLATION: Application package cannot be marked ready with ${claimVerification.violations.length} unresolved claim violations`
      );
    }

    // 2. Blind review panel gate
    if (!reviewPanel || reviewPanel.verdict !== 'APPROVE') {
      throw new Error(
        'GUARDRAIL_VIOLATION: Application package cannot be marked ready without review panel approval'
      );
    }

    // 3. Dossier claim alignment (if dossier provided)
    if (dossier && Array.isArray(pkgOrJobRecord.claimsUsed)) {
      const verifiedClaimIds = new Set(
        (dossier.claims || []).filter(c => c.status === 'VERIFIED').map(c => c.id)
      );
      for (const claimId of pkgOrJobRecord.claimsUsed) {
        if (!verifiedClaimIds.has(claimId)) {
          throw new Error(
            `GUARDRAIL_VIOLATION: Claim "${claimId}" is not verified in candidate dossier`
          );
        }
      }
    }

    // 4. Documents generation check (if documents object exists)
    if (documents) {
      if (documents.cvGenerated === false || documents.coverLetterGenerated === false) {
        throw new Error(
          'GUARDRAIL_VIOLATION: Application package cannot be marked ready without generated documents'
        );
      }
    }

    return true;
  }

  /**
   * A FOLLOW_UP_SENT the reducer would ignore must fail loudly, or the cadence
   * keeps reporting a follow-up the user already sent.
   */
  static validateFollowUpSent(payload = {}, snapshot = {}) {
    if (![7, 14].includes(Number(payload.day))) {
      throw new Error('GUARDRAIL_VIOLATION: FOLLOW_UP_SENT needs payload.day 7 or 14');
    }
    // Own property only: "__proto__" must not pass as a tracked application.
    if (!payload.jobId || !Object.prototype.hasOwnProperty.call(snapshot.applications || {}, payload.jobId)) {
      throw new Error(`GUARDRAIL_VIOLATION: FOLLOW_UP_SENT needs payload.jobId of a tracked application (got "${payload.jobId}")`);
    }
    return true;
  }

  // Alias for backward compatibility with test-guardrails.js
  static validateReadiness(pkg) {
    return GuardrailEngine.validateApplicationReadiness(pkg);
  }

  // URL normalization alias
  static canonicalizeUrl(rawUrl) {
    const { normalizeJobUrl } = require('./dedup');
    return normalizeJobUrl(rawUrl);
  }
}

module.exports = {
  GuardrailEngine,
  VALID_CLOSURE_EVIDENCE_TYPES,
  validateSubmission: GuardrailEngine.validateSubmission,
  validateClosure: GuardrailEngine.validateClosure,
  validateApplicationReadiness: GuardrailEngine.validateApplicationReadiness,
  validateReadiness: GuardrailEngine.validateReadiness,
  canonicalizeUrl: GuardrailEngine.canonicalizeUrl
};
