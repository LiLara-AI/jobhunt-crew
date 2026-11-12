'use strict';

/**
 * JobHunt Crew — 5-Dimension Job Preference Scorer & Triage Engine
 *
 * Implements:
 * 1. 5-Dimension preference scoring rubric:
 *    - Title Match (25%)
 *    - Location & Work Mode Fit (20%)
 *    - Tech Stack Alignment (25%)
 *    - Seniority Level Fit (15%)
 *    - Watchlist & Employer Tier (15%)
 * 2. Urgent closing-soon priority boost (impending deadline <= 3 days).
 * 3. The Zero Age Penalty Invariant:
 *    - Open vacancies receive identical scores across all posting ages (0d, 30d, 60d, 90d, 120d, 365d).
 *    - Solely age-based closures are strictly rejected.
 *
 * @module lib/discovery/job-scorer
 */

const { KsaCountryPack } = require('./ksa-pack');

const SHORT_ACRONYMS = new Set(['ai', 'ml', 'qa', 'vp', 'hr', 'ui', 'ux', 'pm']);

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Punctuation-safe skill match: handles C++, C#, .NET where \b fails.
function skillMatchesText(text, skill) {
  const s = String(skill || '').trim();
  if (!s) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}+#])${escapeRegExp(s)}(?![\\p{L}\\p{N}+#])`, 'iu');
  return re.test(String(text || ''));
}

class JobScorer {
  constructor(preferences = {}, candidateSkills = []) {
    this.preferences = preferences;
    this.candidateSkills = candidateSkills;
  }

  score(job) {
    return JobScorer.scoreVacancy(job, this.preferences, this.candidateSkills);
  }

  scoreVacancy(job) {
    return JobScorer.scoreVacancy(job, this.preferences, this.candidateSkills);
  }

  /**
   * Scores a discovered job vacancy against candidate preferences and verified skills.
   *
   * @param {object} job - Vacancy record { title, company, location, url, postedAgeDays, deadlineAt, description, rawPayload }
   * @param {object} [preferences={}] - Candidate preferences { targetTitles, targetCities, companyWatchlist, excludedCompanies, candidateStatus }
   * @param {Array<string>} [candidateSkills=[]] - Verified candidate skills / tool keywords
   * @returns {object} Evaluation summary
   */
  static scoreVacancy(job, preferences = {}, candidateSkills = []) {
    if (!job || typeof job !== 'object') {
      return {
        score: 0.0,
        verdict: 'FAIL',
        status: 'FAIL',
        shortlisted: false,
        dimensions: { titleMatch: 0, locationMatch: 0, techStackMatch: 0, seniorityMatch: 0, watchlistTier: 0 },
        closingSoon: false,
        isOpen: false,
        ageBadge: 'Closed'
      };
    }

    const title = String(job.title || '').trim();
    const company = String(job.company || '').trim();
    const location = String(job.location || '').trim();
    const textToScan = `${title} ${location} ${job.description || ''} ${JSON.stringify(job.rawPayload || {})}`;

    // Target preferences extraction
    const targetTitles = Array.isArray(preferences.targetTitles) ? preferences.targetTitles : [];
    const targetCities = Array.isArray(preferences.targetCities) ? preferences.targetCities : [];
    const watchlist = Array.isArray(preferences.companyWatchlist) ? preferences.companyWatchlist : [];
    const excludedCompanies = Array.isArray(preferences.excludedCompanies) ? preferences.excludedCompanies : [];
    const candidateStatus = preferences.candidateStatus || 'Transferable Iqama';

    // 0. Hard Knockout Checks
    const normCompany = company.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isExcludedCompany = excludedCompanies.some(ec =>
      normCompany === String(ec).toLowerCase().replace(/[^a-z0-9]/g, '')
    );

    if (isExcludedCompany) {
      return {
        score: 0.0,
        verdict: 'FAIL',
        status: 'FAIL',
        shortlisted: false,
        knockout: 'EXCLUDED_COMPANY',
        rationale: `Company "${company}" is in excluded company list`,
        dimensions: { titleMatch: 0, locationMatch: 0, techStackMatch: 0, seniorityMatch: 0, watchlistTier: 0 },
        closingSoon: false,
        isOpen: job.isOpen !== false,
        ageBadge: `Open · Posted ${job.postedAgeDays || 0}d ago`
      };
    }

    // Regional Compliance & Saudization Knockout
    const compliance = KsaCountryPack.evaluateCompliance(textToScan, candidateStatus);
    if (!compliance.eligible) {
      return {
        score: 0.0,
        verdict: 'FAIL',
        status: 'FAIL',
        shortlisted: false,
        knockout: compliance.isSaudizationRestricted ? 'SAUDIZATION_RESTRICTED' : 'COMPLIANCE_INELIGIBLE',
        rationale: compliance.reason,
        dimensions: { titleMatch: 0, locationMatch: 0, techStackMatch: 0, seniorityMatch: 0, watchlistTier: 0 },
        closingSoon: false,
        isOpen: job.isOpen !== false,
        ageBadge: `Open · Posted ${job.postedAgeDays || 0}d ago`
      };
    }

    // D1: Title Match (Weight: 25%, Scale: 0.0 - 5.0)
    let dTitle = 2.0; // default baseline keyword overlap
    if (targetTitles.length > 0) {
      const titleLower = title.toLowerCase();
      const exactLateral = targetTitles.some(t => titleLower === t.toLowerCase());
      const partialMatch = targetTitles.some(t => titleLower.includes(t.toLowerCase()) || t.toLowerCase().includes(titleLower));

      if (exactLateral) {
        dTitle = 5.0;
      } else if (partialMatch) {
        dTitle = 4.0;
      } else {
        // Token overlap
        const words = titleLower.split(/[^\p{L}\p{N}+#.]+/u).filter(w => w.length > 3 || SHORT_ACRONYMS.has(w));
        const matchesWord = targetTitles.some(t => words.some(w => t.toLowerCase().includes(w)));
        dTitle = matchesWord ? 3.0 : 1.5;
      }
    } else {
      dTitle = 4.0;
    }

    // D2: Location & Work Mode Match (Weight: 20%, Scale: 0.0 - 5.0)
    let dLocation = 3.0;
    const locLower = location.toLowerCase();
    if (targetCities.length > 0) {
      const cityMatched = targetCities.some(c => locLower.includes(c.toLowerCase()));
      if (cityMatched) {
        dLocation = 5.0;
      } else if (/saudi arabia|ksa|riyadh|jeddah|neom|khobar|dammam|remote/i.test(locLower)) {
        dLocation = 3.5;
      } else if (locLower.length === 0) {
        dLocation = 3.0;
      } else {
        dLocation = 1.0;
      }
    } else {
      dLocation = 4.0;
    }

    // D3: Tech Stack Alignment (Weight: 25%, Scale: 0.0 - 5.0)
    let dTech = 3.5;
    if (Array.isArray(candidateSkills) && candidateSkills.length > 0) {
      let matchedCount = 0;
      for (const skill of candidateSkills) {
        if (skillMatchesText(textToScan, skill)) {
          matchedCount++;
        }
      }
      if (matchedCount >= 5) dTech = 5.0;
      else if (matchedCount >= 3) dTech = 4.5;
      else if (matchedCount >= 1) dTech = 3.5;
      else dTech = 2.0;
    }

    // D4: Seniority Level Fit (Weight: 15%, Scale: 0.0 - 5.0)
    let dSeniority = 4.0;
    if (/(?:principal|staff|lead|director|head|vp|chief)/i.test(title)) {
      dSeniority = 5.0;
    } else if (/(?:senior|sr\.?)/i.test(title)) {
      dSeniority = 4.0;
    } else if (/(?:junior|intern|graduate|entry)/i.test(title)) {
      dSeniority = 1.5;
    }

    // D5: Watchlist & Strategic Employer Tier (Weight: 15%, Scale: 0.0 - 5.0)
    let dWatchlist = 2.5;
    const reg = KsaCountryPack.getWatchlistRegistry();
    const enterprise = reg.findByCompanyName(company);
    const inCustomWatchlist = watchlist.some(w =>
      company.toLowerCase().includes(w.toLowerCase()) || w.toLowerCase().includes(company.toLowerCase())
    );

    if (inCustomWatchlist || (enterprise && enterprise.tier1)) {
      dWatchlist = 5.0;
    } else if (enterprise) {
      dWatchlist = 4.0;
    } else if (company.length > 0) {
      dWatchlist = 3.0;
    }

    // Closing-Soon & Urgency Evaluation
    // Evaluated BEFORE composite score calculation to allow priority escalation boost
    let closingSoon = false;
    let daysToClose = null;
    const deadline = job.deadlineAt || job.closingDate || job.deadline || job.applicationDeadline;
    if (deadline) {
      const deadlineMs = new Date(deadline).getTime();
      if (!isNaN(deadlineMs)) {
        const diffMs = deadlineMs - Date.now();
        daysToClose = diffMs / 86400000;
        // Urgent if deadline is within 7 days (and has not already passed)
        if (daysToClose >= 0 && daysToClose <= 7.0) {
          closingSoon = true;
        }
      }
    }
    // Honor explicit urgency or closingSoon flags if job is open
    if (
      job.closingSoon === true ||
      job.isClosingSoon === true ||
      job.urgencyFlag === 'CLOSING_SOON' ||
      job.urgent === true ||
      job.urgency === 'urgent'
    ) {
      closingSoon = true;
    }

    // Invariant: Closed jobs cannot receive a closing-soon priority escalation
    if (job.isOpen === false) {
      closingSoon = false;
    }

    // Composite Score Calculation
    let composite = (dTitle * 0.25) + (dLocation * 0.20) + (dTech * 0.25) + (dSeniority * 0.15) + (dWatchlist * 0.15);

    // Saudi National priority boost if Saudization applied
    if (compliance.isPriority) {
      composite = Math.min(5.0, composite + 0.5);
    }

    // Closing-Soon Priority Escalation Boost (+0.5, clamped at 5.0)
    if (closingSoon) {
      composite = Math.min(5.0, composite + 0.5);
    }

    const finalScore = Number(composite.toFixed(1));

    // Verdict
    let verdict = 'FAIL';
    let status = 'parked';
    let shortlisted = false;

    if (finalScore >= 3.5) {
      verdict = 'PASS';
      status = 'shortlisted';
      shortlisted = true;
    } else if (finalScore >= 3.0) {
      verdict = 'MARGINAL';
      status = 'shortlisted';
      shortlisted = true;
    }

    // Posting Age: Strictly informational, NEVER affects score
    let postedDays = typeof job.postedAgeDays === 'number' ? job.postedAgeDays : 0;
    if (!job.postedAgeDays && job.postedDate) {
      const postedMs = new Date(job.postedDate).getTime();
      if (!isNaN(postedMs)) {
        postedDays = Math.max(0, Math.floor((Date.now() - postedMs) / 86400000));
      }
    }
    const ageBadge = `Open · Posted ${postedDays}d ago`;

    const dimensions = {
      titleMatch: Number(dTitle.toFixed(1)),
      locationMatch: Number(dLocation.toFixed(1)),
      locationFit: Number(dLocation.toFixed(1)),
      techStackMatch: Number(dTech.toFixed(1)),
      skillsMatch: Number(dTech.toFixed(1)),
      seniorityMatch: Number(dSeniority.toFixed(1)),
      experienceFit: Number(dSeniority.toFixed(1)),
      watchlistTier: Number(dWatchlist.toFixed(1)),
      companyPrestige: Number(dWatchlist.toFixed(1))
    };

    return {
      score: finalScore,
      compositeScore: finalScore,
      verdict,
      status,
      shortlisted,
      dimensions,
      breakdown: dimensions,
      closingSoon,
      urgencyFlag: closingSoon ? 'CLOSING_SOON' : null,
      daysToClose: daysToClose !== null ? Number(daysToClose.toFixed(1)) : null,
      priorityBadge: closingSoon ? 'Closing Soon' : null,
      isOpen: job.isOpen !== false,
      ageBadge
    };
  }

  /**
   * Evidence-based closure guard. Rejects age-based closing attempts unconditionally.
   *
   * @param {object} job
   * @param {object} evidence - { type, proof }
   * @returns {boolean} True if closure is legitimately justified by evidence
   */
  static canCloseVacancy(job, evidence) {
    if (!evidence || typeof evidence !== 'object') {
      return false;
    }

    const type = String(evidence.type || '').toLowerCase();
    // Invariant: posting age or age limit is FORBIDDEN as closure evidence
    if (type === 'age' || type === 'age_limit' || type === 'posting_age' || type === 'days_old') {
      return false;
    }

    // Valid evidence types:
    return Boolean(
      type === 'http_404' ||
      type === 'http_410' ||
      type === 'explicit_closure_notice' ||
      type === 'passed_deadline' ||
      type === 'position_filled'
    );
  }
}

// Compatibility alias for test suites
const TriageScorer = {
  scoreVacancy: (job, preferences, skills) => {
    return JobScorer.scoreVacancy(job, preferences, skills);
  },
  canCloseVacancy: JobScorer.canCloseVacancy
};

module.exports = {
  skillMatchesText,
  SHORT_ACRONYMS,
  JobScorer,
  TriageScorer,
  scoreVacancy: JobScorer.scoreVacancy,
  canCloseVacancy: JobScorer.canCloseVacancy
};
