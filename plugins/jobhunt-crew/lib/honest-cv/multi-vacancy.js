'use strict';

/**
 * JobHunt Crew — Multi-Vacancy Application Strategy Engine
 *
 * Evaluates multiple openings at a single enterprise:
 * 1. Triage: Generates explicit APPLY vs SKIP recommendations with clear rationales
 *    (filtering out junior/mismatched roles to protect executive/staff positioning).
 * 2. Convergent CV Synthesis: Produces ONE unified technical leadership narrative
 *    unifying all chosen roles with bridging verified claims (preventing divergent CV flags in enterprise ATS).
 * 3. Per-Role Cover Letters: Generates distinct targeted cover letters for each chosen vacancy.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

class MultiVacancyStrategist {
  /**
   * Evaluates company vacancies against candidate profile.
   * @param {string} company Enterprise organization name
   * @param {Array<Object>} vacancies Array of vacancy objects { id, title, level, department, requirementsText }
   * @param {Object} candidateProfile Candidate details { currentTitle, seniority, coreSpecialization, dossier }
   * @returns {{
   *   company: string,
   *   recommendations: Array<{ jobId: string, title: string, action: 'APPLY'|'SKIP', reason: string }>,
   *   convergentCv: { title: string, targetJobIds: string[], convergentHeadline: string, coreClaimIds: string[] },
   *   perRoleCoverLetters: Array<{ jobId: string, title: string, customSalutation: string, focusArea: string }>
   * }}
   */
  static evaluateCompanyVacancies(company, vacancies = [], candidateProfile = {}) {
    const recommendations = [];
    const currentTitle = candidateProfile.currentTitle || 'Senior Software Engineer';

    for (const v of vacancies) {
      const level = (v.level || '').toLowerCase();
      const department = v.department || '';

      // Seniority check: Skip junior/entry/mid roles if candidate is senior/staff/principal
      if (level === 'junior' || level === 'entry' || level === 'mid' || level === 'associate') {
        recommendations.push({
          jobId: v.id,
          title: v.title,
          action: 'SKIP',
          reason: `Role seniority (${v.level}) is below candidate seniority target (${currentTitle})`
        });
      }
      // Department / Domain alignment check
      else if (department &&
               department !== 'Platform Infrastructure' &&
               department !== 'Distributed Systems' &&
               !/platform|infrastructure|distributed|core|systems|architecture|software/i.test(department)) {
        recommendations.push({
          jobId: v.id,
          title: v.title,
          action: 'SKIP',
          reason: 'Domain mismatch with candidate core architecture specialization'
        });
      }
      // Qualified match
      else {
        recommendations.push({
          jobId: v.id,
          title: v.title,
          action: 'APPLY',
          reason: 'Strong architectural and seniority alignment with candidate verified achievements'
        });
      }
    }

    const targetVacancies = recommendations.filter(r => r.action === 'APPLY');

    // 1. Synthesize Convergent Headline
    let convergentHeadline = 'Principal Platform Architect & Distributed Systems Leader';
    if (targetVacancies.length === 1) {
      convergentHeadline = targetVacancies[0].title;
    } else if (targetVacancies.length > 1) {
      const titles = targetVacancies.map(t => t.title);
      if (titles.some(t => t.includes('Architect')) && titles.some(t => t.includes('Distributed'))) {
        convergentHeadline = 'Principal Platform Architect & Distributed Systems Leader';
      } else {
        convergentHeadline = `${titles[0]} & Technical Systems Leader`;
      }
    }

    // 2. Select bridging core claim IDs from candidate dossier
    let coreClaimIds = ['CLM-001', 'CLM-002', 'CLM-003', 'CLM-004'];
    if (candidateProfile.dossier && Array.isArray(candidateProfile.dossier.claims)) {
      coreClaimIds = candidateProfile.dossier.claims
        .filter(c => c.status === 'VERIFIED' || !c.status)
        .slice(0, 6)
        .map(c => c.id);
    }

    const convergentCv = {
      title: `${company} Convergent Technical Leadership CV`,
      targetJobIds: targetVacancies.map(t => t.jobId),
      convergentHeadline,
      coreClaimIds
    };

    // 3. Generate per-role tailored cover letters
    const perRoleCoverLetters = targetVacancies.map(target => {
      let focusArea = 'High-scale platform architecture';
      if (target.title.includes('Distributed')) {
        focusArea = 'Distributed systems latency engineering';
      } else if (target.title.includes('Infrastructure')) {
        focusArea = 'Cloud infrastructure automation and resilience';
      } else if (target.title.includes('Full-Stack') || target.title.includes('Frontend')) {
        focusArea = 'Scalable web application performance and design systems';
      }

      return {
        jobId: target.jobId,
        title: `Cover Letter for ${target.title} at ${company}`,
        customSalutation: `To the ${target.title} Search Committee at ${company}`,
        focusArea
      };
    });

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
