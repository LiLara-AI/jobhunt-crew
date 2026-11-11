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
const { IntakeWizard, TitleFinder, WorkspaceBuilder, WIZARD_STEPS, parseCvText } = require('./intake-wizard');
const { ClaimVerifier, verifyDraftAgainstDossier, extractEntities, splitSentences, extractClaimPhrases, VIOLATION_CODES } = require('./verify-claims');
const { dossierToJsonResume, jsonResumeToDossierData, jsonResumeToDossier } = require('./json-resume');
const { EditorialRuleEngine, RULE_CATEGORIES } = require('./editorial-rules');
const {
  DocGenerator,
  MiniZipBuilder,
  DocxGenerator,
  PdfGenerator,
  buildDocxXml,
  findBrowserExecutable,
  printHtmlToPdf,
  renderTemplate,
  renderCvHtml,
  renderCoverLetterHtml,
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
  parseCvText,

  // Claim Verification
  ClaimVerifier,
  verifyDraftAgainstDossier,
  extractEntities,
  splitSentences,
  extractClaimPhrases,
  VIOLATION_CODES,

  // JSON Resume Interop
  dossierToJsonResume,
  jsonResumeToDossierData,
  jsonResumeToDossier,

  // Editorial Rules
  EditorialRuleEngine,
  RULE_CATEGORIES,

  // Document Generation
  DocGenerator,
  MiniZipBuilder,
  DocxGenerator,
  PdfGenerator,
  buildDocxXml,
  findBrowserExecutable,
  printHtmlToPdf,
  renderTemplate,
  renderCvHtml,
  renderCoverLetterHtml,
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
