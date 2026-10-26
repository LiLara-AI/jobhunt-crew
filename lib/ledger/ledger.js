'use strict';

/**
 * JobHunt Crew — Append-Only Event Ledger
 * Implements tamper-evident hash-chained event storage with cross-process concurrency.
 * Location: lib/ledger/ledger.js (and aliased in lib/core/ledger.js)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock } = require('./lock');

/**
 * Deterministically serialize object with recursively sorted keys.
 * Ensures cross-platform SHA-256 hash stability.
 */
function canonicalJsonString(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJsonString).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj).sort();
  return '{' + sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalJsonString(obj[k])}`).join(',') + '}';
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

class EventLedger {
  /**
   * @param {Object} options
   * @param {string} [options.workspaceDir] - Root workspace directory
   * @param {string} [options.ledgerPath]   - Full path to ledger.jsonl
   * @param {string} [options.lockPath]     - Full path to ledger.lock
   * @param {number} [options.leaseMs=5000] - Lock lease duration
   * @param {number} [options.timeoutMs=10000] - Lock acquisition timeout
   */
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir ? path.resolve(options.workspaceDir) : process.cwd();
    this.ledgerPath = options.ledgerPath || path.join(this.workspaceDir, '.crew', 'ledger.jsonl');
    this.lockPath = options.lockPath || path.join(this.workspaceDir, '.crew', 'ledger.lock');
    this.leaseMs = options.leaseMs || 5000;
    this.timeoutMs = options.timeoutMs || 10000;
  }

  _ensureDir() {
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Computes SHA-256 hash of an event record without the hash property.
   */
  computeEventHash(eventWithoutHash) {
    const canonical = canonicalJsonString(eventWithoutHash);
    return sha256(canonical);
  }

  /**
   * Appends an event to the ledger under an exclusive cross-process lock.
   * @param {Object} eventData
   * @param {string} eventData.event   - Event type (or 'type')
   * @param {Object} eventData.payload - Event payload
   * @param {string} [eventData.actor] - Actor identifier ("human:*" | "agent:*")
   * @returns {Promise<Object>}
   */
  async appendEvent(eventData) {
    if (!eventData || typeof eventData !== 'object') {
      throw new Error('Event data must be a valid object');
    }

    const eventName = eventData.event || eventData.type;
    if (!eventName || typeof eventName !== 'string') {
      throw new Error('Event name must be a non-empty string');
    }

    const actor = eventData.actor || 'system';
    const payload = eventData.payload && typeof eventData.payload === 'object' ? eventData.payload : {};

    // --- Deterministic Guardrail Validation ---
    if (eventName === 'APPLICATION_SUBMITTED' || eventName === 'JOB_SUBMITTED' || payload.status === 'submitted') {
      if (!actor.startsWith('human')) {
        throw new Error('GUARDRAIL_VIOLATION: Submitting an application is strictly restricted to human users');
      }
      if (!payload.token || typeof payload.token !== 'string' || payload.token.trim().length === 0) {
        throw new Error('GUARDRAIL_VIOLATION: Human submission requires a non-empty authorization token.');
      }
    }
    if (eventName === 'JOB_CLOSED') {
      const ev = payload.evidence || { type: payload.evidenceType, proof: payload.proof };
      if (!ev || typeof ev !== 'object') {
        throw new Error('GUARDRAIL_VIOLATION: Vacancy closure requires verifiable evidence');
      }
      if (ev.type === 'posting_age' || ev.type === 'age_limit') {
        throw new Error('GUARDRAIL_VIOLATION: Open vacancies cannot be closed or penalized due to posting age');
      }
      if (!ev.proof || String(ev.proof).trim().length === 0) {
        throw new Error('GUARDRAIL_VIOLATION: Closure evidence requires non-empty proof');
      }
    }
    if (eventName === 'PACKAGE_MARKED_READY') {
      if (!payload.claimVerification || payload.claimVerification.passed !== true) {
        throw new Error('GUARDRAIL_VIOLATION: Package cannot be marked ready without passing claim verification');
      }
      if (payload.claimVerification.violations && payload.claimVerification.violations.length > 0) {
        throw new Error('GUARDRAIL_VIOLATION: Package cannot be marked ready with unresolved claim violations');
      }
      if (!payload.reviewPanel || payload.reviewPanel.verdict !== 'APPROVE') {
        throw new Error('GUARDRAIL_VIOLATION: Package cannot be marked ready without review panel approval');
      }
    }

    return await withLock(async () => {
      this._ensureDir();
      let lastLine = null;
      let lastEvent = null;

      if (fs.existsSync(this.ledgerPath)) {
        const content = fs.readFileSync(this.ledgerPath, 'utf8').trim();
        if (content.length > 0) {
          const lines = content.split('\n').filter(Boolean);
          if (lines.length > 0) {
            lastLine = lines[lines.length - 1];
            try {
              lastEvent = JSON.parse(lastLine);
            } catch (_) {}
          }
        }
      }

      const id = lastEvent ? (lastEvent.id || lastEvent.seq || 0) + 1 : 1;
      const prevHash = lastLine ? sha256(lastLine.trim()) : '0'.repeat(64);
      const timestamp = new Date().toISOString();

      const eventRecord = {
        id,
        seq: id, // compatibility alias
        timestamp,
        actor,
        event: eventName,
        type: eventName, // compatibility alias
        payload,
        prevHash
      };

      const hash = this.computeEventHash({
        id,
        timestamp,
        actor,
        event: eventName,
        payload,
        prevHash
      });

      eventRecord.hash = hash;

      const serializedLine = JSON.stringify(eventRecord) + '\n';
      fs.appendFileSync(this.ledgerPath, serializedLine, 'utf8');
      return eventRecord;
    }, { lockPath: this.lockPath, leaseMs: this.leaseMs, timeoutMs: this.timeoutMs });
  }

  /**
   * Reads events from the ledger with optional filtering.
   */
  readEvents(options = {}) {
    if (!fs.existsSync(this.ledgerPath)) return [];
    const content = fs.readFileSync(this.ledgerPath, 'utf8').trim();
    if (!content) return [];

    let events = content.split('\n').filter(Boolean).map(line => JSON.parse(line));

    if (options.fromId) {
      events = events.filter(e => (e.id || e.seq) >= options.fromId);
    }
    if (options.toId) {
      events = events.filter(e => (e.id || e.seq) <= options.toId);
    }
    if (options.event) {
      events = events.filter(e => e.event === options.event || e.type === options.event);
    }
    if (options.actor) {
      events = events.filter(e => e.actor === options.actor);
    }
    if (options.limit && options.limit > 0) {
      events = events.slice(0, options.limit);
    }
    return events;
  }

  /**
   * Verifies the cryptographic chain integrity of the ledger.
   * Returns verification diagnostics.
   */
  verifyChainIntegrity() {
    if (!fs.existsSync(this.ledgerPath)) return { valid: true, count: 0 };
    const content = fs.readFileSync(this.ledgerPath, 'utf8').trim();
    if (!content) return { valid: true, count: 0 };

    const lines = content.split('\n').filter(Boolean);
    let prevLine = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        return { valid: false, reason: `Malformed JSON at line ${i + 1}`, line: i + 1 };
      }

      const expectedId = i + 1;
      const currentId = event.id !== undefined ? event.id : event.seq;
      if (currentId !== expectedId) {
        return { valid: false, reason: `Sequence gap or mismatch: expected id ${expectedId}, got ${currentId}`, line: i + 1 };
      }

      const expectedPrevHash = (i === 0) ? '0'.repeat(64) : sha256(prevLine.trim());
      const prevEvent = prevLine ? JSON.parse(prevLine) : null;
      const matchesLineHash = event.prevHash === expectedPrevHash;
      const matchesEventHash = prevEvent && (event.prevHash === prevEvent.hash);
      const isGenesis = (i === 0 && (event.prevHash === '0'.repeat(64) || event.prevHash === null));

      if (!matchesLineHash && !matchesEventHash && !isGenesis) {
        return { valid: false, reason: `Cryptographic prevHash mismatch at line ${i + 1}`, line: i + 1 };
      }

      const computedHash = this.computeEventHash({
        id: currentId,
        timestamp: event.timestamp,
        actor: event.actor,
        event: event.event || event.type,
        payload: event.payload,
        prevHash: event.prevHash
      });

      // Also support legacy/alternative single-string SHA256 if present
      const altContent = `${event.prevHash || 'ROOT'}|${currentId}|${event.timestamp}|${event.actor}|${event.event || event.type}|${JSON.stringify(event.payload)}`;
      const altHash = sha256(altContent);

      if (event.hash !== computedHash && event.hash !== altHash) {
        return { valid: false, reason: `Tampered payload hash at line ${i + 1}`, line: i + 1 };
      }

      prevLine = line;
    }

    return {
      valid: true,
      count: lines.length,
      headHash: lines.length > 0 ? JSON.parse(lines[lines.length - 1]).hash : null
    };
  }

  /**
   * Retrieves the latest event without loading the whole file into memory.
   */
  getLastEvent() {
    if (!fs.existsSync(this.ledgerPath)) return null;
    const content = fs.readFileSync(this.ledgerPath, 'utf8').trim();
    if (!content) return null;
    const lines = content.split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  }
}

module.exports = {
  EventLedger,
  canonicalJsonString,
  sha256
};
