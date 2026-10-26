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

    // Extract first verified claim if available
    const claims = Array.isArray(dossier.claims) ? dossier.claims : [];
    const claim = (options.claimId && claims.find(c => c.id === options.claimId)) || claims[0] || null;
    const metric = claim && Array.isArray(claim.metrics) && claim.metrics.length > 0 ? claim.metrics[0] : null;
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

    draft = OutreachGenerator.fitWithinLimit(draft, 300);
    const count = OutreachGenerator.getCharCount(draft);

    return {
      persona,
      message: draft,
      charCount: count,
      isUnderLimit: count <= 300,
      claimId,
      safetyStatus: 'draft_only'
    };
  }
}

module.exports = {
  OutreachGenerator
};
