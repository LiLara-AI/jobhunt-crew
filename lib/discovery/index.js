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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ats = require('./ats');
const rateLimiter = require('./rate-limiter');
const ksaPack = require('./ksa-pack');
const browserSweeps = require('./browser-sweeps');
const jobScorer = require('./job-scorer');
const dedup = require('../guardrails/dedup');

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

  /** Live watchlist entries (backed by lib/discovery/data/ksa-watchlist.json). */
  getWatchlist() {
    return ksaPack.KSA_WATCHLIST.filter(e => e.enabled !== false);
  }

  static sanitizePathSegment(value, fallback = 'Unknown') {
    const clean = String(value || '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^\.+/, '')
      .slice(0, 80);
    return clean || fallback;
  }

  /**
   * Archive a shortlisted job description to
   * Applications/<Company>_<Role>/jd.md under the workspace.
   * No-op (returns null) when the evaluation is not shortlisted,
   * unless options.force is true.
   */
  archiveShortlistedJd(job, evaluation = null, options = {}) {
    if (!job || typeof job !== 'object') return null;
    const ev = evaluation || this.scoreJob(job, options.preferences || {}, options.skills || []);
    if (!options.force && !ev.shortlisted) return null;

    const company = DiscoveryEngine.sanitizePathSegment(job.company, 'UnknownCompany');
    const role = DiscoveryEngine.sanitizePathSegment(job.title, 'UnknownRole');
    const appsRoot = path.resolve(this.workspaceDir, 'Applications');
    const dir = path.resolve(appsRoot, `${company}_${role}`);
    if (!(dir === appsRoot || dir.startsWith(appsRoot + path.sep))) return null;

    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'jd.md');
    const lines = [
      `# ${job.title || ''} — ${job.company || ''}`,
      '',
      `- Source: ${job.source || job.channel || 'unknown'}`,
      `- URL: ${job.canonicalUrl || job.url || ''}`,
      `- Location: ${job.location || ''}`,
      `- Requisition: ${job.requisitionId || ''}`,
      `- Archived: ${new Date().toISOString()}`,
      `- Score: ${ev.score !== undefined ? ev.score : ''} (${ev.verdict || ''})`,
      '',
      '## Job description',
      '',
      String(job.description || (job.rawPayload && (job.rawPayload.description || job.rawPayload.content)) || ''),
      ''
    ];
    const content = lines.join('\n');
    fs.writeFileSync(filePath, content, 'utf8');
    const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    return { filePath, path: filePath, sha256, hash: sha256, company: job.company || '', title: job.title || '' };
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
