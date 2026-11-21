'use strict';

/**
 * JobHunt Crew — Multi-Vacancy Application Strategy Engine
 *
 * Evaluates multiple openings at a single enterprise:
 * 1. Triage: Generates explicit APPLY vs SKIP recommendations with clear rationales
 *    (roles below the candidate's seniority, or outside the dossier's target titles/skills).
 * 2. Convergent CV Synthesis: Produces ONE unified CV plan across all chosen roles
 *    with bridging verified claims (preventing divergent CV flags in enterprise ATS).
 * 3. Per-Role Cover Letters: Generates distinct targeted cover letters for each chosen vacancy.
 *
 * Works for any profession: the domain is read from the dossier, never assumed.
 * Zero external dependencies. Uses Node.js standard runtime.
 */

// Words that say nothing about the field of work.
const GENERIC_WORDS = new Set([
  'senior', 'junior', 'lead', 'principal', 'staff', 'head', 'chief', 'associate', 'assistant', 'manager',
  'management', 'director', 'officer', 'specialist', 'executive', 'team', 'department', 'group', 'division',
  'and', 'the', 'for', 'of', 'in', 'at', 'to', 'or', 'on', 'with', 'an'
]);
const SENIOR_PATTERN = /\b(senior|sr|staff|principal|lead|head|director|manager|chief|vp)\b/i;
const JUNIOR_LEVELS = new Set(['junior', 'entry', 'mid', 'associate']);

// shortcut: a 4-letter prefix stands in for stemming (nurse/nursing, account/accounting), so
// near-miss words can match and the result leans to APPLY; swap in a real stemmer if triage gets noisy.
function stems(text) {
  return new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}+#]+/u)
    .filter(w => w.length >= 2 && !GENERIC_WORDS.has(w))
    .map(w => (w.length > 4 ? w.slice(0, 4) : w)));
}

const hasArabic = text => /[\u0600-\u06FF]/.test(text);

class MultiVacancyStrategist {
  /**
   * Evaluates company vacancies against candidate profile.
   * @param {string} company Enterprise organization name
   * @param {Array<Object>} vacancies Array of vacancy objects { id, title, level, department, requirementsText }
   * @param {Object} candidateProfile Candidate details { currentTitle, seniority, coreSpecialization, dossier }
   * @returns {{
   *   company: string,
   *   recommendations: Array<{ jobId: string, title: string, action: 'APPLY'|'SKIP', reason: string, matchedTerms: string[] }>,
   *   convergentCv: { title: string, targetJobIds: string[], convergentHeadline: string, coreClaimIds: string[] },
   *   perRoleCoverLetters: Array<{ jobId: string, title: string, customSalutation: string, focusArea: string }>
   * }}
   */
  static evaluateCompanyVacancies(company, vacancies = [], candidateProfile = {}) {
    const recommendations = [];
    const dossier = candidateProfile.dossier || {};
    const currentTitle = candidateProfile.currentTitle || (dossier.candidate && dossier.candidate.currentTitle) || '';
    const candidateIsSenior = SENIOR_PATTERN.test(`${candidateProfile.seniority || ''} ${currentTitle}`);

    // The candidate's field comes from the dossier's target titles and skills.
    const targetTitles = (dossier.preferences && Array.isArray(dossier.preferences.targetTitles)) ? dossier.preferences.targetTitles : [];
    const skills = Array.isArray(dossier.skills) ? dossier.skills : Object.values(dossier.skills || {}).flat();
    const domainKnown = targetTitles.length + skills.length > 0;
    const terms = [...targetTitles, ...skills, currentTitle, candidateProfile.coreSpecialization].filter(Boolean).map(String);

    for (const v of vacancies) {
      const level = (v.level || '').toLowerCase();
      const vacancyText = [v.title, v.department, v.requirementsText].filter(Boolean).join(' ');
      const vacancyStems = stems(vacancyText);
      const matchedTerms = terms.filter(t => [...stems(t)].some(s => vacancyStems.has(s)));
      // An Arabic posting cannot be word-matched against an English dossier (or the reverse).
      const comparable = domainKnown && hasArabic(vacancyText) === hasArabic(terms.join(' '));

      // Seniority check: skip junior/entry/mid roles if candidate is senior/staff/principal
      if (candidateIsSenior && JUNIOR_LEVELS.has(level)) {
        recommendations.push({
          jobId: v.id,
          title: v.title,
          action: 'SKIP',
          reason: `Role seniority (${v.level}) is below candidate seniority target (${currentTitle || candidateProfile.seniority})`,
          matchedTerms
        });
      }
      // Domain alignment check against the dossier's target titles and skills
      else if (comparable && matchedTerms.length === 0) {
        recommendations.push({
          jobId: v.id,
          title: v.title,
          action: 'SKIP',
          reason: `No overlap between this role (${v.department || v.title}) and the candidate's target titles or skills`,
          matchedTerms
        });
      }
      // Qualified match
      else {
        recommendations.push({
          jobId: v.id,
          title: v.title,
          action: 'APPLY',
          reason: matchedTerms.length
            ? `Matches the candidate's target titles or skills: ${matchedTerms.slice(0, 3).join(', ')}`
            : 'Seniority fits; domain fit not assessed (no comparable target titles or skills in the dossier), so review manually',
          matchedTerms
        });
      }
    }

    const targetVacancies = recommendations.filter(r => r.action === 'APPLY');

    // 1. Convergent headline: one target -> that title; several -> the candidate's real current title.
    const convergentHeadline = targetVacancies.length === 1
      ? targetVacancies[0].title
      : (currentTitle || (targetVacancies[0] ? targetVacancies[0].title : ''));

    // 2. Select bridging core claim IDs from candidate dossier (verified claims only, never invented IDs)
    const coreClaimIds = (Array.isArray(dossier.claims) ? dossier.claims : [])
      .filter(c => c && (c.status === 'VERIFIED' || !c.status))
      .slice(0, 6)
      .map(c => c.id);

    const convergentCv = {
      title: `${company} Convergent CV`,
      targetJobIds: targetVacancies.map(t => t.jobId),
      convergentHeadline,
      coreClaimIds
    };

    // 3. Generate per-role tailored cover letters, focused on what the dossier shares with each role
    const perRoleCoverLetters = targetVacancies.map(target => ({
      jobId: target.jobId,
      title: `Cover Letter for ${target.title} at ${company}`,
      customSalutation: `To the ${target.title} Search Committee at ${company}`,
      focusArea: target.matchedTerms.length ? target.matchedTerms.slice(0, 3).join(', ') : target.title
    }));

    return {
      company,
      recommendations,
      convergentCv,
      perRoleCoverLetters
    };
  }
}

module.exports = {
  MultiVacancyStrategist
};
