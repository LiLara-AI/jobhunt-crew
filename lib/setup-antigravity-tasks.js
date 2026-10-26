#!/usr/bin/env node
'use strict';

/**
 * JobHunt Crew — Antigravity Scheduled Tasks Sidecar Generator
 *
 * Generates and installs scheduled background task configurations (sidecar.json)
 * for the 7 JobHunt Crew agents:
 * - Dispatcher: Daily at Hour H:00 (default: 08:00 AM)
 * - Recon: Daily at Hour H:30 (default: 08:30 AM)
 * - Scribe: Daily at Hour H+1:15 (default: 09:15 AM)
 * - Inquisitor: Daily at Hour H+1:45 (default: 09:45 AM)
 * - Critic: Daily at Hour H+2:00 (default: 10:00 AM)
 * - Liaison: Daily at Hour H+2:15 (default: 10:15 AM)
 * - Navigator: Weekly Saturday at Hour H+2:30 (default: 10:30 AM)
 *
 * Conforms strictly to Antigravity automation spec:
 * - "builtin": "schedule"
 * - "cron": "CRON_TZ=<timezone> <cron_expr>"
 * - "command": ["agentapi", "new-conversation", "--", "<prompt>"]
 * - "restart_policy": "always"
 * - "display_name": "JobHunt Crew - <AgentName>"
 * - "agent_permissions": { "workspace_uris": ["file:///<path>"], "access_grants": [...] }
 *
 * Zero external dependencies. Uses Node.js standard runtime.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Normalizes filesystem path to RFC 3986 file:/// URI.
 * Handles Windows drive letters, backslashes, and URI component encoding for spaces.
 */
function toWorkspaceUri(dirPath) {
  let raw = String(dirPath || process.cwd()).replace(/\\/g, '/');
  let resolved = raw.startsWith('/') ? raw : path.resolve(raw).replace(/\\/g, '/');
  while (resolved.length > 1 && resolved.endsWith('/')) {
    resolved = resolved.slice(0, -1);
  }
  if (/^[A-Za-z]:\//.test(resolved)) {
    resolved = '/' + resolved;
  } else if (!resolved.startsWith('/')) {
    resolved = '/' + resolved;
  }
  const segments = resolved.split('/').map(seg => {
    if (!seg || /^[A-Za-z]:$/.test(seg)) return seg;
    return encodeURIComponent(seg);
  });
  return 'file://' + segments.join('/');
}

/**
 * Generates sidecar configurations for all 7 JobHunt Crew agents.
 */
function generateSidecarConfigs(options = {}) {
  const workspace = options.workspace || process.cwd();
  const timezone = options.timezone || 'Asia/Riyadh';
  const startHour = (typeof options.hour === 'number' && Number.isInteger(options.hour) && options.hour >= 0 && options.hour <= 23)
    ? options.hour
    : 8;
  const wsUri = toWorkspaceUri(workspace);

  const h0 = startHour;
  const h1 = (startHour + 1) % 24;
  const h2 = (startHour + 2) % 24;

  return {
    'jobhunt-crew-dispatcher': {
      builtin: 'schedule',
      cron: `CRON_TZ=${timezone} 0 ${h0} * * *`,
      command: [
        'agentapi',
        'new-conversation',
        '--',
        `You are Dispatcher (dispatcher). Inspect .crew/snapshot.json and .crew/ledger.jsonl in workspace ${wsUri}. Evaluate pending workloads and wake only agents with active work. Synthesize daily briefing in briefing.md.`
      ],
      restart_policy: 'always',
      display_name: 'JobHunt Crew - Dispatcher',
      description: `Daily at ${h0}:00 AM (${timezone}), inspects .crew ledger/snapshot work state and wakes pending crew agents.`,
      agent_permissions: {
        workspace_uris: [wsUri],
        access_grants: ['command(node bin/crew.js)']
      }
    },
    'jobhunt-crew-recon': {
      builtin: 'schedule',
      cron: `CRON_TZ=${timezone} 30 ${h0} * * *`,
      command: [
        'agentapi',
        'new-conversation',
        '--',
        `You are Recon (recon). Inspect .crew/snapshot.json in workspace ${wsUri}. If untriaged vacancies exist (status: discovered), execute 4-channel discovery and 5-dimension rubric triage, recording JOB_TRIAGED events.`
      ],
      restart_policy: 'always',
      display_name: 'JobHunt Crew - Recon',
      description: `Daily at ${h0}:30 AM (${timezone}), executes 4-channel job discovery and rubric triage without age penalties.`,
      agent_permissions: {
        workspace_uris: [wsUri],
        access_grants: ['command(node bin/crew.js)']
      }
    },
    'jobhunt-crew-scribe': {
      builtin: 'schedule',
      cron: `CRON_TZ=${timezone} 15 ${h1} * * *`,
      command: [
        'agentapi',
        'new-conversation',
        '--',
        `You are Scribe (scribe). Inspect .crew/snapshot.json in workspace ${wsUri}. For vacancies marked selected, tailor honest CVs, cover letters, and Stage 7 Apply Packs anchoring strictly in verified claims [CLM-xxx].`
      ],
      restart_policy: 'always',
      display_name: 'JobHunt Crew - Scribe',
      description: `Daily at ${h1}:15 AM (${timezone}), tailors honest CVs, cover letters, and attended browser pre-fill packages.`,
      agent_permissions: {
        workspace_uris: [wsUri],
        access_grants: ['command(node bin/crew.js)']
      }
    },
    'jobhunt-crew-inquisitor': {
      builtin: 'schedule',
      cron: `CRON_TZ=${timezone} 45 ${h1} * * *`,
      command: [
        'agentapi',
        'new-conversation',
        '--',
        `You are Inquisitor (inquisitor). Inspect .crew/snapshot.json in workspace ${wsUri}. For drafted applications, execute deterministic AST verifier (node lib/honest-cv/verify-claims.js) and enforce [CONFIRM] gating.`
      ],
      restart_policy: 'always',
      display_name: 'JobHunt Crew - Inquisitor',
      description: `Daily at ${h1}:45 AM (${timezone}), verifies draft claims against candidate dossier with zero tolerance for fabrication.`,
      agent_permissions: {
        workspace_uris: [wsUri],
        access_grants: ['command(node bin/crew.js)', 'command(node lib/honest-cv/verify-claims.js)']
      }
    },
    'jobhunt-crew-critic': {
      builtin: 'schedule',
      cron: `CRON_TZ=${timezone} 0 ${h2} * * *`,
      command: [
        'agentapi',
        'new-conversation',
        '--',
        `You are Critic (critic). Inspect .crew/snapshot.json in workspace ${wsUri}. For verified drafts, conduct candidate-isolated blind review panel from Recruiter and Hiring Manager perspectives.`
      ],
      restart_policy: 'always',
      display_name: 'JobHunt Crew - Critic',
      description: `Daily at ${h2}:00 AM (${timezone}), conducts candidate-isolated blind review panel in Standard and Fast Lane modes.`,
      agent_permissions: {
        workspace_uris: [wsUri],
        access_grants: ['command(node bin/crew.js)']
      }
    },
    'jobhunt-crew-liaison': {
      builtin: 'schedule',
      cron: `CRON_TZ=${timezone} 15 ${h2} * * *`,
      command: [
        'agentapi',
        'new-conversation',
        '--',
        `You are Liaison (liaison). Inspect .crew/snapshot.json in workspace ${wsUri}. Check 7d/14d follow-up cadences, draft <=300-char networking outreach notes, and triage cold-offer scams.`
      ],
      restart_policy: 'always',
      display_name: 'JobHunt Crew - Liaison',
      description: `Daily at ${h2}:15 AM (${timezone}), manages 7d/14d follow-up cadences, outreach drafting, and scam detection.`,
      agent_permissions: {
        workspace_uris: [wsUri],
        access_grants: ['command(node bin/crew.js)']
      }
    },
    'jobhunt-crew-navigator': {
      builtin: 'schedule',
      cron: `CRON_TZ=${timezone} 30 ${h2} * * 6`,
      command: [
        'agentapi',
        'new-conversation',
        '--',
        `You are Navigator (navigator). Inspect .crew/snapshot.json in workspace ${wsUri}. Check authenticated job-board browser sessions in Chrome, stage ready-to-save profile improvements, and update new-boards.md.`
      ],
      restart_policy: 'always',
      display_name: 'JobHunt Crew - Navigator',
      description: `Weekly Saturdays at ${h2}:30 AM (${timezone}), checks browser sessions and stages ready-to-save profile syncs.`,
      agent_permissions: {
        workspace_uris: [wsUri],
        access_grants: ['command(node bin/crew.js)']
      }
    }
  };
}

/**
 * Installs sidecar.json files into workspace .crew/tasks/ folder.
 */
function installSidecars(configs, options = {}) {
  const workspace = options.workspace || process.cwd();
  const tasksDir = path.join(workspace, '.crew', 'tasks');
  const installedPaths = [];

  for (const [agentId, config] of Object.entries(configs)) {
    const agentDir = path.join(tasksDir, agentId);
    if (!fs.existsSync(agentDir)) {
      fs.mkdirSync(agentDir, { recursive: true });
    }
    const sidecarPath = path.join(agentDir, 'sidecar.json');
    fs.writeFileSync(sidecarPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    installedPaths.push(sidecarPath);
  }

  return installedPaths;
}

/**
 * Self-test routine validating schema, options, and URI generation.
 */
function runSelfTest() {
  console.log('[SELF-TEST] Running setup-antigravity-tasks verification...');

  // Test 1: URI normalization
  const uri = toWorkspaceUri('c:\\Users\\aelkh\\AI Projects\\job hunt\\jobhunt-crew');
  if (!uri.startsWith('file:///') || !uri.includes('AI%20Projects') || !uri.includes('job%20hunt')) {
    throw new Error(`[SELF-TEST] Failed URI normalization: ${uri}`);
  }
  console.log('  ✓ URI normalization handles Windows spaces correctly');

  // Test 2: Configuration count and keys
  const configs = generateSidecarConfigs({ hour: 9, timezone: 'Asia/Riyadh' });
  const keys = Object.keys(configs);
  if (keys.length !== 7) {
    throw new Error(`[SELF-TEST] Expected 7 sidecar configurations, got ${keys.length}`);
  }
  console.log('  ✓ Generated exactly 7 agent sidecar configurations');

  // Test 3: Schema validation for each configuration
  for (const [id, cfg] of Object.entries(configs)) {
    if (cfg.builtin !== 'schedule') throw new Error(`${id}: Missing builtin: schedule`);
    if (!cfg.cron || !cfg.cron.startsWith('CRON_TZ=Asia/Riyadh')) throw new Error(`${id}: Invalid cron format`);
    if (!Array.isArray(cfg.command) || cfg.command[0] !== 'agentapi') throw new Error(`${id}: Invalid command format`);
    if (cfg.restart_policy !== 'always') throw new Error(`${id}: Invalid restart policy`);
    if (!cfg.display_name) throw new Error(`${id}: Missing display_name`);
    if (!cfg.agent_permissions || !Array.isArray(cfg.agent_permissions.workspace_uris)) {
      throw new Error(`${id}: Missing agent_permissions.workspace_uris`);
    }
  }
  console.log('  ✓ All 7 configurations strictly comply with Antigravity Scheduled Tasks schema');

  console.log('[SELF-TEST] 100% PASSED');
  return true;
}

// CLI Entrypoint
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    try {
      runSelfTest();
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  // Parse arguments
  let ws = process.cwd();
  let tz = 'Asia/Riyadh';
  let hr = 8;
  let doInstall = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && i + 1 < args.length) ws = args[++i];
    if (args[i] === '--timezone' && i + 1 < args.length) tz = args[++i];
    if (args[i] === '--hour' && i + 1 < args.length) hr = parseInt(args[++i], 10);
    if (args[i] === '--install-sidecars') doInstall = true;
  }

  const configs = generateSidecarConfigs({ workspace: ws, timezone: tz, hour: hr });
  if (doInstall) {
    const installed = installSidecars(configs, { workspace: ws });
    console.log(`[TASKS] Successfully installed ${installed.length} sidecar configurations in .crew/tasks/`);
  } else {
    console.log(JSON.stringify(configs, null, 2));
  }
}

module.exports = {
  toWorkspaceUri,
  generateSidecarConfigs,
  installSidecars,
  runSelfTest
};
