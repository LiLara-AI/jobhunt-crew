'use strict';

/**
 * JobHunt Crew — Canonical Deduplication & URL Normalizer
 * Collapses duplicate job discoveries across multiple channels (direct ATS, LinkedIn,
 * Bayt, web search) into a single canonical record and guards against duplicate submissions.
 *
 * @module lib/guardrails/dedup
 */

const crypto = require('crypto');

// Parameters to purge from job URLs to prevent phantom duplicates
const TRACKING_PARAMS_TO_STRIP = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gh_src',
  'gh_jid',
  'lever-source',
  'lever-origin',
  'ashby_jid',
  'ref',
  'source',
  'tracking_id',
  'trackingid',
  'refid',
  'trk',
  'sid',
  'sp_id',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'midtoken',
  'originalsubdomain',
  'isfiltered',
  'currentjobid',
  '_hsenc',
  '_hsmi'
]);

/**
 * Normalizes a job URL by removing marketing/tracking query parameters,
 * canonicalizing ATS-specific route patterns, stripping fragments and trailing slashes.
 *
 * @param {string} rawUrl - Input raw job listing URL
 * @returns {string} Canonical, normalized URL
 */
function normalizeJobUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';

  try {
    const u = new URL(rawUrl.trim());
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    u.hash = ''; // Remove fragment identifiers

    // 1. Greenhouse ATS route normalization:
    // Collapse embed routes (embed/job_app?for={board}&token={id}) into canonical (/board/jobs/id)
    if (u.hostname === 'boards.greenhouse.io') {
      if (u.pathname.toLowerCase() === '/embed/job_app' && u.searchParams.has('for') && u.searchParams.has('token')) {
        const board = u.searchParams.get('for').toLowerCase();
        const token = u.searchParams.get('token');
        u.pathname = `/${board}/jobs/${token}`;
        u.searchParams.delete('for');
        u.searchParams.delete('token');
      }
    }

    // 2. Lever ATS route normalization:
    // Strip trailing /apply from URL path to unify view and apply pages
    if (u.hostname.includes('lever.co')) {
      u.pathname = u.pathname.replace(/\/apply\/?$/, '');
    }

    // 3. Ashby ATS route normalization:
    // Strip trailing /application from URL path
    if (u.hostname.includes('ashbyhq.com')) {
      u.pathname = u.pathname.replace(/\/application\/?$/, '');
    }

    // 4. Strip tracking parameters
    for (const param of Array.from(u.searchParams.keys())) {
      const lowerParam = param.toLowerCase();
      if (
        TRACKING_PARAMS_TO_STRIP.has(lowerParam) ||
        lowerParam.startsWith('utm_') ||
        lowerParam.startsWith('_hs') ||
        lowerParam.startsWith('hs_')
      ) {
        u.searchParams.delete(param);
      }
    }

    // Sort remaining non-tracking query parameters deterministically
    u.searchParams.sort();

    // 5. Normalize trailing slash
    let pathname = u.pathname.toLowerCase();
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    u.pathname = pathname;

    return u.toString();
  } catch (_) {
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * Generates a deterministic SHA-256 fingerprint for requisition-level deduplication.
 *
 * @param {string} company - Employer company name
 * @param {string} title - Job vacancy title
 * @param {string} [normalizedUrl] - Canonicalized URL (optional)
 * @param {object} [options] - Optional settings { location, requisitionId, length }
 * @returns {string} SHA-256 hex string (or truncated slice)
 */
function generateRequisitionKey(company, title, normalizedUrl = '', options = {}) {
  const normCompany = String(company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normTitle = String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normLoc = options.location ? String(options.location).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const normReq = options.requisitionId ? String(options.requisitionId).toLowerCase().trim() : '';

  let content;
  if (normReq) {
    content = `${normCompany}|${normReq}`;
  } else if (normalizedUrl) {
    content = `${normCompany}|${normTitle}|${normalizedUrl}`;
  } else {
    content = `${normCompany}|${normTitle}|${normLoc}`;
  }

  const hash = crypto.createHash('sha256').update(content).digest('hex');
  if (options.length && typeof options.length === 'number') {
    return hash.slice(0, options.length);
  }
  return hash;
}

/**
 * Generates a 16-character fingerprint (alias for Tier 2 test harness compatibility).
 */
function generateFingerprint(title, company, location = '', requisitionId = '') {
  return generateRequisitionKey(company, title, null, { location, requisitionId, length: 16 });
}

/**
 * Inspects candidate job against existing job records to detect duplicates.
 * Blocks duplicate discoveries and returns warnings for active company cooldown windows.
 *
 * @param {Array|object} existingJobs - Existing jobs collection (Array, Map, or Snapshot Object)
 * @param {object} newJob - New job candidate { title, company, url, requisitionId, location }
 * @param {object} [options] - Options { throwOnError = true, cooldownDays = 30, targetDate }
 * @returns {object} { isDuplicate: boolean, reason: string|null, matchedJob: object|null, warning: string|null }
 * @throws {Error} DUPLICATE_REQUISITION if throwOnError is true and duplicate is found
 */
function checkDuplicateRequisition(existingJobs, newJob, options = {}) {
  const { throwOnError = true, cooldownDays = 30, targetDate = new Date() } = options;

  if (!newJob || typeof newJob !== 'object') {
    throw new Error('DUPLICATE_REQUISITION: New job candidate must be a valid object');
  }

  const jobsList = Array.isArray(existingJobs)
    ? existingJobs
    : (existingJobs && typeof existingJobs === 'object' ? Object.values(existingJobs) : []);

  const newUrl = normalizeJobUrl(newJob.url || '');
  const newNormCompany = String(newJob.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const newNormTitle = String(newJob.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const newNormLoc = String(newJob.location || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const newReqId = newJob.requisitionId ? String(newJob.requisitionId).toLowerCase().trim() : '';

  const newKey = generateRequisitionKey(
    newJob.company,
    newJob.title,
    newUrl,
    { location: newJob.location, requisitionId: newJob.requisitionId }
  );

  for (const existing of jobsList) {
    if (!existing || typeof existing !== 'object') continue;

    const existUrl = normalizeJobUrl(existing.url || '');
    const existNormCompany = String(existing.company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const existNormTitle = String(existing.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const existNormLoc = String(existing.location || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const existReqId = existing.requisitionId ? String(existing.requisitionId).toLowerCase().trim() : '';

    const existKey = existing.requisitionKey || generateRequisitionKey(
      existing.company,
      existing.title,
      existUrl,
      { location: existing.location, requisitionId: existing.requisitionId }
    );

    // 1. Requisition ID match at same company
    if (newReqId && existReqId && newNormCompany === existNormCompany && newReqId === existReqId) {
      const msg = `DUPLICATE_REQUISITION: Requisition "${newJob.requisitionId}" at "${existing.company}" already exists (ID: ${existing.id || existing.requisitionId}). Repeated submissions/discoveries are blocked.`;
      if (throwOnError) throw new Error(msg);
      return { isDuplicate: true, reason: 'DUPLICATE_REQUISITION', matchedJob: existing, matchType: 'REQUISITION_ID', message: msg };
    }

    // 2. Canonical URL exact match
    if (newUrl && existUrl && newUrl === existUrl) {
      const msg = `DUPLICATE_REQUISITION: Canonical URL "${newUrl}" already exists (ID: ${existing.id || 'existing'}). Repeated discoveries are collapsed.`;
      if (throwOnError) throw new Error(msg);
      return { isDuplicate: true, reason: 'DUPLICATE_REQUISITION', matchedJob: existing, matchType: 'CANONICAL_URL', message: msg };
    }

    // 3. Exact Key Match
    if (newKey && existKey && newKey === existKey) {
      const msg = `DUPLICATE_REQUISITION: Exact requisition fingerprint match for "${newJob.title}" at "${newJob.company}" (ID: ${existing.id || 'existing'}).`;
      if (throwOnError) throw new Error(msg);
      return { isDuplicate: true, reason: 'DUPLICATE_REQUISITION', matchedJob: existing, matchType: 'FINGERPRINT', message: msg };
    }

    // 4. Exact Title + Company + Location Match
    if (newNormCompany && existNormCompany && newNormCompany === existNormCompany &&
        newNormTitle && existNormTitle && newNormTitle === existNormTitle &&
        newNormLoc && existNormLoc && newNormLoc === existNormLoc) {
      const msg = `DUPLICATE_REQUISITION: Job with identical title, company, and location already exists (ID: ${existing.id || 'existing'}).`;
      if (throwOnError) throw new Error(msg);
      return { isDuplicate: true, reason: 'DUPLICATE_REQUISITION', matchedJob: existing, matchType: 'TITLE_COMPANY_LOCATION', message: msg };
    }
  }

  // 5. Cooldown check: Has candidate applied to this company within cooldown window?
  const companyApplications = jobsList.filter(
    j => j && (j.status === 'applied' || j.status === 'submitted') && String(j.company || '').toLowerCase().replace(/[^a-z0-9]/g, '') === newNormCompany
  );

  if (companyApplications.length > 0) {
    companyApplications.sort((a, b) => {
      const dateA = new Date(a.appliedAt || a.submittedAt || a.updatedAt || 0).getTime();
      const dateB = new Date(b.appliedAt || b.submittedAt || b.updatedAt || 0).getTime();
      return dateA - dateB;
    });
    const latest = companyApplications[companyApplications.length - 1];
    if (latest.appliedAt || latest.submittedAt) {
      const appliedTime = new Date(latest.appliedAt || latest.submittedAt).getTime();
      const diffMs = new Date(targetDate).getTime() - appliedTime;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays < cooldownDays) {
        return {
          isDuplicate: false,
          warning: 'COMPANY_COOLDOWN_ACTIVE',
          cooldownRemainingDays: cooldownDays - diffDays,
          message: `Notice: You applied to ${latest.company} ${diffDays} days ago (cooldown window is ${cooldownDays} days). Allowed to proceed with caution.`
        };
      }
    }
  }

  return { isDuplicate: false, warning: null };
}

/**
 * Stateful guard for tracking application history and enforcing cooldowns.
 */
class DuplicateApplicationGuard {
  constructor(cooldownDays = 30) {
    this.cooldownDays = cooldownDays;
    this.appliedHistory = [];
  }

  recordApplication(requisitionId, company, appliedAt = new Date().toISOString()) {
    this.appliedHistory.push({ requisitionId, company, appliedAt });
  }

  evaluateApplicationEligibility(requisitionId, company, targetDate = new Date()) {
    const exactMatch = this.appliedHistory.find(h => h.requisitionId === requisitionId);
    if (exactMatch) {
      return {
        allowed: false,
        reason: 'DUPLICATE_REQUISITION',
        message: `Already applied to requisition ${requisitionId} on ${exactMatch.appliedAt}. Repeated submissions are blocked.`
      };
    }

    const companyHistory = this.appliedHistory.filter(h => h.company.toLowerCase() === company.toLowerCase());
    if (companyHistory.length > 0) {
      const latest = companyHistory[companyHistory.length - 1];
      const diffMs = targetDate.getTime() - new Date(latest.appliedAt).getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays < this.cooldownDays) {
        return {
          allowed: true,
          warning: 'COMPANY_COOLDOWN_ACTIVE',
          cooldownRemainingDays: this.cooldownDays - diffDays,
          message: `Notice: You applied to ${company} ${diffDays} days ago (cooldown window is ${this.cooldownDays} days). Allowed to proceed with caution.`
        };
      }
    }

    return { allowed: true, warning: null };
  }
}

class JobFingerprinter {
  static normalizeUrl(rawUrl) {
    return normalizeJobUrl(rawUrl);
  }

  static generateFingerprint(title, company, location = '', requisitionId = '') {
    return generateFingerprint(title, company, location, requisitionId);
  }
}

module.exports = {
  normalizeJobUrl,
  canonicalizeUrl: normalizeJobUrl,
  normalizeUrl: normalizeJobUrl,
  generateRequisitionKey,
  generateFingerprint,
  checkDuplicateRequisition,
  DuplicateApplicationGuard,
  JobFingerprinter
};
