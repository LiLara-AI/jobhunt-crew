'use strict';

/**
 * JobHunt Crew — Closing-Soon Urgency Alerts Scanner
 *
 * Scans materialized snapshot for open vacancies whose application deadlines
 * expire within a configurable window (default: 48h).
 *
 * @module lib/operational/alerts
 */

/**
 * Scans snapshot for open vacancies whose deadlines expire within windowHours.
 * @param {Object} snapshot - Materialized state snapshot (.crew/snapshot.json)
 * @param {number} [windowHours=48] - Alert window in hours
 * @param {Date|number} [referenceTime] - Optional reference timestamp for deterministic testing
 * @returns {Array<Object>} Prioritized alert records sorted by ascending remaining time
 */
function scanClosingSoonAlerts(snapshot, windowHours = 48, referenceTime = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const jobs = Object.values(snapshot.jobs || {});
  const now = typeof referenceTime === 'number' ? referenceTime : new Date(referenceTime).getTime();
  const maxMs = windowHours * 3600000;
  const alerts = [];

  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    if (job.status === 'closed' || job.isOpen === false || job.status === 'rejected') continue;

    const deadline = job.deadlineAt || job.closingDate || job.applicationDeadline || job.deadline;
    if (!deadline) continue;

    const deadlineMs = new Date(deadline).getTime();
    if (isNaN(deadlineMs)) continue;

    const remainingMs = deadlineMs - now;
    if (remainingMs > 0 && remainingMs <= maxMs) {
      const remainingHours = Number((remainingMs / 3600000).toFixed(1));
      let urgency = 'MEDIUM';
      if (remainingHours <= 24) {
        urgency = 'CRITICAL';
      } else if (remainingHours <= 48) {
        urgency = 'HIGH';
      }

      alerts.push({
        id: job.id,
        title: job.title,
        company: job.company,
        deadline: new Date(deadlineMs).toISOString(),
        remainingHours,
        remainingMs,
        urgency,
        url: job.canonicalUrl || job.url || ''
      });
    }
  }

  return alerts.sort((a, b) => a.remainingHours - b.remainingHours);
}

module.exports = {
  scanClosingSoonAlerts
};
