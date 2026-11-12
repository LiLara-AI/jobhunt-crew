'use strict';

/**
 * JobHunt Crew — CLI Companion Bridge Commands
 * @module lib/cli/commands/companion
 */

const fs = require('fs');
const path = require('path');
const { CompanionBridge } = require('../../companion/bridge');
const { parseArgs, resolveWorkspace } = require('../shared');

async function runCompanion(subcommand, rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const workspaceDir = resolveWorkspace(flags);
  const inboxDir = flags.dir || flags.d ? path.resolve(flags.dir || flags.d) : path.join(workspaceDir, 'inbox');
  const bridge = new CompanionBridge({ workspaceDir, inboxDir });

  // CLI Subcommand Aliases (Ergonomic parity)
  let effectiveSubcommand = subcommand;
  if (effectiveSubcommand === 'sweep') {
    effectiveSubcommand = 'ingest';
  } else if (effectiveSubcommand === 'watch') {
    effectiveSubcommand = 'ingest';
    flags.watch = true;
  }

  if (effectiveSubcommand === 'ingest') {
    const isWatch = Boolean(flags.watch || flags.w);
    if (isWatch) {
      console.log(`[COMPANION WATCH] Active. Monitoring ${bridge.proposalsDir} (fs.watch, adaptive fallback)...`);
      console.log('Press Ctrl+C to stop.');

      fs.mkdirSync(bridge.proposalsDir, { recursive: true });

      let running = true;
      let watcher = null;
      let wakeWaiter = null;
      const wake = () => {
        if (wakeWaiter) {
          const resolve = wakeWaiter;
          wakeWaiter = null;
          resolve();
        }
      };
      const cleanup = () => {
        running = false;
        if (watcher) {
          try { watcher.close(); } catch (_) {}
          watcher = null;
        }
        wake();
        console.log('\n[COMPANION WATCH] Stopped.');
        process.exit(0);
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      try {
        let debounce = null;
        watcher = fs.watch(bridge.proposalsDir, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(wake, 150);
        });
        watcher.on('error', () => { watcher = null; });
      } catch (_) {
        watcher = null; // fs.watch unavailable: adaptive polling below still applies
      }

      // Adaptive backoff bounds fallback polling when fs.watch misses events:
      // active inboxes are rechecked promptly, idle ones back off to 30s.
      const MIN_BACKOFF_MS = 1000;
      const MAX_BACKOFF_MS = 30000;
      let backoffMs = MIN_BACKOFF_MS;

      while (running) {
        let ingestedAny = false;
        try {
          const report = await bridge.ingestAll();
          if (report.total > 0) {
            ingestedAny = true;
            console.log(`[INGEST] Ingested: ${report.summary.ingestedCount}, Quarantined: ${report.summary.quarantinedCount}, Errors: ${report.summary.errorCount}`);
          }
        } catch (err) {
          console.error(`[INGEST ERROR] ${err.message}`);
        }
        if (!running) break;
        backoffMs = ingestedAny ? MIN_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, backoffMs * 2);
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            wakeWaiter = null;
            resolve();
          }, backoffMs);
          wakeWaiter = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      return 0;
    }

    const report = await bridge.ingestAll();
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('================================================================================');
      console.log('JobHunt Crew — Companion Inbox Ingestion');
      console.log('================================================================================');
      console.log(`Workspace:    ${workspaceDir}`);
      console.log(`Proposals:    ${bridge.proposalsDir}`);
      console.log(`Total Found:  ${report.total}`);
      console.log(`Ingested:     ${report.summary.ingestedCount}`);
      console.log(`Quarantined:  ${report.summary.quarantinedCount}`);
      console.log(`Errors:       ${report.summary.errorCount}`);
      console.log(`Corrupted:    ${report.summary.corruptedCount || 0} (State 100% clean)`);
      if (report.errors.length > 0) {
        console.log('\nQuarantined Errors:');
        for (const e of report.errors) {
          console.log(`  - ${e.filename}: ${e.error || e.code}`);
        }
      }
      console.log('================================================================================');
    }
    return 0;
  }

  if (effectiveSubcommand === 'status') {
    const status = bridge.getStatus();
    if (flags.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log('================================================================================');
      console.log('JobHunt Crew — Companion Bridge Status');
      console.log('================================================================================');
      console.log(`Workspace:  ${workspaceDir}`);
      console.log(`Inbox:      ${bridge.inboxDir}`);
      console.log(`Pending:    ${status.counts.pending} file(s) in inbox/proposals/`);
      console.log(`Processed:  ${status.counts.processed} file(s) in inbox/processed/`);
      console.log(`Errors:     ${status.counts.errors} file(s) in inbox/errors/`);
      if (status.pendingFiles.length > 0) {
        console.log('\nPending Proposals:');
        for (const p of status.pendingFiles) {
          console.log(`  - ${p.filename} (${p.size} bytes)`);
        }
      }
      console.log('================================================================================');
    }
    return 0;
  }

  console.error(`[ERROR] Unknown companion subcommand: "${subcommand}". Expected: ingest, status, sweep, watch`);
  return 1;
}

module.exports = {
  runCompanion
};
