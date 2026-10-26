'use strict';

/**
 * JobHunt Crew — Honest-CV & Claim Verification Engine
 *
 * Module entry point exposing candidate dossier, intake wizard, claim verifier,
 * self-learning editorial rules, document generators, candidate-isolated review panel,
 * apply pack generator, and multi-vacancy strategist.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const { CareerDossier } = require('./dossier');
const { IntakeWizard, TitleFinder, WorkspaceBuilder, WIZARD_STEPS } = require('./intake-wizard');
const { ClaimVerifier, verifyDraftAgainstDossier, extractEntities, VIOLATION_CODES } = require('./verify-claims');
const { EditorialRuleEngine, RULE_CATEGORIES } = require('./editorial-rules');
const {
  DocGenerator,
  MiniZipBuilder,
  DocxGenerator,
  PdfGenerator,
  buildDocxXml,
  generateCvDocx,
  generateCvPdf,
  generateCoverLetterDocx,
  generateCoverLetterPdf
} = require('./doc-generator');
const {
  CandidateScrubber,
  BlindReviewContextBuilder,
  DualPersonaEvaluator,
  BlindReviewPanel
} = require('./review-panel');
const { ApplyPackGenerator } = require('./apply-pack');
const { MultiVacancyStrategist } = require('./multi-vacancy');

module.exports = {
  // Dossier & Claims
  CareerDossier,

  // Onboarding Wizard
  IntakeWizard,
  TitleFinder,
  WorkspaceBuilder,
  WIZARD_STEPS,

  // Claim Verification
  ClaimVerifier,
  verifyDraftAgainstDossier,
  extractEntities,
  VIOLATION_CODES,

  // Editorial Rules
  EditorialRuleEngine,
  RULE_CATEGORIES,

  // Document Generation
  DocGenerator,
  MiniZipBuilder,
  DocxGenerator,
  PdfGenerator,
  buildDocxXml,
  generateCvDocx,
  generateCvPdf,
  generateCoverLetterDocx,
  generateCoverLetterPdf,

  // Blind Review Panel
  CandidateScrubber,
  BlindReviewContextBuilder,
  DualPersonaEvaluator,
  BlindReviewPanel,

  // Apply Pack & Multi-Vacancy
  ApplyPackGenerator,
  MultiVacancyStrategist
};
