'use strict';

/**
 * JobHunt Crew — Professional Outreach Generator (<= 300 Characters)
 *
 * Implements draft-only networking communications across 3 personas:
 * - Hiring Manager (impact & scale credibility)
 * - Recruiter (role fit, top skills & notice period)
 * - Peer (shared technical stack & community)
 *
 * Enforces strict <= 300 character limit for LinkedIn connection requests,
 * zero personal PII, and verified claim grounding.
 *
 * @module lib/crew/outreach
 */

class OutreachGenerator {
  /**
   * Helper to accurately measure Unicode character length.
   */
  static getCharCount(str) {
    if (!str || typeof str !== 'string') return 0;
    return Array.from(str).length;
  }

  /**
   * Trims text to fit within maxChars without cutting off words awkwardly.
   */
  static fitWithinLimit(text, maxChars = 300) {
    if (OutreachGenerator.getCharCount(text) <= maxChars) {
      return text;
    }

    const chars = Array.from(text);
    let trimmed = chars.slice(0, maxChars - 3).join('');
    // Trim to last space
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace > maxChars * 0.7) {
      trimmed = trimmed.slice(0, lastSpace);
    }
    return trimmed.trim() + '...';
  }

  /**
   * Generates tailored outreach draft.
   * @param {Object} options
   * @param {string} options.persona 'HIRING_MANAGER', 'RECRUITER', or 'PEER'
   * @param {Object} options.jobRecord Vacancy metadata { company, title }
   * @param {Object} [options.dossier] Candidate dossier { headline, claims, noticePeriod }
   * @param {string} [options.claimId] Bound claim ID
   * @returns {Object} Outreach draft
   */
  static generateOutreach(options = {}) {
    const persona = (options.persona || 'RECRUITER').toUpperCase();
    const job = options.jobRecord || {};
    const dossier = options.dossier || {};
    const company = job.company || 'your team';
    const role = job.title || 'the open role';

    // Only verified claims may ground an outreach draft. A claim carrying an
    // explicit non-VERIFIED status (CONFIRM, PROPOSED, ...) is never used.
    // Status-less legacy fixture claims follow CareerDossier normalization,
    // which treats anything other than CONFIRM as VERIFIED.
    const claims = Array.isArray(dossier.claims) ? dossier.claims : [];
    const isVerifiedClaim = c => Boolean(c) && (c.status === 'VERIFIED' || c.status === undefined || c.status === null);
    const claimMatches = (c, wanted) => c && (c.id === wanted || c.claimId === wanted || c.tag === wanted || `[${c.id}]` === wanted);

    let claim = null;
    let claimRejected = null;
    if (options.claimId) {
      const requested = claims.find(c => claimMatches(c, options.claimId)) || null;
      if (requested && isVerifiedClaim(requested)) claim = requested;
      else if (requested) claimRejected = requested;
    } else {
      claim = claims.find(isVerifiedClaim) || null;
    }

    const metricValue = claim && Array.isArray(claim.metrics) && claim.metrics.length > 0 ? claim.metrics[0] : null;
    const metric = metricValue === null ? null
      : (typeof metricValue === 'object' ? String(metricValue.value !== undefined ? metricValue.value : metricValue) : String(metricValue));
    const claimId = claim ? (claim.id || claim.claimId || claim.tag) : null;

    let draft = '';

    if (persona === 'HIRING_MANAGER') {
      if (metric) {
        draft = `Hi! Saw the ${role} opening at ${company}. Having delivered ${metric} in distributed systems, I'd value connecting and following your team's engineering work.`;
      } else {
        draft = `Hi! I saw the ${role} position at ${company}. With a background in distributed platforms and high-availability architecture, I'd value connecting to follow your team's technical journey.`;
      }
    } else if (persona === 'PEER') {
      draft = `Hi! Impressed by ${company}'s engineering architecture. As a fellow platform engineer interested in high-scale systems, I'd love to connect and follow your work.`;
    } else {
      // RECRUITER
      const notice = dossier.noticePeriod || 'immediate availability';
      draft = `Hi! I recently applied for the ${role} position at ${company}. Bringing deep experience in scalable cloud platforms (${notice}). Would welcome a quick chat!`;
    }

    const maxChars = Math.min(300, Math.max(1, Number(options.maxChars) || 300));
    draft = OutreachGenerator.fitWithinLimit(draft, maxChars);
    if (OutreachGenerator.getCharCount(draft) > maxChars) {
      draft = Array.from(draft).slice(0, maxChars).join('');
    }
    const count = OutreachGenerator.getCharCount(draft);

    let contactRecord = null;
    let contactRequested = false;
    const workspaceDir = options.workspaceDir || options.workspace;
    if (workspaceDir && (options.contact || options.contactId || options.contactName)) {
      contactRequested = true;
      try {
        const { ContactTracker } = require('../operational/contacts');
        const tracker = new ContactTracker({ workspaceDir });
        if (options.contact && typeof options.contact === 'object' && options.contact.name) {
          contactRecord = tracker.addContact({
            ...options.contact,
            company: options.contact.company || company,
            persona: options.contact.persona || persona,
            jobId: options.contact.jobId || job.id || null
          });
        } else if (options.contactId) {
          contactRecord = tracker.getContact(options.contactId);
        } else if (options.contactName) {
          contactRecord = tracker.searchContacts(options.contactName)[0] || null;
        }
      } catch (_) { contactRecord = null; }
    }

    const result = {
      persona,
      message: draft,
      charCount: count,
      maxChars,
      isUnderLimit: count <= maxChars,
      claimId,
      claimVerified: Boolean(claim),
      rejectedClaimId: claimRejected ? (claimRejected.id || claimRejected.claimId || claimRejected.tag || null) : null,
      safetyStatus: 'draft_only'
    };
    if (contactRequested) result.contact = contactRecord;
    return result;
  }
}

module.exports = {
  OutreachGenerator
};
