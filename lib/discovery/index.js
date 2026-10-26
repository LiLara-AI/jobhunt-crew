'use strict';

/**
 * JobHunt Crew — Unified Multi-Channel Discovery Engine
 *
 * Consolidates:
 * 1. ATS Ingestion: Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Oracle Cloud HCM.
 * 2. Rate Limiting: Token bucket, exponential backoff, Retry-After header parsing.
 * 3. KSA/GCC Country Pack: 40+ watchlist, Saudization, Iqama check, Scam sentinel, Arabic morphology.
 * 4. Browser Sweeps: Attended Chrome DevTools MCP session diagnostics.
 * 5. Scoring & Triage: 5-dimension rubric, closing-soon escalation, zero age penalty.
 * 6. Deduplication: Canonical URL normalization & fingerprinting.
 *
 * @module lib/discovery
 */

const ats = require('./ats');
const rateLimiter = require('./rate-limiter');
const ksaPack = require('./ksa-pack');
const browserSweeps = require('./browser-sweeps');
const jobScorer = require('./job-scorer');
const dedup = require('./dedup');

class DiscoveryEngine {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.rateLimiter = options.rateLimiter || new rateLimiter.DomainTokenBucketRateLimiter();
    this.watchlist = ksaPack.KsaCountryPack.getWatchlistRegistry();
  }

  /**
   * Sweeps an ATS board for active vacancies.
   */
  async sweepAts(provider, target, options = {}) {
    return ats.fetchAtsBoard(provider, target, {
      ...options,
      rateLimiter: this.rateLimiter
    });
  }

  /**
   * Evaluates and scores a vacancy against candidate preferences.
   */
  scoreJob(job, preferences = {}, skills = []) {
    return jobScorer.JobScorer.scoreVacancy(job, preferences, skills);
  }

  /**
   * Checks regional compliance for a vacancy.
   */
  evaluateKsaCompliance(jobText, candidateStatus = 'Transferable Iqama', metadata = {}) {
    return ksaPack.KsaCountryPack.evaluateCompliance(jobText, candidateStatus, metadata);
  }

  /**
   * Normalizes an Arabic query for morphological search.
   */
  normalizeArabic(text) {
    return ksaPack.ArabicQueryNormalizer.normalize(text);
  }

  /**
   * Tests whether text matches an Arabic query accounting for inflections.
   */
  matchesArabic(targetText, query) {
    return ksaPack.ArabicQueryNormalizer.matches(targetText, query);
  }
}

module.exports = {
  // Discovery Engine Facade
  DiscoveryEngine,

  // ATS Subsystem
  ...ats,

  // Rate Limiting Subsystem
  ...rateLimiter,

  // KSA & Regional Subsystem
  ...ksaPack,

  // Browser Sweeps Subsystem
  ...browserSweeps,

  // Scoring & Triage Subsystem
  ...jobScorer,

  // Deduplication Subsystem
  ...dedup
};
