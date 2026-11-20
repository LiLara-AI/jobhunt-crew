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
        // Name and individual name tokens (first/last), word-boundary bounded
        // so "Ann" never mangles "annual" and "Ali" never mangles "alignment".
        const nameTokens = name.split(/\s+/).filter(t => t.length > 2 && !/^(dr|mr|ms|mrs|prof)\.?$/i.test(t));
        for (const token of [name, ...nameTokens]) {
          const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          scrubbed = scrubbed.replace(new RegExp(`\\b${esc}\\b`, 'gi'), 'Candidate');
        }
      }
      if (email) {
        const esc = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        scrubbed = scrubbed.replace(new RegExp(`(?<![\\w.+-])${esc}(?![\\w.-])`, 'gi'), '[email]');
      }
      if (phone) {
        const esc = phone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        scrubbed = scrubbed.replace(new RegExp(`(?<!\\d)${esc}(?!\\d)`, 'gi'), '[phone]');
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
        // Job records carry the posting text as `description`.
        requirementsText: jobDescription.requirementsText || jobDescription.description || ''
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

// agents/critic.md: "Score >= 4.0/5.0 required for APPROVE".
const APPROVAL_THRESHOLD = 4.0;
const PERSONA_MINIMUM = 3.0;

// Filler words in job descriptions that say nothing about fit.
const JD_STOPWORDS = new Set([
  'with', 'that', 'this', 'from', 'have', 'will', 'your', 'their', 'they', 'them', 'what', 'when',
  'where', 'which', 'would', 'should', 'must', 'into', 'over', 'such', 'than', 'then', 'also', 'able',
  'both', 'each', 'more', 'most', 'other', 'some', 'were', 'been', 'being', 'about', 'across',
  'including', 'looking', 'seeking', 'strong', 'role', 'work', 'working', 'year', 'years',
  'experience', 'experienced', 'required', 'requirements', 'preferred', 'plus', 'ideal', 'candidate',
  'within', 'ability', 'proven', 'excellent', 'knowledge', 'understanding', 'responsibilities',
  'using', 'well', 'good', 'least', 'minimum', 'join', 'help', 'need', 'needs'
]);

const ACTION_VERBS = ['architected', 'reduced', 'engineered', 'led', 'maintained', 'cut', 'guided', 'built', 'optimized', 'developed', 'managed', 'mentored', 'delivered', 'launched', 'improved', 'increased', 'negotiated', 'owned', 'directed', 'designed'];
const ACTION_VERB_PATTERN = new RegExp(`\\b(?:${ACTION_VERBS.join('|')})\\b`, 'g');

const CV_SECTIONS = [
  ['Experience', /\b(?:experience|employment|career history)\b/i],
  ['Education', /\b(?:education|university|bachelor|b\.?sc|m\.?sc|mba|ph\.?d)\b/i],
  ['Skills', /\b(?:skills|competenc\w+)\b/i]
];

// 1.0 when nothing is found, 5.0 once `target` is reached. No floor: an empty
// or off-topic draft scores 1.0 on every criterion.
function scaleScore(found, target) {
  return Math.round((1 + 4 * Math.min(1, found / target)) * 10) / 10;
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
    const jdText = `${jd.title || ''} ${jd.requirementsText || ''}`.trim();

    // 1. Recruiter Evaluation
    const recruiter = DualPersonaEvaluator.evaluateRecruiter(text, jdText, draft.documentType);

    // 2. Hiring Manager Evaluation
    const hiringManager = DualPersonaEvaluator.evaluateHiringManager(text, jdText);

    // Overall Score (average of recruiter and HM)
    const overallScore = Math.round(((recruiter.score + hiringManager.score) / 2) * 10) / 10;
    // Without job requirements, fit to the vacancy cannot be judged, so nothing is approved.
    const isApproved = recruiter.hasJobKeywords && overallScore >= APPROVAL_THRESHOLD &&
      recruiter.score >= PERSONA_MINIMUM && hiringManager.score >= PERSONA_MINIMUM;
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

  /**
   * Distinct job keywords: words longer than 3 letters that are not filler,
   * plus short upper-case acronyms (AWS, SQL, PMP).
   */
  static extractJobKeywords(jdText) {
    const keywords = new Set();
    for (const raw of String(jdText || '').split(/\W+/)) {
      const word = raw.toLowerCase();
      if ((word.length > 3 && !JD_STOPWORDS.has(word)) || /^[A-Z][A-Z0-9]{1,2}$/.test(raw)) keywords.add(word);
    }
    return [...keywords];
  }

  static evaluateRecruiter(draftText, jdText, documentType = 'cv') {
    const draftLower = draftText.toLowerCase();
    const draftWords = new Set(draftLower.split(/\W+/));
    const strengths = [];
    const improvements = [];
    const wordCount = draftText.split(/\s+/).filter(Boolean).length;
    if (wordCount === 0) improvements.push('The draft is empty');

    // ATS keywords: long words may match inside a longer form ("architect" in
    // "architected"); short acronyms must match as whole words.
    const keywords = DualPersonaEvaluator.extractJobKeywords(jdText);
    const matched = keywords.filter(k => (k.length > 3 ? draftLower.includes(k) : draftWords.has(k)));
    const missing = keywords.filter(k => !matched.includes(k));
    const keywordDensity = keywords.length > 0 ? scaleScore(matched.length / keywords.length, 0.6) : 1.0;
    if (keywords.length === 0) {
      improvements.push('No job requirements were supplied, so fit to the vacancy cannot be assessed — provide the job description');
    } else {
      if (matched.length > 0) strengths.push(`Covers ${matched.length} of ${keywords.length} job keywords (${matched.slice(0, 6).join(', ')})`);
      if (missing.length > 0) improvements.push(`Job keywords not found in the draft: ${missing.slice(0, 10).join(', ')}`);
    }

    // Clarity: distinct action verbs, as whole words.
    const verbs = [...new Set(draftLower.match(ACTION_VERB_PATTERN) || [])];
    const clarityScore = scaleScore(verbs.length, 5);
    if (verbs.length >= 3) strengths.push(`Uses ${verbs.length} distinct action verbs (${verbs.slice(0, 6).join(', ')})`);
    else improvements.push('Few action verbs — open each point with what was done (led, built, reduced, delivered)');

    // Seniority alignment
    const senioritySignals = [/principal|lead|staff|director|head|senior|manager|chief|vp\b|partner/i, /\b\d+\+?\s*years?\b/i, /mentor|managed|supervised|team of/i];
    const seniorityHits = senioritySignals.reduce((n, p) => n + (p.test(draftText) ? 1 : 0), 0);
    const seniorityScore = scaleScore(seniorityHits, 3);
    if (seniorityHits >= 2) strengths.push('Seniority is evident (title level, years of experience or team leadership)');
    else improvements.push('Seniority is not evident — no clear title level, years of experience or team leadership');

    if (documentType === 'cv' && wordCount > 0) {
      const missingSections = CV_SECTIONS.filter(([, pattern]) => !pattern.test(draftText)).map(([name]) => name);
      if (missingSections.length > 0) improvements.push(`Missing CV sections: ${missingSections.join(', ')}`);
    }

    const score = Math.round(((keywordDensity + clarityScore + seniorityScore) / 3) * 10) / 10;

    return {
      score,
      hasJobKeywords: keywords.length > 0,
      criteria: {
        ats_keyword_density: keywordDensity,
        clarity_and_formatting: clarityScore,
        seniority_alignment: seniorityScore
      },
      strengths,
      improvements,
      keyFeedback: improvements.length > 0 ? improvements : strengths
    };
  }

  static evaluateHiringManager(draftText, reqText) {
    const draftLower = draftText.toLowerCase();
    const countHits = (patterns) => patterns.reduce((n, p) => n + (p.test(draftLower) ? 1 : 0), 0);
    const strengths = [];
    const improvements = [];

    // Technical/professional depth: generic craft signals plus domain terms,
    // graduated by number of distinct signals (not one keyword family).
    const depthHits = countHits([
      /distributed|kubernetes|kafka|concurrency|latency|microservices|p99|redis/,
      /architect|design|system|platform|infrastructure|scalab|reliab/,
      /automat|pipeline|ci\/cd|testing|observability|monitoring|security/,
      /data|analytics|experiment|research|model|algorithm/,
      /process|workflow|operations|quality|compliance|governance/
    ]);
    const techDepthScore = scaleScore(depthHits, 4);
    if (depthHits >= 3) strengths.push(`Shows technical or professional depth across ${depthHits} areas`);
    else improvements.push('Little technical or professional depth — describe the systems, methods and tools involved');

    // Evidence: quantified scale/outcome metrics of any kind.
    const evidenceHits = countHits([
      /billion|million|thousand/,
      /\d+(?:\.\d+)?\s*(?:ms|%|x\b)/,
      /\d{1,3}(?:,\d{3})+/,
      /\b\d+\+?\s*(?:users|customers|clients|requests|transactions|projects|teams|engineers|people|reports)\b/,
      /\b\d+\+?\s*years?\b/
    ]);
    const scaleEvidenceScore = scaleScore(evidenceHits, 4);
    if (evidenceHits >= 2) strengths.push(`Results are quantified (${evidenceHits} kinds of metric)`);
    else if (evidenceHits === 1) improvements.push('Only one kind of quantified result — bring in more metrics from the verified dossier');
    else improvements.push('No quantified results — bring in metrics from the verified dossier');

    // Business impact & leadership: outcomes, ownership, people signals.
    const impactHits = countHits([
      /savings|saved|revenue|expenditure|cost|zero downtime|budget|profit|growth/,
      /increased|reduced|improved|grew|delivered|launched|shipped|achieved/,
      /led|managed|mentored|coached|hired|supervised|directed|owned/,
      /stakeholder|customer|client|partner|cross-functional|executive|board/,
      /strategy|roadmap|vision|initiative|transformation|negotiat/
    ]);
    const businessImpactScore = scaleScore(impactHits, 4);
    if (impactHits >= 3) strengths.push('Business impact and ownership are stated');
    else improvements.push('Business impact is thin — state outcomes, ownership and who benefited');

    const score = Math.round(((techDepthScore + scaleEvidenceScore + businessImpactScore) / 3) * 10) / 10;

    return {
      score,
      criteria: {
        technical_depth: techDepthScore,
        architectural_evidence: scaleEvidenceScore,
        business_impact: businessImpactScore
      },
      strengths,
      improvements,
      keyFeedback: improvements.length > 0 ? improvements : strengths
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
