'use strict';

/**
 * JobHunt Crew — Operational Diagnostics (6-Probe Engine)
 *
 * Implements the 6 diagnostic probes for workspace health, cryptographic ledger integrity,
 * lockfile process liveness, connector endpoints, board sessions, and scheduled sidecars.
 *
 * @module lib/operational/diagnostics
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { EventLedger } = require('../ledger/ledger');
const { replayLedger } = require('../ledger/reducer');
const { isPidAlive } = require('../ledger/lock');

/**
 * Lightweight probe for Chrome DevTools HTTP endpoint with 1000ms timeout.
 * @param {string} [host='127.0.0.1']
 * @param {number} [port=9222]
 * @returns {Promise<{online: boolean, version?: string, error?: string}>}
 */
function probeChromeDevTools(host = '127.0.0.1', port = 9222) {
  return new Promise(resolve => {
    const req = http.get({
      host,
      port,
      path: '/json/version',
      timeout: 1000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ online: true, version: parsed.Browser || 'Chrome DevTools' });
        } catch (_) {
          resolve({ online: true, version: 'HTTP 200 (Active)' });
        }
      });
    });

    req.on('error', err => {
      resolve({ online: false, error: err.code || err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ online: false, error: 'TIMEOUT (1000ms)' });
    });
  });
}

/**
 * Redacts any sensitive credential tokens from session status messages.
 */
function maskSessionCredentials(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/(?:bearer\s+|token[=:]\s*|cookie[=:]\s*)[A-Za-z0-9_\-.~+/]+=*/gi, '[REDACTED]')
    .replace(/[a-f0-9]{32,64}/gi, '[HASH_REDACTED]');
}

/**
 * Executes the complete 6-probe diagnostic inspection.
 * @param {Object} options
 * @param {string} [options.workspace] Target workspace path
 * @param {boolean} [options.fix=false] Apply automatic self-healing repairs
 * @returns {Promise<{results: Array, pass: boolean, hasCriticalFailure: boolean}>}
 */
async function runDiagnostics(options = {}) {
  const workspace = path.resolve(options.workspace || process.cwd());
  const shouldFix = Boolean(options.fix);
  const results = [];

  const crewDir = path.join(workspace, '.crew');
  const denylistPath = path.join(workspace, '.pii-denylist');
  const denylistExample = path.join(workspace, '.pii-denylist.example');
  const ledgerPath = path.join(crewDir, 'ledger.jsonl');
  const snapshotPath = path.join(crewDir, 'snapshot.json');
  const lockFile = path.join(crewDir, 'ledger.lock');

  // ==========================================================================
  // PROBE 1: Runtime & Workspace Structure
  // ==========================================================================
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  const nodePass = !isNaN(nodeMajor) && nodeMajor >= 18;
  results.push({
    name: 'Node runtime',
    probeId: 'RUNTIME_NODE_VERSION',
    critical: true,
    pass: nodePass,
    message: `${process.version} (${nodePass ? 'PASS' : 'FAIL: Node.js >= 18 required'})`
  });

  let hasCrewDir = fs.existsSync(crewDir);
  if (!hasCrewDir && shouldFix) {
    fs.mkdirSync(crewDir, { recursive: true });
    hasCrewDir = true;
  }
  results.push({
    name: 'Runtime directory (.crew)',
    probeId: 'WORKSPACE_CREW_DIR',
    critical: true,
    pass: hasCrewDir,
    message: hasCrewDir ? 'FOUND' : 'NOT INITIALIZED (run crew init)'
  });

  let hasDenylist = fs.existsSync(denylistPath);
  if (!hasDenylist && shouldFix) {
    if (fs.existsSync(denylistExample)) {
      fs.copyFileSync(denylistExample, denylistPath);
    } else {
      fs.writeFileSync(denylistPath, '# Local gitignored PII denylist\n', 'utf8');
    }
    hasDenylist = true;
  }
  results.push({
    name: 'PII Protection (.pii-denylist)',
    probeId: 'WORKSPACE_PII_DENYLIST',
    critical: true,
    pass: hasDenylist,
    message: hasDenylist ? 'CONFIGURED' : 'UNCONFIGURED (run crew init)'
  });

  // Dossier validation (Optional/Warning if uninitialized; verified if present)
  const dossierPath = path.join(workspace, 'dossier.json');
  const careerDossierPath = path.join(workspace, 'CareerDossier.md');
  let dossierPass = true;
  let dossierMsg = 'NOT INITIALIZED (optional)';
  if (fs.existsSync(dossierPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(dossierPath, 'utf8'));
      if (data && typeof data === 'object') {
        const claimCount = Array.isArray(data.claims) ? data.claims.length : (data.claimCount || 0);
        dossierMsg = `VALID (dossier.json loaded, ${claimCount} claims)`;
      } else {
        dossierPass = false;
        dossierMsg = 'INVALID FORMAT (must be a JSON object)';
      }
    } catch (err) {
      dossierPass = false;
      dossierMsg = `SYNTAX_ERROR: ${err.message}`;
    }
  } else if (fs.existsSync(careerDossierPath)) {
    dossierMsg = 'VALID (CareerDossier.md loaded)';
  }
  results.push({
    name: 'Candidate Dossier',
    probeId: 'WORKSPACE_DOSSIER',
    critical: false,
    pass: dossierPass,
    message: dossierMsg
  });

  // Snapshot Sync Check
  let snapshotPass = true;
  let snapshotMsg = 'IN SYNC';
  if (fs.existsSync(snapshotPath) && fs.existsSync(ledgerPath)) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      const ledger = new EventLedger({ ledgerPath });
      const events = ledger.readEvents();
      const count = events.length;
      const lastId = snapshot.lastEventId || 0;
      if (lastId !== count) {
        if (shouldFix) {
          replayLedger({ workspaceDir: workspace, rebuild: true });
          snapshotMsg = `REBUILT & SYNCHRONIZED (${count} events)`;
        } else {
          snapshotPass = false;
          snapshotMsg = `DESYNCHRONIZED (snapshot has ${lastId}, ledger has ${count}; run crew doctor --fix)`;
        }
      } else {
        snapshotMsg = `SYNCHRONIZED (${count} events)`;
      }
    } catch (e) {
      if (shouldFix) {
        try {
          replayLedger({ workspaceDir: workspace, rebuild: true });
          snapshotMsg = 'REBUILT SNAPSHOT FROM LEDGER';
        } catch (err) {
          snapshotPass = false;
          snapshotMsg = `CORRUPT: ${err.message}`;
        }
      } else {
        snapshotPass = false;
        snapshotMsg = `CORRUPT SNAPSHOT (run crew doctor --fix)`;
      }
    }
  } else if (!fs.existsSync(snapshotPath) && fs.existsSync(ledgerPath)) {
    if (shouldFix) {
      replayLedger({ workspaceDir: workspace, rebuild: true });
      snapshotMsg = 'REBUILT SNAPSHOT';
    } else {
      snapshotPass = false;
      snapshotMsg = 'MISSING SNAPSHOT (run crew doctor --fix)';
    }
  }
  results.push({
    name: 'State Snapshot',
    probeId: 'WORKSPACE_SNAPSHOT_SYNC',
    critical: false,
    pass: snapshotPass,
    message: snapshotMsg
  });

  // ==========================================================================
  // PROBE 2: Cryptographic Ledger Monotonicity
  // ==========================================================================
  let ledgerPass = true;
  let ledgerMsg = 'CLEAN';
  let ledgerCritical = false;

  if (fs.existsSync(ledgerPath)) {
    const ledger = new EventLedger({ ledgerPath });
    const integrity = ledger.verifyChainIntegrity();
    if (!integrity.valid) {
      ledgerPass = false;
      ledgerCritical = true;
      ledgerMsg = `CORRUPTED: ${integrity.reason}`;
    } else {
      ledgerMsg = `VALID (${integrity.count} events verified)`;
    }
  } else {
    ledgerMsg = 'NOT INITIALIZED (run crew init)';
  }

  results.push({
    name: 'Ledger integrity',
    probeId: 'LEDGER_HASH_CHAIN',
    critical: ledgerCritical,
    pass: ledgerPass,
    message: ledgerMsg
  });

  // ==========================================================================
  // PROBE 3: Lockfile Hygiene & Process Liveness
  // ==========================================================================
  let isLocked = fs.existsSync(lockFile);
  let lockMsg = 'CLEAN (unlocked)';
  let lockPass = true;

  if (isLocked) {
    let stale = false;
    try {
      const stats = fs.statSync(lockFile);
      const rawContent = fs.readFileSync(lockFile, 'utf8').trim();
      let lockData = null;
      try {
        lockData = JSON.parse(rawContent);
      } catch (_) {}

      if (!lockData || typeof lockData !== 'object') {
        // Unparseable lock older than 5000ms is stale
        if (Date.now() - stats.mtimeMs > 5000) {
          stale = true;
        }
      } else {
        const isLocalHost = !lockData.hostname || lockData.hostname === os.hostname();
        const pidAlive = typeof lockData.pid === 'number' && isLocalHost ? isPidAlive(lockData.pid) : true;
        const now = Date.now();
        const expiresAt = lockData.expiresAt ? new Date(lockData.expiresAt).getTime() : 0;
        const leaseExpired = expiresAt ? now > expiresAt : (now - stats.mtimeMs > 5000);

        if (!pidAlive) {
          stale = true;
        } else if (leaseExpired) {
          stale = true;
        }
      }

      if (stale) {
        if (shouldFix) {
          fs.unlinkSync(lockFile);
          lockMsg = 'STALE LOCK REMOVED (fixed)';
          isLocked = false;
          lockPass = true;
        } else {
          lockMsg = 'STALE LOCK DETECTED (run crew doctor --fix)';
          lockPass = false;
        }
      } else {
        lockMsg = 'ACTIVE LOCK (in progress)';
        lockPass = true;
      }
    } catch (_) {
      lockPass = true;
    }
  }

  results.push({
    name: 'Concurrency lock',
    probeId: 'CONCURRENCY_LOCK',
    critical: false,
    pass: lockPass,
    message: lockMsg
  });

  // ==========================================================================
  // PROBE 4: Connectors (Chrome DevTools & Local Companion Bridge)
  // ==========================================================================
  const devToolsProbe = await probeChromeDevTools();
  results.push({
    name: 'Chrome DevTools MCP',
    probeId: 'CONNECTOR_DEVTOOLS_MCP',
    critical: false,
    pass: true, // Non-critical fallback
    message: devToolsProbe.online
      ? `ONLINE (${devToolsProbe.version})`
      : `OFFLINE (Local fallback mode active; ${devToolsProbe.error || 'not reachable'})`
  });

  const proposalsDir = path.join(workspace, 'inbox', 'proposals');
  const hasBridge = fs.existsSync(proposalsDir);
  results.push({
    name: 'Companion File Bridge',
    probeId: 'CONNECTOR_FILE_BRIDGE',
    critical: false,
    pass: true,
    message: hasBridge ? 'ONLINE (inbox/proposals active)' : 'UNCONFIGURED (Desktop companion offline)'
  });

  // ==========================================================================
  // PROBE 5: Authenticated Board Sessions (Strict Zero-Leak Masking)
  // ==========================================================================
  const sessionsPath = path.join(crewDir, 'sessions.json');
  let sessionsInfo = 'UNCHECKED (No cached session status)';
  let sessionsPass = true;

  if (fs.existsSync(sessionsPath)) {
    try {
      const sessData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      const boards = Object.keys(sessData);
      const statuses = boards.map(b => {
        const item = sessData[b];
        const status = item && item.status ? item.status : 'UNKNOWN';
        return `${b}: ${status}`;
      });
      sessionsInfo = maskSessionCredentials(statuses.join(', '));
    } catch (_) {
      sessionsInfo = 'CORRUPTED_CACHE';
    }
  }

  results.push({
    name: 'Board Session Health',
    probeId: 'BOARD_SESSIONS',
    critical: false,
    pass: sessionsPass,
    message: sessionsInfo
  });

  // ==========================================================================
  // PROBE 6: Schedule Definitions & Sidecar Integrity
  // ==========================================================================
  const sidecarPath = path.join(workspace, 'sidecar.json');
  const tasksDir = path.join(crewDir, 'tasks');
  let schedulePass = true;
  let scheduleMsg = 'NOT CONFIGURED (Optional background tasks)';

  if (fs.existsSync(sidecarPath)) {
    try {
      const raw = fs.readFileSync(sidecarPath, 'utf8');
      const sidecar = JSON.parse(raw);
      if (Array.isArray(sidecar)) {
        for (const task of sidecar) {
          if (task.cron) {
            const cronClean = task.cron.replace(/^CRON_TZ=\S+\s+/, '');
            const parts = cronClean.trim().split(/\s+/);
            if (parts.length !== 5) {
              schedulePass = false;
              scheduleMsg = `CRON_SYNTAX_ERROR: Invalid 5-field cron '${task.cron}'`;
              break;
            }
          }
        }
        if (schedulePass) {
          scheduleMsg = `VALID (${sidecar.length} tasks scheduled)`;
        }
      } else if (sidecar && typeof sidecar === 'object') {
        const cron = sidecar.cron || '';
        const cronClean = cron.replace(/^CRON_TZ=\S+\s+/, '');
        const parts = cronClean.trim().split(/\s+/);
        if (parts.length !== 5 && cron !== '') {
          schedulePass = false;
          scheduleMsg = `CRON_SYNTAX_ERROR: Invalid cron '${cron}'`;
        } else {
          scheduleMsg = 'VALID (Single sidecar task)';
        }
      }
    } catch (err) {
      schedulePass = false;
      scheduleMsg = `JSON_ERROR: ${err.message}`;
    }
  } else if (fs.existsSync(tasksDir)) {
    scheduleMsg = 'CONFIGURED (.crew/tasks sidecars active)';
  }

  results.push({
    name: 'Scheduled Sidecars',
    probeId: 'SCHEDULE_SIDECARS',
    critical: false,
    pass: schedulePass,
    message: scheduleMsg
  });

  const hasCriticalFailure = results.some(r => r.critical && !r.pass);
  const overallPass = !hasCriticalFailure && (ledgerPass);

  return {
    results,
    pass: overallPass,
    hasCriticalFailure
  };
}

module.exports = {
  runDiagnostics,
  probeChromeDevTools,
  maskSessionCredentials
};
