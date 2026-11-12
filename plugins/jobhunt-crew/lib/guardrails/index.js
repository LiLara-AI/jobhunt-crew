'use strict';

/**
 * JobHunt Crew — Guardrails Module Entry Point
 * @module lib/guardrails
 */

const engine = require('./engine');
const dedup = require('./dedup');

module.exports = {
  // Engine
  GuardrailEngine: engine.GuardrailEngine,
  validateSubmission: engine.validateSubmission,
  validateClosure: engine.validateClosure,
  validateApplicationReadiness: engine.validateApplicationReadiness,
  validateReadiness: engine.validateReadiness,
  VALID_CLOSURE_EVIDENCE_TYPES: engine.VALID_CLOSURE_EVIDENCE_TYPES,

  // Dedup & Normalizer
  normalizeJobUrl: dedup.normalizeJobUrl,
  canonicalizeUrl: dedup.canonicalizeUrl,
  normalizeUrl: dedup.normalizeUrl,
  generateRequisitionKey: dedup.generateRequisitionKey,
  generateFingerprint: dedup.generateFingerprint,
  checkDuplicateRequisition: dedup.checkDuplicateRequisition,
  DuplicateApplicationGuard: dedup.DuplicateApplicationGuard,
  JobFingerprinter: dedup.JobFingerprinter
};
