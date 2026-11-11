'use strict';

/**
 * JobHunt Crew — Follow-Up Cadence Engine & Scam Triage Sentinel
 *
 * Implements:
 * - 7-day and 14-day post-submission follow-up cadence calculation.
 * - Read-only NLP/regex inbox signal parser for candidate communications.
 * - ScamSentinel calculating composite risk scores against predatory scams.
 *
 * @module lib/crew/cadence
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_7_MS = 7 * DAY_MS;
const DAY_14_MS = 14 * DAY_MS;

const FREEMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'protonmail.com',
  'aol.com',
  'zoho.com',
  'mail.com',
  'gmx.com',
  'yandex.com'
]);

const TIER1_ENTERPRISES = [
  'aramco',
  'neom',
  'pif',
  'stc',
  'sabic',
  'red sea global',
  'roshn',
  'diriyah',
  'qiddiya',
  'elm',
  'almarai',
  'google',
  'microsoft',
  'amazon',
  'apple',
  'meta'
];

/**
 * Cadence calculation and application follow-up tracker.
 */
class CadenceEngine {
  /**
   * Calculates follow-up cadence milestones for a single application.
   * @param {string|Date} submissionDate - Timestamp of application submission
   * @param {string|Date} [referenceDate] - Current reference date for calculation
   * @param {Object} [options]
   * @param {boolean} [options.day7FollowUpSent=false]
   * @param {boolean} [options.day14FollowUpSent=false]
   * @returns {Object} Cadence analysis
   */
  static calculateCadence(submissionDate, referenceDate = new Date(), options = {}) {
    const subTime = new Date(submissionDate).getTime();
    const refTime = new Date(referenceDate).getTime();

    if (isNaN(subTime)) {
      throw new Error(`Invalid submissionDate: ${submissionDate}`);
    }

    const elapsedMs = Math.max(0, refTime - subTime);
    const daysSinceSubmission = Math.floor(elapsedMs / DAY_MS);

    const cadenceDay7Date = new Date(subTime + DAY_7_MS).toISOString();
    const cadenceDay14Date = new Date(subTime + DAY_14_MS).toISOString();

    const day7Sent = Boolean(options.day7FollowUpSent || options.day7Sent);
    const day14Sent = Boolean(options.day14FollowUpSent || options.day14Sent);

    let day7Status = 'PENDING';
    let day14Status = 'PENDING';
    let nextAction = 'WAITING';
    let daysUntilDue = 0;

    if (daysSinceSubmission < 7) {
      day7Status = day7Sent ? 'SENT' : 'PENDING';
      day14Status = 'PENDING';
      nextAction = 'WAITING';
      daysUntilDue = 7 - daysSinceSubmission;
    } else if (daysSinceSubmission < 14) {
      if (day7Sent) {
        day7Status = 'SENT';
        day14Status = 'PENDING';
        nextAction = 'WAITING_DAY_14';
        daysUntilDue = 14 - daysSinceSubmission;
      } else {
        day7Status = 'DUE';
        day14Status = 'PENDING';
        nextAction = 'DUE_CADENCE_7';
        daysUntilDue = 0;
      }
    } else {
      // 14 days or beyond: the Day-14 hiring-manager nudge outranks a missed
      // Day-7 recruiter nudge. Sending the older note first would waste the
      // one escalation touch that still matters at this point.
      if (day14Sent) {
        day7Status = day7Sent ? 'SENT' : 'SKIPPED';
        day14Status = 'SENT';
        nextAction = 'CADENCE_COMPLETE';
        daysUntilDue = 0;
      } else if (day7Sent) {
        day7Status = 'SENT';
        day14Status = 'DUE';
        nextAction = 'DUE_CADENCE_14';
        daysUntilDue = 0;
      } else {
        day7Status = 'DUE';
        day14Status = 'DUE';
        nextAction = 'DUE_CADENCE_14';
        daysUntilDue = 0;
      }
    }

    const overdueDays = (!day14Sent && daysSinceSubmission > 14) ? daysSinceSubmission - 14 : 0;
    let priority = 'NORMAL';
    if (nextAction === 'DUE_CADENCE_14') priority = overdueDays > 14 ? 'URGENT' : 'HIGH';
    else if (nextAction === 'DUE_CADENCE_7') priority = 'MEDIUM';

    return {
      submissionDate: new Date(subTime).toISOString(),
      referenceDate: new Date(refTime).toISOString(),
      daysSinceSubmission,
      cadenceDay7Date,
      cadenceDay14Date,
      day7Status,
      day14Status,
      nextAction,
      daysUntilDue,
      overdueDays,
      priority,
      suggestedDraftPersona: (nextAction === 'DUE_CADENCE_14' || daysSinceSubmission >= 14) ? 'HIRING_MANAGER' : 'RECRUITER'
    };
  }

  /**
   * Evaluates all submitted applications against cadence rules.
   */
  static evaluateApplications(applications, referenceDate = new Date(), options = {}) {
    const list = Array.isArray(applications) ? applications : Object.values(applications || {});
    const results = [];

    for (const app of list) {
      if (!app || typeof app !== 'object') continue;
      if (app.status !== 'submitted' && app.status !== 'applied') continue;
      const subDate = app.submittedAt || app.appliedAt;
      if (!subDate) continue;

      const cadence = CadenceEngine.calculateCadence(subDate, referenceDate, {
        day7FollowUpSent: app.day7FollowUpSent || (app.followUps && app.followUps.day7),
        day14FollowUpSent: app.day14FollowUpSent || (app.followUps && app.followUps.day14)
      });

      results.push({
        jobId: app.id || app.jobId,
        company: app.company,
        title: app.title,
        ...cadence
      });
    }

    const ws = options && (options.workspaceDir || options.workspace);
    if (options && (ws || options.contactTracker || Array.isArray(options.contacts))) {
      try {
        let due = [];
        if (Array.isArray(options.contacts)) {
          const cutoff = new Date(referenceDate).getTime();
          due = options.contacts.filter(c => c && c.nextFollowUpAt && new Date(c.nextFollowUpAt).getTime() <= cutoff);
        } else {
          const tracker = options.contactTracker || new (require('../operational/contacts').ContactTracker)({ workspaceDir: ws });
          due = tracker.listContacts({ dueBefore: new Date(referenceDate).toISOString() });
        }
        for (const r of results) {
          r.contactsDue = due.filter(c => (c.jobId && c.jobId === r.jobId) ||
            (c.company && r.company && String(c.company).toLowerCase() === String(r.company).toLowerCase()));
        }
      } catch (_) {
        for (const r of results) r.contactsDue = [];
      }
    }

    const rank = { URGENT: 0, HIGH: 1, MEDIUM: 2, NORMAL: 3 };
    results.sort((a, b) => {
      const byPriority = (rank[a.priority] !== undefined ? rank[a.priority] : 3) - (rank[b.priority] !== undefined ? rank[b.priority] : 3);
      if (byPriority !== 0) return byPriority;
      return (b.overdueDays || 0) - (a.overdueDays || 0);
    });

    return results;
  }
}

/**
 * Read-only NLP/regex parser for incoming recruiter and platform emails.
 */
class InboxSignalParser {
  /**
   * Parses an email/message object into a typed recruitment signal.
   * @param {Object|string} message
   * @returns {Object} Signal classification
   */
  static parseSignal(message) {
    let text = '';
    let subject = '';
    let sender = '';

    if (typeof message === 'string') {
      text = message;
    } else if (message && typeof message === 'object') {
      subject = message.subject || '';
      sender = message.sender || message.from || '';
      text = `${subject}\n${message.body || message.text || message.snippet || ''}`;
    }

    const cleanText = text.trim();

    // 1. Interview Invitation
    const interviewRegexEn = /\b(?:interview invitation|schedule (?:an|your) interview|invite you to interview|calendly\.com|round of interviews|technical interview|screening call with|speak with the hiring manager|invitation to interview)\b/i;
    const interviewRegexAr = /(?:دعوة للمقابلة|مقابلة شخصية|تحديد موعد مقابلة|إجراء مقابلة)/;
    if (interviewRegexEn.test(cleanText) || interviewRegexAr.test(cleanText)) {
      return {
        category: 'INTERVIEW_INVITATION',
        confidence: 0.95,
        isInterview: true,
        matchedKeywords: ['interview'],
        rawSnippet: cleanText.slice(0, 200)
      };
    }

    // 2. Positive Engagement
    const positiveRegex = /\b(?:reviewed your application|impressed with your background|progress to the next (?:stage|step)|shortlisted your profile|next steps in the hiring process|moving forward with your application)\b/i;
    if (positiveRegex.test(cleanText)) {
      return {
        category: 'POSITIVE_ENGAGEMENT',
        confidence: 0.85,
        isInterview: false,
        matchedKeywords: ['next steps'],
        rawSnippet: cleanText.slice(0, 200)
      };
    }

    // 3. Rejection
    const rejectRegexEn = /\b(?:not moving forward|decided to pursue other candidates|impressed by your qualifications, however|regret to inform|high volume of applicants|wish you (?:the best|every success) in your job search|unfortunately we will not be proceeding)\b/i;
    const rejectRegexAr = /(?:نعتذر عن عدم قبول|نأسف لإبلاغك|نتمنى لك التوفيق في مسيرتك)/;
    if (rejectRegexEn.test(cleanText) || rejectRegexAr.test(cleanText)) {
      return {
        category: 'REJECTION',
        confidence: 0.95,
        isInterview: false,
        matchedKeywords: ['rejection'],
        rawSnippet: cleanText.slice(0, 200)
      };
    }

    // 4. Application Acknowledged
    const ackRegexEn = /\b(?:thank you for (?:your )?applying|application received|we have received your application|confirming receipt of your application)\b/i;
    const ackRegexAr = /(?:تم استلام طلبك|شكرا لتقديمك)/;
    if (ackRegexEn.test(cleanText) || ackRegexAr.test(cleanText)) {
      return {
        category: 'APPLICATION_ACKNOWLEDGED',
        confidence: 0.90,
        isInterview: false,
        matchedKeywords: ['application received'],
        rawSnippet: cleanText.slice(0, 200)
      };
    }

    return {
      category: 'UNRECOGNIZED_OR_SPAM',
      confidence: 0.2,
      isInterview: false,
      matchedKeywords: [],
      rawSnippet: cleanText.slice(0, 200)
    };
  }

  /**
   * Correlates an incoming message signal with an active job in the system.
   */
  static correlateWithApplications(signal, activeJobs) {
    const jobs = Array.isArray(activeJobs) ? activeJobs : Object.values(activeJobs || {});
    const snippet = (signal.rawSnippet || '').toLowerCase();

    for (const job of jobs) {
      if (!job || typeof job !== 'object') continue;
      const company = (job.company || '').toLowerCase();
      if (company && company.length > 2 && snippet.includes(company)) {
        return { matchedJob: job, correlationMethod: 'COMPANY_NAME' };
      }
    }

    return { matchedJob: null, correlationMethod: 'NONE' };
  }
}

/**
 * Defensive scam and phishing detector calculating risk scores.
 */
class ScamSentinel {
  /**
   * Triages message content or job posting for recruitment fraud indicators.
   * @param {string|Object} content
   * @param {Object} [metadata]
   * @param {boolean} [metadata.hasMatchingApplication=true] Whether candidate applied to this firm
   * @returns {Object} Scam risk assessment
   */
  static triage(content, metadata = {}) {
    let text = '';
    let sender = '';
    if (typeof content === 'string') {
      text = content;
    } else if (content && typeof content === 'object') {
      text = `${content.subject || ''}\n${content.body || content.text || content.snippet || ''}`;
      sender = content.sender || content.from || '';
    }

    const lowerText = text.toLowerCase();
    const lowerSender = sender.toLowerCase();
    const indicators = [];
    let score = 0;

    // Rule 1: Unsolicited cold offer without application
    if (metadata.hasMatchingApplication === false || metadata.applied === false) {
      if (/congratulations.*(?:offer|appointed|hired|selected for the position|employment agreement)/i.test(text)) {
        score += 30;
        indicators.push({
          ruleId: 'UNSOLICITED_COLD_OFFER',
          points: 30,
          severity: 'HIGH',
          message: 'Received job offer without prior application record in ledger'
        });
      }
    }

    // Rule 2: Freemail domain spoofing top-tier enterprise
    const senderDomain = lowerSender.includes('@') ? lowerSender.split('@')[1] : '';
    if (FREEMAIL_DOMAINS.has(senderDomain)) {
      for (const ent of TIER1_ENTERPRISES) {
        if (lowerText.includes(ent) || lowerSender.includes(ent)) {
          score += 35;
          indicators.push({
            ruleId: 'FREEMAIL_ENTERPRISE_SPOOF',
            points: 35,
            severity: 'HIGH',
            message: `Free webmail address (@${senderDomain}) claiming representation of ${ent}`
          });
          break;
        }
      }
    }

    // Rule 3: Upfront fee demand
    const feeRegex = /\b(?:visa processing fee|security deposit|refundable fee|registration fee|background check fee|payment required|training fee|processing charges)\b/i;
    if (feeRegex.test(lowerText) || (/\b(?:pay|send|wire)\b/i.test(lowerText) && /\b(?:visa|deposit|fee|charge)\b/i.test(lowerText))) {
      score += 50;
      indicators.push({
        ruleId: 'UPFRONT_FEE_DEMAND',
        points: 50,
        severity: 'CRITICAL',
        message: 'Demands upfront payment for visa processing, onboarding, or background checks'
      });
    }

    // Rule 4: Home office equipment vendor kickback
    const equipRegex = /\b(?:approved vendor|certified vendor|equipment vendor|purchase (?:home|office) equipment|reimbursed in (?:first|your) paycheck)\b/i;
    if (equipRegex.test(lowerText)) {
      score += 45;
      indicators.push({
        ruleId: 'EQUIPMENT_VENDOR_KICKBACK',
        points: 45,
        severity: 'CRITICAL',
        message: 'Directs candidate to purchase equipment from certified/approved vendor with promised reimbursement'
      });
    }

    // Rule 5: Cheque cashing / overpayment wire fraud
    const chequeRegex = /\b(?:cashier'?s check|mobile deposit|wire (?:back|the) (?:difference|remaining)|overpayment|cash the check)\b/i;
    if (chequeRegex.test(lowerText)) {
      score += 50;
      indicators.push({
        ruleId: 'CHEQUE_CASHING_OVERPAYMENT',
        points: 50,
        severity: 'CRITICAL',
        message: 'Instructs candidate to deposit a check and wire funds'
      });
    }

    // Rule 6: Off-platform chat only (Telegram / WhatsApp text chat interview)
    const chatRegex = /\b(?:telegram (?:app|channel|@|username)|interview via whatsapp|whatsapp (?:chat|interview only)|google hangouts interview)\b/i;
    if (chatRegex.test(lowerText)) {
      score += 25;
      indicators.push({
        ruleId: 'OFF_PLATFORM_CHAT_ONLY',
        points: 25,
        severity: 'HIGH',
        message: 'Recruitment interview conducted exclusively via informal chat app'
      });
    }

    // Rule 7: Inflated salary red flag
    if (/(?:\$1[0-9]{2}\/hour for data entry|\$5,000\/week part[- ]time|\$6,000\/week part[- ]time)/i.test(lowerText)) {
      score += 20;
      indicators.push({
        ruleId: 'INFLATED_SALARY_RED_FLAG',
        points: 20,
        severity: 'MEDIUM',
        message: 'Extravagantly high compensation advertised for low-complexity position'
      });
    }

    const finalScore = Math.min(100, score);
    const hasCritical = indicators.some(i => i.severity === 'CRITICAL');

    let riskLevel = 'NONE';
    let isScam = false;
    let recommendation = 'PROCEED';

    if (finalScore >= 50 || hasCritical) {
      riskLevel = 'CRITICAL';
      isScam = true;
      recommendation = 'BLOCK_AND_REPORT';
    } else if (finalScore >= 30) {
      riskLevel = 'HIGH';
      isScam = true;
      recommendation = 'FLAG_FOR_REVIEW';
    } else if (finalScore >= 15) {
      riskLevel = 'MEDIUM';
      isScam = false;
      recommendation = 'CAUTION';
    }

    return {
      isScam,
      riskScore: finalScore,
      riskLevel,
      indicators,
      recommendation
    };
  }
}

module.exports = {
  CadenceEngine,
  InboxSignalParser,
  ScamSentinel,
  DAY_7_MS,
  DAY_14_MS
};
