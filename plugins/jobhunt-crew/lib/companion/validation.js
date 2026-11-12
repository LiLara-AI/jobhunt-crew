'use strict';

/**
 * JobHunt Crew — Companion Validation Gate & Guardrail Enforcement
 *
 * Implements deterministic validation for proposals written by Gemini Desktop Companion.
 * Enforces the non-negotiable core invariants:
 * 1. Rule 1: Strict Human Submission Invariant (agents/companion cannot submit applications).
 * 2. Rule 2: Draft Quarantine & Honest-CV Gating (companion drafts must pass Inquisitor).
 * 3. Rule 3: Claim Gating with [CONFIRM] (new candidate claims cannot be directly verified).
 * 4. Schema Validation for the 4 core proposal kinds:
 *    - triage_decision
 *    - claim_confirmation (and claim_proposal)
 *    - draft_proposal
 *    - pack_approval
 * 5. Filename & Path Traversal Protection.
 *
 * Location: lib/companion/validation.js
 * Zero external dependencies.
 */

const PATH_TRAVERSAL_PATTERN = /(\.\.[\/\\]|[<>:"\\|?*\x00-\x1F])/;

const VALID_PROPOSAL_TYPES = new Set([
  'triage_decision',
  'claim_confirmation',
  'draft_proposal',
  'pack_approval',
  'claim_proposal',
  'candidate_fact_proposal',
  'status_update'
]);

const VALID_TRIAGE_DECISIONS = new Set([
  'shortlist',
  'select',
  'apply',
  'not_interested',
  'exclude',
  'reject',
  'park',
  'hold'
]);

const VALID_DRAFT_TYPES = new Set([
  'cv',
  'cl',
  'cover_letter',
  'outreach',
  'notes',
  'custom'
]);

const VALID_PACK_VERDICTS = new Set([
  'APPROVE',
  'REJECT',
  'REVISE'
]);

class CompanionValidationGate {
  /**
   * Sanitizes an identifier (jobId, claimId, filename) to prevent path traversal
   * and illegal Windows / POSIX filesystem characters.
   *
   * @param {string} id - The identifier to sanitize
   * @returns {string} Sanitized identifier
   * @throws {Error} If identifier contains path traversal sequences or illegal characters
   */
  static sanitizeIdentifier(id) {
    if (!id || typeof id !== 'string') {
      throw new Error('IDENTIFIER_ERROR: Identifier must be a non-empty string');
    }
    const trimmed = id.trim();
    if (trimmed.length === 0) {
      throw new Error('IDENTIFIER_ERROR: Identifier cannot be blank');
    }

    // Iterative URL decoding (up to 3 levels) to uncover multi-layer percent-encoding
    let decoded = trimmed;
    let prev = '';
    let depth = 0;
    while (decoded !== prev && depth < 3) {
      prev = decoded;
      depth++;
      try {
        decoded = decodeURIComponent(decoded);
      } catch (_) {
        throw new Error(`SECURITY_VIOLATION: Identifier contains invalid URL encoding: "${id}"`);
      }
    }

    // Reject isolated dots, dot-only sequences, relative dot-dots, path separators, and illegal filesystem chars
    if (
      trimmed === '.' || trimmed === '..' || /^\.+$/.test(trimmed) ||
      decoded === '.' || decoded === '..' || /^\.+$/.test(decoded) ||
      trimmed.includes('..') || decoded.includes('..') ||
      trimmed.includes('/') || trimmed.includes('\\') ||
      decoded.includes('/') || decoded.includes('\\') ||
      PATH_TRAVERSAL_PATTERN.test(trimmed) ||
      PATH_TRAVERSAL_PATTERN.test(decoded)
    ) {
      throw new Error(`SECURITY_VIOLATION: Identifier contains illegal characters or path traversal sequences: "${id}"`);
    }
    return trimmed;
  }

  /**
   * Validates a proposal object or raw JSON string against all core invariants and schemas.
   *
   * @param {object|string} proposalInput - Parsed JSON object or raw JSON string
   * @param {object} [options]
   * @param {object} [options.dossier] - Candidate dossier for cross-referencing employers and claims
   * @returns {object} Validation verdict:
   *   { valid: boolean, ingested: boolean, error?: string, code?: string, action?: string, status?: string, ... }
   */
  static validateProposal(proposalInput, options = {}) {
    let proposal = proposalInput;

    // 1. JSON Parse Check
    if (typeof proposalInput === 'string') {
      try {
        const cleanInput = proposalInput.charCodeAt(0) === 0xFEFF
          ? proposalInput.slice(1)
          : proposalInput;
        proposal = JSON.parse(cleanInput);
      } catch (parseErr) {
        return {
          valid: false,
          ingested: false,
          code: 'MALFORMED_JSON',
          error: 'MALFORMED_JSON',
          details: `Could not parse proposal JSON: ${parseErr.message}`,
          stateCorrupted: false,
          quarantine: false
        };
      }
    }

    if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
      return {
        valid: false,
        ingested: false,
        code: 'INVALID_OBJECT',
        error: 'INVALID_OBJECT: Proposal must be a non-null, non-array JSON object',
        stateCorrupted: false,
        quarantine: false
      };
    }

    // 2. Type Check
    if (!proposal.type || typeof proposal.type !== 'string') {
      return {
        valid: false,
        ingested: false,
        code: 'MISSING_REQUIRED_FIELDS',
        error: 'MISSING_REQUIRED_FIELDS',
        details: 'Proposal requires a non-empty string "type"',
        stateCorrupted: false,
        quarantine: false
      };
    }

    const type = proposal.type.trim().toLowerCase();

    // ========================================================================
    // RULE 1: STRICT HUMAN SUBMISSION INVARIANT
    // Block any attempt to mark an application submitted via companion
    // ========================================================================
    const actionNorm = String(proposal.action || '').trim().toLowerCase();
    const statusNorm = String(proposal.status || '').trim().toLowerCase();
    const eventNorm = String(proposal.event || '').trim().toLowerCase();
    const payloadActionNorm = String(proposal.payload?.action || '').trim().toLowerCase();
    const payloadStatusNorm = String(proposal.payload?.status || '').trim().toLowerCase();
    const payloadEventNorm = String(proposal.payload?.event || '').trim().toLowerCase();
    const detailsSubmitted = proposal.details?.submitted === true ||
      String(proposal.details?.submitted || '').trim().toLowerCase() === 'true';
    const detailsStatusNorm = String(proposal.details?.status || '').trim().toLowerCase();
    const detailsActionNorm = String(proposal.details?.action || '').trim().toLowerCase();

    const SUBMISSION_KEYWORDS = new Set([
      'submitted',
      'submit',
      'submitting',
      'application_submitted',
      'job_submitted',
      'submission'
    ]);

    const claimsSubmission =
      SUBMISSION_KEYWORDS.has(actionNorm) ||
      SUBMISSION_KEYWORDS.has(statusNorm) ||
      SUBMISSION_KEYWORDS.has(type) ||
      SUBMISSION_KEYWORDS.has(eventNorm) ||
      SUBMISSION_KEYWORDS.has(payloadActionNorm) ||
      SUBMISSION_KEYWORDS.has(payloadStatusNorm) ||
      SUBMISSION_KEYWORDS.has(payloadEventNorm) ||
      SUBMISSION_KEYWORDS.has(detailsStatusNorm) ||
      SUBMISSION_KEYWORDS.has(detailsActionNorm) ||
      detailsSubmitted;

    if (claimsSubmission) {
      return {
        valid: false,
        ingested: false,
        code: 'GUARDRAIL_VIOLATION_SUBMISSION_BLOCKED',
        error: 'GUARDRAIL_VIOLATION: Companion proposal cannot declare an application submitted without human confirmation',
        ruleViolated: 'RULE_1_STRICT_HUMAN_SUBMISSION',
        stateCorrupted: false,
        quarantine: false
      };
    }

    // ========================================================================
    // ZERO AGE PENALTY GUARDRAIL INVARIANT
    // Open vacancies cannot be closed or penalized due to posting age
    // ========================================================================
    const triageDec = String(proposal.decision || '').trim().toLowerCase();
    if (type === 'triage_decision' && (triageDec === 'not_interested' || triageDec === 'exclude' || triageDec === 'reject')) {
      // Concatenate all explanatory fields so secondary notes are not masked
      const reason = [proposal.reason, proposal.rationale, proposal.notes]
        .filter(x => typeof x === 'string' && x.trim().length > 0)
        .join(' ');

      const evidence = proposal.evidence || {};
      const evidenceType = String(evidence.type || '').trim().toLowerCase();
      const hasAgeEvidence =
        evidenceType === 'posting_age' ||
        evidenceType === 'posting age' ||
        evidence.days !== undefined ||
        evidence.postedAgeDays !== undefined;

      const AGE_PENALTY_REGEX = new RegExp([
        '(?:\\b(?:posting|vacancy|job|requisition|listing)[\\s_]*age\\b)',
        '(?:\\b(?:age[\\s_]*limit|too[\\s_]*old|stale|older\\s*than)\\b)',
        '(?:\\b(?:days?|weeks?|months?)[\\s_]*old\\b)',
        '(?:\\b(?:posted|opened|listed|published|created|advertised)\\s+(?:(?:for|over|more\\s+than|>=?|\\u2265)\\s+)?(?:\\d+\\+?|one|two|three|four|five|six|seven|eight|nine|ten|several|many|a\\s+few|couple(?:\\s+of)?)\\s*(?:days?|weeks?|months?|years?|d\\b|w\\b|mo\\b|m\\b|yrs?\\b|y\\b)(?:\\s+ago|\\s+old)?\\b)',
        '(?:\\b(?:open|active|live|up|running)\\s+for\\s+(?:(?:over|more\\s+than|>=?|\\u2265)\\s+)?(?:\\d+\\+?|one|two|three|four|five|six|seven|eight|nine|ten)\\s*(?:days?|weeks?|months?)\\b)',
        '(?:(?<!\\b(?:notice|probation|contract|leave|vacation|housing|training|allowance|experience|tenure)[\\s_]*(?:period|duration|window)?[\\s_]*(?:is|of|for)?[\\s_]*)(?:\\b(?:over|more\\s+than)\\b|>=?|\\u2265)\\s*\\d+\\s*(?:days?|weeks?|months?|d\\b|w\\b|mo\\b)(?!\\s+of\\s+(?:temporary|paid|annual|sick|leave|training|housing|pto))\\b)',
        '(?:(?<!\\b(?:applied|interviewed|contacted|heard|closed|filled|expired|removed|passed|ended|concluded|hired|canceled|cancelled)[\\s_]*(?:about\\s+)?)\\b\\d+\\s*(?:days?|weeks?|months?)\\s+ago\\b)'
      ].join('|'), 'i');

      if (AGE_PENALTY_REGEX.test(reason) || hasAgeEvidence) {
        return {
          valid: false,
          ingested: false,
          code: 'GUARDRAIL_VIOLATION_AGE_PENALTY',
          error: 'GUARDRAIL_VIOLATION: Open vacancies cannot be closed or penalized due to posting age',
          ruleViolated: 'AGE_PENALTY_INVARIANT',
          stateCorrupted: false,
          quarantine: false
        };
      }
    }

    // Type recognition
    if (!VALID_PROPOSAL_TYPES.has(type)) {
      return {
        valid: false,
        ingested: false,
        code: 'UNKNOWN_PROPOSAL_TYPE',
        error: `UNKNOWN_PROPOSAL_TYPE: Unrecognized proposal type "${proposal.type}"`,
        stateCorrupted: false,
        quarantine: false
      };
    }

    // ========================================================================
    // RULE 2: DRAFT PROPOSAL & QUARANTINE
    // ========================================================================
    if (type === 'draft_proposal') {
      const targetId = proposal.jobId || proposal.id;
      if (!targetId || typeof targetId !== 'string') {
        return {
          valid: false,
          ingested: false,
          code: 'MISSING_REQUIRED_FIELDS',
          error: 'MISSING_REQUIRED_FIELDS',
          details: 'Draft proposal requires a valid "jobId"',
          stateCorrupted: false,
          quarantine: false
        };
      }

      let sanitizedJobId;
      try {
        sanitizedJobId = CompanionValidationGate.sanitizeIdentifier(targetId);
      } catch (secErr) {
        const isSecurity = secErr.message.startsWith('SECURITY_VIOLATION');
        return {
          valid: false,
          ingested: false,
          code: isSecurity ? 'SECURITY_VIOLATION' : 'IDENTIFIER_ERROR',
          error: secErr.message,
          stateCorrupted: false,
          quarantine: false
        };
      }

      const draftText = proposal.draftText || proposal.cvText || proposal.clText || proposal.text;
      if (!draftText || typeof draftText !== 'string' || draftText.trim().length === 0) {
        return {
          valid: false,
          ingested: false,
          code: 'EMPTY_DRAFT_TEXT',
          error: 'EMPTY_DRAFT_TEXT: Draft proposal requires non-empty draft text ("draftText", "cvText", or "clText")',
          stateCorrupted: false,
          quarantine: false
        };
      }

      // Premature readiness guard
      const draftStatusNorm = String(proposal.status || '').trim().toLowerCase().replace(/_/g, '-');
      const draftActionNorm = String(proposal.action || '').trim().toLowerCase().replace(/_/g, '-');
      const verifiedNorm = proposal.verified === true ||
        String(proposal.verified || '').trim().toLowerCase() === 'true';

      const PREMATURE_STATUSES = new Set(['ready', 'ready-to-submit', 'verified', 'approved']);

      if (
        PREMATURE_STATUSES.has(draftStatusNorm) ||
        PREMATURE_STATUSES.has(draftActionNorm) ||
        verifiedNorm
      ) {
        return {
          valid: false,
          ingested: false,
          code: 'GUARDRAIL_VIOLATION_PREMATURE_READINESS',
          error: 'GUARDRAIL_VIOLATION: Companion draft proposal cannot declare readiness or bypass claim verification',
          ruleViolated: 'RULE_2_DRAFT_QUARANTINE',
          stateCorrupted: false,
          quarantine: false
        };
      }

      const rawDraftType = (proposal.draftType || 'cv').toLowerCase();
      const draftType = rawDraftType === 'cover_letter' ? 'cl' : rawDraftType;
      if (!VALID_DRAFT_TYPES.has(draftType) && !VALID_DRAFT_TYPES.has(rawDraftType)) {
        return {
          valid: false,
          ingested: false,
          code: 'INVALID_DRAFT_TYPE',
          error: `INVALID_DRAFT_TYPE: Unsupported draftType "${proposal.draftType}"`,
          stateCorrupted: false,
          quarantine: false
        };
      }

      // Valid draft -> Must be quarantined pending Inquisitor gate
      return {
        valid: true,
        ingested: true,
        action: 'HOLD_FOR_CLAIM_VERIFICATION',
        jobId: sanitizedJobId,
        draftType: rawDraftType,
        draftText: draftText.trim(),
        claimsUsed: Array.isArray(proposal.claimsUsed) ? proposal.claimsUsed : [],
        persona: proposal.persona || 'RECRUITER',
        status: 'pending_inquisitor_verification',
        quarantine: true,
        stateCorrupted: false,
        proposal
      };
    }

    // ========================================================================
    // RULE 3: CLAIM PROPOSAL (NEW CLAIMS GATED TO 'CONFIRM')
    // ========================================================================
    if (type === 'claim_proposal' || type === 'candidate_fact_proposal') {
      const claimText = proposal.claimText || proposal.text;
      if (!claimText || typeof claimText !== 'string' || claimText.trim().length === 0) {
        return {
          valid: false,
          ingested: false,
          code: 'EMPTY_CLAIM_TEXT',
          error: 'EMPTY_CLAIM_TEXT: Claim proposal requires non-empty "claimText" or "text"',
          stateCorrupted: false,
          quarantine: false
        };
      }

      const employerId = proposal.employerId || proposal.employer;
      if (!employerId || typeof employerId !== 'string') {
        return {
          valid: false,
          ingested: false,
          code: 'MISSING_EMPLOYER_ID',
          error: 'MISSING_EMPLOYER_ID: Claim proposal must be bound to an "employerId"',
          stateCorrupted: false,
          quarantine: false
        };
      }

      let sanitizedEmployerId;
      try {
        sanitizedEmployerId = CompanionValidationGate.sanitizeIdentifier(employerId);
      } catch (secErr) {
        const isSecurity = secErr.message.startsWith('SECURITY_VIOLATION');
        return {
          valid: false,
          ingested: false,
          code: isSecurity ? 'SECURITY_VIOLATION' : 'IDENTIFIER_ERROR',
          error: secErr.message,
          stateCorrupted: false,
          quarantine: false
        };
      }

      // Dossier employer validation if dossier is supplied
      if (options.dossier && Array.isArray(options.dossier.employers)) {
        const knownEmployers = new Set(options.dossier.employers.map(e => e.id));
        if (!knownEmployers.has(sanitizedEmployerId)) {
          return {
            valid: false,
            ingested: false,
            code: 'UNKNOWN_EMPLOYER',
            error: `UNKNOWN_EMPLOYER: EmployerId "${sanitizedEmployerId}" does not exist in candidate dossier`,
            stateCorrupted: false,
            quarantine: false
          };
        }
      }

      // Rule 3: Direct promotion to VERIFIED is prohibited; coerced to CONFIRM
      const requestedStatus = String(proposal.status || '').toUpperCase();
      if (requestedStatus === 'VERIFIED') {
        return {
          valid: false,
          ingested: false,
          code: 'GUARDRAIL_VIOLATION_CLAIM_ELEVATION',
          error: 'GUARDRAIL_VIOLATION: Companion cannot directly declare a claim VERIFIED. All new claims must be submitted with status [CONFIRM]',
          ruleViolated: 'RULE_3_CLAIM_GATING',
          stateCorrupted: false,
          quarantine: false
        };
      }

      let sanitizedClaimId = null;
      if (proposal.claimId || proposal.id) {
        const rawClaim = String(proposal.claimId || proposal.id).replace(/^\[|\]$/g, '').trim();
        try {
          sanitizedClaimId = CompanionValidationGate.sanitizeIdentifier(rawClaim);
        } catch (secErr) {
          const isSecurity = secErr.message.startsWith('SECURITY_VIOLATION');
          return {
            valid: false,
            ingested: false,
            code: isSecurity ? 'SECURITY_VIOLATION' : 'IDENTIFIER_ERROR',
            error: secErr.message,
            stateCorrupted: false,
            quarantine: false
          };
        }
      }

      return {
        valid: true,
        ingested: true,
        action: 'INGESTED_FOR_CONFIRMATION',
        claimId: sanitizedClaimId,
        claimStatus: 'CONFIRM',
        status: 'CONFIRM',
        employerId: sanitizedEmployerId,
        claimText: claimText.trim(),
        metrics: Array.isArray(proposal.metrics) ? proposal.metrics : [],
        tools: Array.isArray(proposal.tools) ? proposal.tools : [],
        role: proposal.role || '',
        category: proposal.category || 'general',
        quarantine: false,
        stateCorrupted: false,
        proposal
      };
    }

    // ========================================================================
    // CLAIM CONFIRMATION (CONFIRMING AN EXISTING CLAIM)
    // ========================================================================
    if (type === 'claim_confirmation') {
      const claimId = proposal.claimId || proposal.id;
      if (!claimId || typeof claimId !== 'string') {
        return {
          valid: false,
          ingested: false,
          code: 'MISSING_REQUIRED_FIELDS',
          error: 'MISSING_REQUIRED_FIELDS',
          details: 'Claim confirmation requires a valid "claimId"',
          stateCorrupted: false,
          quarantine: false
        };
      }

      let sanitizedClaimId;
      try {
        const cleanRaw = claimId.replace(/^\[|\]$/g, '').trim();
        sanitizedClaimId = CompanionValidationGate.sanitizeIdentifier(cleanRaw);
      } catch (secErr) {
        const isSecurity = secErr.message.startsWith('SECURITY_VIOLATION');
        return {
          valid: false,
          ingested: false,
          code: isSecurity ? 'SECURITY_VIOLATION' : 'IDENTIFIER_ERROR',
          error: secErr.message,
          stateCorrupted: false,
          quarantine: false
        };
      }

      const evidence = proposal.evidence || proposal.notes || proposal.rationale;
      if (!evidence || typeof evidence !== 'string' || evidence.trim().length === 0) {
        return {
          valid: false,
          ingested: false,
          code: 'MISSING_EVIDENCE',
          error: 'MISSING_EVIDENCE: Claim confirmation requires non-empty "evidence"',
          stateCorrupted: false,
          quarantine: false
        };
      }

      return {
        valid: true,
        ingested: true,
        action: 'INGESTED_AS_PROPOSAL',
        claimId: sanitizedClaimId,
        evidence: evidence.trim(),
        status: 'pending_human_review',
        quarantine: false,
        stateCorrupted: false,
        proposal
      };
    }

    // ========================================================================
    // TRIAGE DECISION
    // ========================================================================
    if (type === 'triage_decision') {
      const targetId = proposal.jobId || proposal.id;
      if (!targetId || typeof targetId !== 'string') {
        return {
          valid: false,
          ingested: false,
          code: 'MISSING_REQUIRED_FIELDS',
          error: 'MISSING_REQUIRED_FIELDS',
          details: 'Triage decision requires a valid "jobId"',
          stateCorrupted: false,
          quarantine: false
        };
      }

      let sanitizedJobId;
      try {
        sanitizedJobId = CompanionValidationGate.sanitizeIdentifier(targetId);
      } catch (secErr) {
        const isSecurity = secErr.message.startsWith('SECURITY_VIOLATION');
        return {
          valid: false,
          ingested: false,
          code: isSecurity ? 'SECURITY_VIOLATION' : 'IDENTIFIER_ERROR',
          error: secErr.message,
          stateCorrupted: false,
          quarantine: false
        };
      }

      const dec = String(proposal.decision || '').toLowerCase().trim();
      if (!VALID_TRIAGE_DECISIONS.has(dec)) {
        return {
          valid: false,
          ingested: false,
          code: 'INVALID_TRIAGE_DECISION',
          error: `INVALID_TRIAGE_DECISION: Unsupported decision "${proposal.decision}". Expected: shortlist, select, apply, not_interested, exclude, reject, park, hold`,
          stateCorrupted: false,
          quarantine: false
        };
      }

      return {
        valid: true,
        ingested: true,
        action: 'INGESTED_AS_PROPOSAL',
        jobId: sanitizedJobId,
        decision: dec,
        score: typeof proposal.score === 'number' ? proposal.score : 4.0,
        rationale: proposal.rationale || proposal.notes || null,
        status: 'pending_human_review',
        quarantine: false,
        stateCorrupted: false,
        proposal
      };
    }

    // ========================================================================
    // PACK APPROVAL
    // ========================================================================
    if (type === 'pack_approval') {
      const targetId = proposal.jobId || proposal.id;
      if (!targetId || typeof targetId !== 'string') {
        return {
          valid: false,
          ingested: false,
          code: 'MISSING_REQUIRED_FIELDS',
          error: 'MISSING_REQUIRED_FIELDS',
          details: 'Pack approval requires a valid "jobId"',
          stateCorrupted: false,
          quarantine: false
        };
      }

      let sanitizedJobId;
      try {
        sanitizedJobId = CompanionValidationGate.sanitizeIdentifier(targetId);
      } catch (secErr) {
        const isSecurity = secErr.message.startsWith('SECURITY_VIOLATION');
        return {
          valid: false,
          ingested: false,
          code: isSecurity ? 'SECURITY_VIOLATION' : 'IDENTIFIER_ERROR',
          error: secErr.message,
          stateCorrupted: false,
          quarantine: false
        };
      }

      const rawVerdict = String(proposal.verdict || 'APPROVE').toUpperCase().trim();
      if (!VALID_PACK_VERDICTS.has(rawVerdict)) {
        return {
          valid: false,
          ingested: false,
          code: 'INVALID_PACK_VERDICT',
          error: `INVALID_PACK_VERDICT: Unsupported verdict "${proposal.verdict}". Expected: APPROVE, REJECT, REVISE`,
          stateCorrupted: false,
          quarantine: false
        };
      }

      return {
        valid: true,
        ingested: true,
        action: 'INGESTED_AS_PROPOSAL',
        jobId: sanitizedJobId,
        verdict: rawVerdict,
        notes: proposal.notes || proposal.feedback || '',
        status: 'pending_human_review',
        quarantine: false,
        stateCorrupted: false,
        proposal
      };
    }

    // ========================================================================
    // STATUS UPDATE / GENERIC PROPOSAL
    // ========================================================================
    const targetId = proposal.jobId || proposal.claimId || proposal.id;
    if (!targetId || typeof targetId !== 'string') {
      return {
        valid: false,
        ingested: false,
        code: 'MISSING_REQUIRED_FIELDS',
        error: 'MISSING_REQUIRED_FIELDS',
        stateCorrupted: false,
        quarantine: false
      };
    }

    let sanitizedId;
    try {
      sanitizedId = CompanionValidationGate.sanitizeIdentifier(targetId);
    } catch (secErr) {
      const isSecurity = secErr.message.startsWith('SECURITY_VIOLATION');
      return {
        valid: false,
        ingested: false,
        code: isSecurity ? 'SECURITY_VIOLATION' : 'IDENTIFIER_ERROR',
        error: secErr.message,
        stateCorrupted: false,
        quarantine: false
      };
    }

    return {
      valid: true,
      ingested: true,
      action: 'INGESTED_AS_PROPOSAL',
      jobId: sanitizedId,
      status: 'pending_human_review',
      quarantine: false,
      stateCorrupted: false,
      proposal
    };
  }
}

module.exports = {
  CompanionValidationGate,
  VALID_PROPOSAL_TYPES,
  VALID_TRIAGE_DECISIONS,
  VALID_DRAFT_TYPES,
  VALID_PACK_VERDICTS
};
