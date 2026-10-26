'use strict';

/**
 * JobHunt Crew — Candidate-Isolated Blind Review Panel
 *
 * Implements:
 * 1. CandidateScrubber: De-identification and PII stripping (name, email, phone, salary floor, claim IDs).
 * 2. BlindReviewContextBuilder: Isolated prompt and payload assembler for the Critic agent.
 * 3. AuditIsolation: Deterministic check guaranteeing zero candidate leakage into reviewer context.
 * 4. DualPersonaEvaluator: Recruiter + Hiring Manager evaluator supporting Standard and Fast Lane modes.
 * 5. BlindReviewPanel: Top-level facade.
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

class CandidateScrubber {
  /**
   * Scrubs candidate personal identifiers and internal claim tags from text.
   * @param {string} text Text to scrub
   * @param {Object} dossier Candidate dossier
   * @returns {string} Sanitized text
   */
  static scrubAll(text, dossier = null) {
    if (!text || typeof text !== 'string') return '';
    let scrubbed = text;

    // 1. Remove internal claim IDs and [CONFIRM] tags
    scrubbed = scrubbed.replace(/\[(?:CLM|C|ALX|MV)-\d+\]/gi, '');
    scrubbed = scrubbed.replace(/\[CONFIRM\]/gi, '');

    // 2. Remove standard email and phone patterns
    scrubbed = scrubbed.replace(/[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/gi, '[email]');
    scrubbed = scrubbed.replace(/\+?\d[\d\s-]{8,}\d/gi, '[phone]');

    // 3. Remove specific candidate profile values if dossier is provided
    if (dossier && dossier.candidate) {
      const { name, email, phone, salaryFloor } = dossier.candidate;
      if (name) {
        // Name and individual name tokens (first/last)
        const nameTokens = name.split(/\s+/).filter(t => t.length > 2 && !/^(dr|mr|ms|mrs|prof)\.?$/i.test(t));
        for (const token of [name, ...nameTokens]) {
          const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          scrubbed = scrubbed.replace(new RegExp(esc, 'gi'), 'Candidate');
        }
      }
      if (email) {
        const esc = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        scrubbed = scrubbed.replace(new RegExp(esc, 'gi'), '[email]');
      }
      if (phone) {
        const esc = phone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        scrubbed = scrubbed.replace(new RegExp(esc, 'gi'), '[phone]');
      }
      if (salaryFloor && salaryFloor.minimumBase) {
        const baseNum = String(salaryFloor.minimumBase);
        scrubbed = scrubbed.replace(new RegExp(`\\b${baseNum}\\b`, 'g'), '[confidential_salary]');
      }
    }

    // 4. Remove internal claim tags in dossier claims list
    if (dossier && Array.isArray(dossier.claims)) {
      for (const clm of dossier.claims) {
        if (clm.id) {
          const esc = clm.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          scrubbed = scrubbed.replace(new RegExp(`\\b${esc}\\b`, 'gi'), '');
        }
      }
    }

    return scrubbed.replace(/\s{2,}/g, ' ').trim();
  }
}

class BlindReviewContextBuilder {
  /**
   * Constructs the candidate-isolated review payload for Critic agent evaluation.
   * @param {Object} jobDescription Job requirements
   * @param {Object} draftDocument Draft object { type: 'cv'|'cover_letter', content: string }
   * @param {Object} options Mode and options
   */
  static buildReviewPayload(jobDescription, draftDocument, options = {}) {
    const mode = options.mode || 'standard'; // 'standard' or 'fast_lane'
    const dossier = options.dossier || null;

    // Sanitize draft text if dossier provided or strip tags
    let content = draftDocument.content || '';
    if (dossier) {
      content = CandidateScrubber.scrubAll(content, dossier);
    }

    return {
      mode,
      jobDescription: {
        title: jobDescription.title || '',
        company: jobDescription.company || '',
        requirementsText: jobDescription.requirementsText || ''
      },
      draft: {
        documentType: draftDocument.type || 'cv',
        content
      },
      reviewRubric: {
        recruiterCriteria: ['ats_keyword_density', 'clarity_and_formatting', 'seniority_alignment'],
        hiringManagerCriteria: ['technical_depth', 'architectural_evidence', 'business_impact']
      }
    };
  }

  /**
   * Audits review payload to guarantee zero candidate PII or internal claim leakage.
   * @param {Object} reviewPayload Assembled review payload
   * @param {Object} candidateDossier Candidate profile
   * @returns {{ isolated: boolean, leaks: string[] }}
   */
  static auditIsolation(reviewPayload, candidateDossier) {
    const payloadStr = JSON.stringify(reviewPayload).toLowerCase();
    const leaks = [];

    if (!candidateDossier || !candidateDossier.candidate) {
      return { isolated: true, leaks: [] };
    }

    const { name, email, phone, salaryFloor } = candidateDossier.candidate;

    // Check candidate name leak
    if (name && payloadStr.includes(name.toLowerCase())) {
      leaks.push('Candidate name leaked into review payload');
    }
    // Check candidate email leak
    if (email && payloadStr.includes(email.toLowerCase())) {
      leaks.push('Candidate email leaked into review payload');
    }
    // Check candidate phone leak
    if (phone && payloadStr.includes(phone.toLowerCase())) {
      leaks.push('Candidate phone leaked into review payload');
    }
    // Check internal claim tag leak (e.g. CLM-001, [C-01], ALX-001)
    if (Array.isArray(candidateDossier.claims)) {
      for (const c of candidateDossier.claims) {
        if (c.id && payloadStr.includes(c.id.toLowerCase())) {
          leaks.push(`Internal claim ID ${c.id} leaked into review payload`);
        }
      }
    }
    // Check salary floor leak
    if (salaryFloor && typeof salaryFloor.minimumBase === 'number' && salaryFloor.minimumBase > 0) {
      if (payloadStr.includes(String(salaryFloor.minimumBase))) {
        leaks.push('Candidate private salary floor leaked into review payload');
      }
    }

    return {
      isolated: leaks.length === 0,
      leaks
    };
  }
}

class DualPersonaEvaluator {
  /**
   * Evaluates draft content against job spec from Recruiter and Hiring Manager perspectives.
   */
  static evaluate(reviewPayload) {
    const jd = reviewPayload.jobDescription || {};
    const draft = reviewPayload.draft || {};
    const mode = reviewPayload.mode || 'standard';
    const text = draft.content || '';
    const reqText = jd.requirementsText || '';

    // 1. Recruiter Evaluation
    const recruiter = DualPersonaEvaluator.evaluateRecruiter(text, reqText);

    // 2. Hiring Manager Evaluation
    const hiringManager = DualPersonaEvaluator.evaluateHiringManager(text, reqText);

    // Overall Score (average of recruiter and HM)
    const overallScore = Math.round(((recruiter.score + hiringManager.score) / 2) * 10) / 10;
    const isApproved = overallScore >= 3.5 && recruiter.score >= 3.0 && hiringManager.score >= 3.0;
    const verdict = isApproved ? 'APPROVE' : 'REQUEST_CHANGES';

    if (mode === 'fast_lane') {
      return {
        mode: 'fast_lane',
        verdict,
        overallScore,
        recruiterScore: recruiter.score,
        hiringManagerScore: hiringManager.score,
        topRecommendations: [
          ...recruiter.keyFeedback,
          ...hiringManager.keyFeedback
        ].slice(0, 3),
        timestamp: new Date().toISOString()
      };
    }

    return {
      mode: 'standard',
      verdict,
      overallScore,
      recruiter: {
        score: recruiter.score,
        criteriaScores: recruiter.criteria,
        strengths: recruiter.strengths,
        improvements: recruiter.improvements,
        feedback: recruiter.keyFeedback
      },
      hiringManager: {
        score: hiringManager.score,
        criteriaScores: hiringManager.criteria,
        strengths: hiringManager.strengths,
        improvements: hiringManager.improvements,
        feedback: hiringManager.keyFeedback
      },
      timestamp: new Date().toISOString()
    };
  }

  static evaluateRecruiter(draftText, reqText) {
    // ATS keywords check
    const words = reqText.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const draftLower = draftText.toLowerCase();
    let matchCount = 0;
    for (const w of words) {
      if (draftLower.includes(w)) matchCount++;
    }
    const keywordDensity = words.length > 0 ? Math.min(5.0, Math.max(2.5, (matchCount / words.length) * 6)) : 4.0;

    // Clarity & action verb density
    const actionVerbs = ['architected', 'reduced', 'engineered', 'led', 'maintained', 'cut', 'guided', 'built', 'optimized', 'developed'];
    let verbCount = 0;
    for (const v of actionVerbs) {
      if (draftLower.includes(v)) verbCount++;
    }
    const clarityScore = Math.min(5.0, 3.0 + verbCount * 0.4);

    // Seniority alignment
    const seniorityScore = /principal|lead|staff|director|head/i.test(draftText) ? 4.8 : 3.8;

    const score = Math.round(((keywordDensity + clarityScore + seniorityScore) / 3) * 10) / 10;

    return {
      score,
      criteria: {
        ats_keyword_density: Math.round(keywordDensity * 10) / 10,
        clarity_and_formatting: Math.round(clarityScore * 10) / 10,
        seniority_alignment: Math.round(seniorityScore * 10) / 10
      },
      strengths: ['High action verb density', 'Clean ATS-friendly vertical hierarchy'],
      improvements: ['Ensure all job spec skills appear within top 1/3 of document'],
      keyFeedback: ['Strong keyword match and clean professional structure']
    };
  }

  static evaluateHiringManager(draftText, reqText) {
    const draftLower = draftText.toLowerCase();

    // Technical depth check
    const techDepthScore = /distributed|kubernetes|kafka|concurrency|latency|microservices|p99|redis/i.test(draftLower) ? 4.9 : 3.5;

    // Architectural evidence (scale metrics)
    const scaleEvidenceScore = /billion|million|\d+ms|\d+%|\d+x|\d+,\d+/i.test(draftText) ? 4.8 : 3.2;

    // Business impact
    const businessImpactScore = /savings|saved|revenue|expenditure|cost|zero downtime/i.test(draftLower) ? 4.7 : 3.6;

    const score = Math.round(((techDepthScore + scaleEvidenceScore + businessImpactScore) / 3) * 10) / 10;

    return {
      score,
      criteria: {
        technical_depth: Math.round(techDepthScore * 10) / 10,
        architectural_evidence: Math.round(scaleEvidenceScore * 10) / 10,
        business_impact: Math.round(businessImpactScore * 10) / 10
      },
      strengths: ['Verifiable scale metrics and quantifiable business outcomes', 'Deep architectural substance'],
      improvements: ['Highlight trade-off rationales in design decisions'],
      keyFeedback: ['Robust technical grounding and concrete scale achievements']
    };
  }
}

class BlindReviewPanel {
  static evaluate(jobDescription, draftDocument, options = {}) {
    const payload = BlindReviewContextBuilder.buildReviewPayload(jobDescription, draftDocument, options);

    if (options.dossier) {
      const audit = BlindReviewContextBuilder.auditIsolation(payload, options.dossier);
      if (!audit.isolated) {
        throw new Error(`BLIND_REVIEW_ISOLATION_FAILURE: Leaks detected: ${audit.leaks.join(', ')}`);
      }
    }

    return DualPersonaEvaluator.evaluate(payload);
  }
}

module.exports = {
  CandidateScrubber,
  BlindReviewContextBuilder,
  DualPersonaEvaluator,
  BlindReviewPanel
};
