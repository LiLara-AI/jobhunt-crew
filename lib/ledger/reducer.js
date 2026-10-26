'use strict';

/**
 * JobHunt Crew — Pure Reducer & Materialized Snapshot
 * Derives and updates state snapshots from the append-only event ledger.
 * Location: lib/ledger/reducer.js (and aliased in lib/core/snapshot.js)
 */

const fs = require('fs');
const path = require('path');
const { EventLedger } = require('./ledger');

/**
 * Canonical URL cleaner for cross-channel vacancy deduplication.
 * Strips UTM tags, referrer tokens, and trailing slashes.
 */
function canonicalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gh_src', 'lever-source', 'ref', 'source', 'tracking_id', 'fbclid', 'gclid'
    ];
    for (const p of trackingParams) {
      u.searchParams.delete(p);
    }
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString().toLowerCase();
  } catch (_) {
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * Pure reducer function. Folds an array of events into materialized state.
 * @param {Array<Object>} events - Array of raw or parsed ledger events
 * @param {Object} [initialState=null] - Optional base state for incremental replay
 * @returns {Object} Materialized state projection
 */
function reduceEvents(events, initialState = null) {
  const base = initialState ? JSON.parse(JSON.stringify(initialState)) : {};
  const state = {
    version: base.version || 1,
    lastEventId: base.lastEventId !== undefined ? base.lastEventId : (base.lastSequence || 0),
    updatedAt: base.updatedAt || new Date(0).toISOString(),
    jobs: base.jobs || base.vacancies || {},
    applications: base.applications || {},
    outreach: base.outreach || {},
    health: base.health || {},
    decisions: Array.isArray(base.decisions) ? base.decisions : []
  };

  for (const e of events) {
    const eventType = (e.event || e.type || '').toUpperCase().replace(/:/g, '_');
    const p = e.payload || {};
    const timestamp = e.timestamp || new Date().toISOString();
    const actor = e.actor || 'system';

    switch (eventType) {
      case 'JOB_DISCOVERED': {
        const jobId = p.id || p.jobId;
        const cUrl = canonicalizeUrl(p.url);
        state.jobs[jobId] = {
          id: jobId,
          title: p.title,
          company: p.company,
          location: p.location || 'Unknown',
          url: p.url,
          canonicalUrl: cUrl,
          requisitionId: p.requisitionId || null,
          requisitionKey: p.requisitionKey || null,
          channel: p.channel || p.source || 'unknown',
          postedAgeDays: p.postedAgeDays || 0,
          status: 'discovered',
          discoveredAt: timestamp,
          updatedAt: timestamp,
          score: null,
          triageNotes: null
        };
        break;
      }

      case 'JOB_TRIAGED': {
        const jobId = p.id || p.jobId;
        if (state.jobs[jobId]) {
          state.jobs[jobId].score = p.score;
          state.jobs[jobId].status = p.status || (p.score >= 4.0 ? 'shortlisted' : 'parked');
          state.jobs[jobId].triageNotes = p.rationale || p.notes || null;
          state.jobs[jobId].updatedAt = timestamp;
        }
        break;
      }

      case 'JOB_SELECTED': {
        const jobId = p.jobId || p.id;
        state.decisions.push({
          id: p.decisionId || `dec_${e.id || e.seq}`,
          type: p.decisionType || p.decision || 'select',
          jobId,
          actor,
          timestamp
        });
        if (state.jobs[jobId]) {
          state.jobs[jobId].status = 'selected';
          state.jobs[jobId].updatedAt = timestamp;
        }
        break;
      }

      case 'DECISION_RECORDED': {
        const jobId = p.jobId || p.id;
        const decType = p.decisionType || p.decision;
        state.decisions.push({
          id: p.decisionId || `dec_${e.id || e.seq}`,
          type: decType,
          jobId,
          actor,
          timestamp
        });
        if (state.jobs[jobId]) {
          if (decType === 'apply') {
            state.jobs[jobId].status = 'selected';
          } else if (decType === 'shortlist_confirm') {
            state.jobs[jobId].status = 'shortlisted';
          }
          state.jobs[jobId].updatedAt = timestamp;
        }
        break;
      }

      case 'DRAFT_GENERATED': {
        const jobId = p.jobId;
        state.applications[jobId] = {
          jobId,
          status: 'drafted',
          draft: {
            cvText: p.cvText,
            clText: p.clText,
            claimsUsed: p.claimsUsed || [],
            generatedAt: timestamp
          },
          updatedAt: timestamp
        };
        if (state.jobs[jobId]) {
          state.jobs[jobId].status = 'preparing';
          state.jobs[jobId].updatedAt = timestamp;
        }
        break;
      }

      case 'CLAIMS_VERIFIED': {
        const jobId = p.jobId;
        if (!state.applications[jobId]) {
          state.applications[jobId] = { jobId, status: 'verifying', updatedAt: timestamp };
        }
        state.applications[jobId].verification = {
          passed: p.passed === true,
          violationsCount: p.violationsCount || 0,
          violations: p.violations || [],
          verifiedAt: timestamp
        };
        state.applications[jobId].updatedAt = timestamp;
        break;
      }

      case 'BLIND_REVIEW_RECORDED': {
        const jobId = p.jobId;
        if (!state.applications[jobId]) {
          state.applications[jobId] = { jobId, status: 'reviewed', updatedAt: timestamp };
        }
        state.applications[jobId].review = {
          verdict: p.verdict,
          score: p.score,
          recruiterFeedback: p.recruiterFeedback,
          hiringManagerFeedback: p.hiringManagerFeedback,
          reviewedAt: timestamp
        };
        state.applications[jobId].updatedAt = timestamp;
        break;
      }

      case 'PACKAGE_MARKED_READY': {
        const jobId = p.jobId;
        if (state.jobs[jobId]) {
          state.jobs[jobId].status = 'ready';
          state.jobs[jobId].updatedAt = timestamp;
        }
        if (state.applications[jobId]) {
          state.applications[jobId].status = 'ready';
          state.applications[jobId].applyPackPath = p.applyPackUrl || p.applyPackPath;
          state.applications[jobId].updatedAt = timestamp;
        }
        break;
      }

      case 'BROWSER_FORM_PREFILLED': {
        const jobId = p.jobId;
        if (state.applications[jobId]) {
          state.applications[jobId].prefill = {
            status: 'ready-to-submit',
            fieldsFilled: p.fieldsFilled || [],
            tabTitle: p.tabTitle,
            actionRemaining: p.actionRemaining,
            prefilledAt: timestamp
          };
          state.applications[jobId].updatedAt = timestamp;
        }
        break;
      }

      case 'APPLICATION_SUBMITTED':
      case 'JOB_SUBMITTED': {
        const jobId = p.jobId || p.id;
        if (state.jobs[jobId]) {
          state.jobs[jobId].status = 'submitted';
          state.jobs[jobId].submittedAt = timestamp;
          state.jobs[jobId].updatedAt = timestamp;
        }
        if (state.applications[jobId]) {
          state.applications[jobId].status = 'submitted';
          state.applications[jobId].submittedAt = timestamp;
          state.applications[jobId].confirmedByHuman = true;
          state.applications[jobId].updatedAt = timestamp;
        }
        break;
      }

      case 'JOB_CLOSED': {
        const jobId = p.id || p.jobId;
        if (state.jobs[jobId]) {
          state.jobs[jobId].status = 'closed';
          state.jobs[jobId].closedReason = p.reason;
          state.jobs[jobId].closureEvidence = p.evidence || { type: p.evidenceType, proof: p.proof };
          state.jobs[jobId].closedAt = timestamp;
          state.jobs[jobId].updatedAt = timestamp;
        }
        break;
      }

      case 'FOLLOW_UP_SCHEDULED': {
        const jobId = p.jobId;
        if (state.applications[jobId]) {
          state.applications[jobId].followUp = {
            cadenceDay7: p.cadenceDay7,
            cadenceDay14: p.cadenceDay14
          };
          state.applications[jobId].updatedAt = timestamp;
        }
        break;
      }

      case 'OUTREACH_DRAFTED': {
        const jobId = p.jobId;
        state.outreach[jobId] = {
          jobId,
          persona: p.persona,
          text: p.text,
          channel: p.channel || 'linkedin',
          draftedAt: timestamp
        };
        break;
      }

      case 'OFFER_EVALUATED': {
        const jobId = p.jobId;
        if (state.applications[jobId]) {
          state.applications[jobId].offer = {
            baseSalarySar: p.baseSalarySar,
            housingAllowanceSar: p.housingAllowanceSar,
            transportAllowanceSar: p.transportAllowanceSar,
            grossTotalSar: p.grossTotalSar,
            eosbAccrual: p.eosbAccrual,
            evaluatedAt: timestamp
          };
          state.applications[jobId].updatedAt = timestamp;
        }
        break;
      }

      case 'SOURCE_DEGRADED': {
        const source = p.source || p.domain || 'unknown';
        if (!state.health.sources) state.health.sources = {};
        state.health.sources[source] = {
          status: 'DEGRADED',
          source,
          domain: p.domain,
          reason: p.reason,
          statusCode: p.statusCode,
          attempts: p.attempts,
          message: p.message,
          actionRequired: p.actionRequired,
          lastDegradedAt: timestamp
        };
        break;
      }

      case 'HEALTH_RECORDED': {
        const comp = p.component || 'system';
        state.health[comp] = {
          status: p.status,
          message: p.message,
          updatedAt: timestamp
        };
        break;
      }
    }

    state.lastEventId = e.id !== undefined ? e.id : e.seq;
    state.updatedAt = timestamp;
  }

  return state;
}

/**
 * Atomically writes the snapshot object to disk via temp-file rename.
 */
function writeSnapshotAtomically(snapshotPath, state) {
  const dir = path.dirname(snapshotPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${snapshotPath}.tmp.${process.pid}.${Date.now()}`;
  const content = JSON.stringify(state, null, 2);
  fs.writeFileSync(tempPath, content, 'utf8');

  try {
    fs.renameSync(tempPath, snapshotPath);
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      fs.copyFileSync(tempPath, snapshotPath);
      fs.unlinkSync(tempPath);
    } else {
      throw err;
    }
  }
}

/**
 * Replays ledger events and updates the materialized snapshot.
 */
async function replayLedger(options = {}) {
  const workspaceDir = options.workspaceDir || process.cwd();
  const ledgerPath = options.ledgerPath || path.join(workspaceDir, '.crew', 'ledger.jsonl');
  const snapshotPath = options.snapshotPath || path.join(workspaceDir, '.crew', 'snapshot.json');
  const rebuild = options.rebuild !== false;

  const ledger = new EventLedger({ ledgerPath });
  const events = ledger.readEvents();

  if (rebuild || !fs.existsSync(snapshotPath)) {
    const newState = reduceEvents(events);
    writeSnapshotAtomically(snapshotPath, newState);
    return newState;
  } else {
    let existingState;
    try {
      const existingContent = fs.readFileSync(snapshotPath, 'utf8');
      existingState = JSON.parse(existingContent);
    } catch (_) {
      const newState = reduceEvents(events);
      writeSnapshotAtomically(snapshotPath, newState);
      return newState;
    }

    const newEvents = events.filter(e => (e.id !== undefined ? e.id : e.seq) > (existingState.lastEventId || 0));
    if (newEvents.length === 0) return existingState;

    const updatedState = reduceEvents(newEvents, existingState);
    writeSnapshotAtomically(snapshotPath, updatedState);
    return updatedState;
  }
}

module.exports = {
  reduceEvents,
  replayLedger,
  writeSnapshotAtomically,
  canonicalizeUrl
};
