'use strict';

/**
 * JobHunt Crew — CLI Operational Commands (init, doctor, alerts, retro, ui, export, mcp)
 * @module lib/cli/commands/ops
 */

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const { EventLedger } = require('../../ledger/ledger');
const { runDiagnostics } = require('../../operational/diagnostics');
const { scanClosingSoonAlerts } = require('../../operational/alerts');
const { generateRetrospective } = require('../../operational/retrospective');
const { CommandCenterServer } = require('../../command-center/server');
const { exportDashboard } = require('../../command-center/exporter');
const { VERSION, parseArgs, resolveWorkspace } = require('../shared');

function runInit(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const crewDir = path.join(targetDir, '.crew');

  if (!fs.existsSync(crewDir)) {
    fs.mkdirSync(crewDir, { recursive: true });
    console.log(`[INIT] Created runtime directory: ${crewDir}`);
  } else {
    console.log(`[INIT] Runtime directory already exists: ${crewDir}`);
  }

  const ledgerPath = path.join(crewDir, 'ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) {
    fs.writeFileSync(ledgerPath, '', 'utf8');
    console.log(`[INIT] Initialized append-only event ledger: ${ledgerPath}`);
  }

  const snapshotPath = path.join(crewDir, 'snapshot.json');
  if (!fs.existsSync(snapshotPath)) {
    const initialSnapshot = {
      version: 1,
      lastEventId: 0,
      updatedAt: new Date().toISOString(),
      jobs: {},
      applications: {},
      outreach: {},
      health: {},
      decisions: []
    };
    fs.writeFileSync(snapshotPath, JSON.stringify(initialSnapshot, null, 2), 'utf8');
    console.log(`[INIT] Initialized materialized state snapshot: ${snapshotPath}`);
  }

  const denylistPath = path.join(targetDir, '.pii-denylist');
  if (!fs.existsSync(denylistPath)) {
    const examplePath = path.join(targetDir, '.pii-denylist.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, denylistPath);
    } else {
      fs.writeFileSync(denylistPath, '# Local gitignored PII denylist for JobHunt Crew\n', 'utf8');
    }
    console.log(`[INIT] Initialized local PII protection denylist: ${denylistPath}`);
  }

  console.log('[INIT] Workspace initialization complete.');
  return 0;
}

async function runDoctor(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const shouldFix = flags.fix === true;

  console.log(`[DOCTOR] Inspecting JobHunt Crew health in: ${targetDir}`);
  const diag = await runDiagnostics({ workspace: targetDir, fix: shouldFix });

  if (flags.json) {
    console.log(JSON.stringify(diag, null, 2));
    return diag.pass ? 0 : 1;
  }

  for (const r of diag.results) {
    console.log(`  - ${r.name}: ${r.message}`);
  }

  if (diag.hasCriticalFailure || !diag.pass) {
    console.error(`[DOCTOR] System health check FAILED. Critical requirements missing.`);
    return 1;
  }

  console.log(`[DOCTOR] System health check PASSED.`);
  return 0;
}

async function runAlerts(subcommand, rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const snapshotPath = path.join(targetDir, '.crew', 'snapshot.json');

  if (!fs.existsSync(snapshotPath)) {
    console.error(`[ALERTS] Snapshot not found at ${snapshotPath}. Run crew init or discover.`);
    return 1;
  }

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const windowHours = flags.window ? parseInt(flags.window, 10) : 48;

  if (subcommand === 'closing-soon') {
    const alerts = scanClosingSoonAlerts(snapshot, windowHours);
    if (flags.json) {
      console.log(JSON.stringify(alerts, null, 2));
      return 0;
    }
    console.log(`[ALERTS] Closing-Soon Vacancies (within ${windowHours}h):`);
    if (alerts.length === 0) {
      console.log('  No open vacancies approaching application deadlines.');
    } else {
      for (const a of alerts) {
        console.log(`  [${a.urgency}] ${a.title} @ ${a.company} — ${a.remainingHours}h remaining (Deadline: ${a.deadline})`);
      }
    }
    return 0;
  }

  console.error(`[ALERTS] Unknown alerts subcommand: ${subcommand}`);
  return 1;
}

async function runRetro(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const ledgerPath = path.join(targetDir, '.crew', 'ledger.jsonl');

  if (!fs.existsSync(ledgerPath)) {
    console.error(`[RETRO] Ledger not found at ${ledgerPath}.`);
    return 1;
  }

  const ledger = new EventLedger({ ledgerPath });
  const days = flags.days ? parseInt(flags.days, 10) : 7;
  const retro = generateRetrospective(ledger, { days });

  if (flags.json) {
    console.log(JSON.stringify(retro, null, 2));
  } else {
    console.log(`[RETRO] Weekly Retrospective (${days} days):`);
    console.log(`  Discovered : ${retro.funnel.discovered}`);
    console.log(`  Triaged    : ${retro.funnel.triaged} (Passed: ${retro.funnel.passed}, Marginal: ${retro.funnel.marginal}, Failed: ${retro.funnel.failed})`);
    console.log(`  Pass Rate  : ${retro.funnel.passRatePercent}%`);
    console.log(`  Submitted  : ${retro.funnel.submitted}`);
    if (retro.proposals.length > 0) {
      console.log('  Proposals:');
      for (const p of retro.proposals) {
        console.log(`    - [${p.type}] ${p.suggestion}`);
      }
    }
  }

  if (flags.out) {
    const outFile = path.resolve(flags.out);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(retro, null, 2) + '\n', 'utf8');
    console.log(`[RETRO] Report written to: ${outFile}`);
  }

  return 0;
}

function runMcp(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const mcpServerModule = path.join(__dirname, '..', '..', 'mcp', 'server.js');

  if (fs.existsSync(mcpServerModule)) {
    const { McpServer } = require(mcpServerModule);
    const server = new McpServer({ workspace: targetDir });
    server.start();
  } else {
    console.error(`[ERROR] MCP server module not found at: ${mcpServerModule}`);
    process.exit(1);
  }
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      child_process.spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    } else if (platform === 'darwin') {
      child_process.spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child_process.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
  } catch (err) {
    console.warn(`[WARNING] Could not open default browser: ${err.message}`);
  }
}

async function runUi(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const workspace = resolveWorkspace(flags);
  const port = flags.port ? parseInt(flags.port, 10) : 8080;
  const token = flags.token || undefined;
  const noOpen = Boolean(flags['no-open']);

  const server = new CommandCenterServer({
    workspaceDir: workspace,
    port,
    token
  });

  try {
    const info = await server.start();

    console.log(`
================================================================================
  JobHunt Crew — Command Center (v${VERSION})
  Local Web UI & REST Decision Server
================================================================================

  Status:         ONLINE
  Loopback URL:   http://127.0.0.1:${info.port}/
  Auth Access:    ${info.url}
  Workspace:      ${workspace}
  Session Token:  ${info.token}

  Security Invariants:
    [x] Bound exclusively to 127.0.0.1 (Loopback only)
    [x] Session Token verified on all endpoints
    [x] Human-Only Application Submission Guard active
    [x] Zero remote web asset dependencies

  Press Ctrl+C to terminate server gracefully.
================================================================================
`);

    if (!noOpen) {
      console.log('[INFO] Launching default web browser...');
      openBrowser(info.url);
    }

    const shutdown = async () => {
      console.log('\n[INFO] Shutting down Command Center server...');
      await server.stop();
      console.log('[INFO] Command Center stopped. Goodbye.');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return new Promise(() => {});
  } catch (err) {
    console.error(`[ERROR] Failed to start Command Center: ${err.message}`);
    return 1;
  }
}

async function runExport(rawArgs = []) {
  const { flags } = parseArgs(rawArgs);
  const workspace = resolveWorkspace(flags);
  const outFile = flags.out || path.join(workspace, 'dist', 'command-center-export.html');
  const jsonMode = Boolean(flags.json);

  try {
    const result = await exportDashboard({
      workspace,
      outFile
    });

    if (jsonMode) {
      console.log(JSON.stringify({
        status: 'ok',
        outFile: result.outFile,
        sizeBytes: result.sizeBytes,
        exportedAt: result.exportedAt,
        lastEventId: result.lastEventId,
        jobCount: result.jobCount
      }, null, 2));
    } else {
      console.log(`
================================================================================
  JobHunt Crew — Standalone Offline Dashboard Export (v${VERSION})
================================================================================

  Export File:    ${result.outFile}
  File Size:      ${(result.sizeBytes / 1024).toFixed(1)} KB
  Last Event ID:  #${result.lastEventId}
  Total Jobs:     ${result.jobCount}
  Exported At:    ${result.exportedAt}

  Zero Remote Dependencies:
    [x] 100% Inlined CSS & Vanilla Client JS
    [x] Zero External CDNs, Google Fonts, or Tracking Pixels
    [x] Portable single-file opens directly in any desktop browser (file:///)
================================================================================
`);
    }
    return 0;
  } catch (err) {
    if (jsonMode) {
      console.log(JSON.stringify({ status: 'error', message: err.message }));
    } else {
      console.error(`[ERROR] Failed to export dashboard: ${err.message}`);
    }
    return 1;
  }
}

module.exports = {
  runInit,
  runDoctor,
  runAlerts,
  runRetro,
  runMcp,
  openBrowser,
  runUi,
  runExport
};
