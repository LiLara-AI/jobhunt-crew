'use strict';

/**
 * JobHunt Crew — Weekly Retrospective & Scoring Optimizer
 *
 * Analyzes ledger events over a configurable window (default: 7 days) to
 * compute funnel metrics, identify knockout bottlenecks, and generate
 * candidate-approved scoring parameter recommendations.
 *
 * @module lib/operational/retrospective
 */

/**
 * Generates retrospective analysis from event history.
 * @param {Array<Object>|Object} ledgerOrEvents - Array of events or EventLedger instance
 * @param {Object} [options]
 * @param {number} [options.days=7] Time window in days
 * @param {Date|number} [options.referenceTime] Deterministic reference time
 * @returns {Object} Analytical retrospective report
 */
function generateRetrospective(ledgerOrEvents, options = {}) {
  const days = options.days || 7;
  const now = options.referenceTime ? new Date(options.referenceTime).getTime() : Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  const cutoffTime = now - windowMs;

  let events = [];
  if (Array.isArray(ledgerOrEvents)) {
    events = ledgerOrEvents;
  } else if (ledgerOrEvents && typeof ledgerOrEvents.readAllEvents === 'function') {
    events = ledgerOrEvents.readAllEvents();
  }

  const windowEvents = events.filter(e => {
    const t = e.timestamp ? new Date(e.timestamp).getTime() : 0;
    return t >= cutoffTime && t <= now;
  });

  let discoveredCount = 0;
  let triagedCount = 0;
  let passCount = 0;
  let marginalCount = 0;
  let failCount = 0;
  const knockoutReasons = {};
  const missingKeywords = {};
  let submittedCount = 0;

  for (const event of windowEvents) {
    if (event.event === 'JOB_DISCOVERED') {
      discoveredCount++;
    } else if (event.event === 'JOB_TRIAGED') {
      triagedCount++;
      const payload = event.payload || {};
      const verdict = (payload.status || payload.verdict || '').toUpperCase();
      if (verdict === 'SHORTLISTED' || verdict === 'PASS') {
        passCount++;
      } else if (verdict === 'MARGINAL') {
        marginalCount++;
      } else {
        failCount++;
      }

      if (payload.knockoutReason) {
        knockoutReasons[payload.knockoutReason] = (knockoutReasons[payload.knockoutReason] || 0) + 1;
      }
      if (Array.isArray(payload.missingSkills)) {
        for (const skill of payload.missingSkills) {
          missingKeywords[skill] = (missingKeywords[skill] || 0) + 1;
        }
      }
    } else if (event.event === 'APPLICATION_SUBMITTED') {
      submittedCount++;
    }
  }

  const passRate = triagedCount > 0 ? Number(((passCount / triagedCount) * 100).toFixed(1)) : 0;

  // Build actionable recommendations
  const proposals = [];
  const topMissing = Object.entries(missingKeywords)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  for (const [kw, count] of topMissing) {
    proposals.push({
      type: 'SKILL_COVERAGE_GAP',
      keyword: kw,
      affectedVacancies: count,
      suggestion: `Add verified claim for '${kw}' to dossier if supported by verified background.`
    });
  }

  return {
    windowDays: days,
    eventCount: windowEvents.length,
    funnel: {
      discovered: discoveredCount,
      triaged: triagedCount,
      passed: passCount,
      marginal: marginalCount,
      failed: failCount,
      submitted: submittedCount,
      passRatePercent: passRate
    },
    topKnockoutReasons: knockoutReasons,
    missingKeywords,
    proposals
  };
}

module.exports = {
  generateRetrospective
};
