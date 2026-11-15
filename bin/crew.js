#!/usr/bin/env node
'use strict';

/**
 * JobHunt Crew — Core CLI Entrypoint (thin dispatcher)
 *
 * Deterministic multi-agent job search and honest CV tailoring platform.
 * Command implementations live in lib/cli/commands/*; this file only owns
 * help text, dispatch, and the public handler re-exports.
 *
 * Zero external dependencies. Uses Node.js built-in runtime and core modules.
 */

const { VERSION, parseArgs, resolveWorkspace } = require('../lib/cli/shared');
const { runLedger } = require('../lib/cli/commands/ledger');
const { runJob } = require('../lib/cli/commands/job');
const { runDiscover } = require('../lib/cli/commands/discover');
const { runClaim } = require('../lib/cli/commands/claim');
const { runReview } = require('../lib/cli/commands/review');
const { runBackup, runRestore } = require('../lib/cli/commands/backup');
const { runEditorial } = require('../lib/cli/commands/editorial');
const { runMigrate } = require('../lib/cli/commands/migrate');
const { runApplyPack, runBlindReview, runOutreach, runInterviewStory, runKsaOffer, runCadence } = require('../lib/cli/commands/crew-ops');
const { runCompanion } = require('../lib/cli/commands/companion');
const { runContact } = require('../lib/cli/commands/contact');
const { runTool } = require('../lib/cli/commands/tool');
const { runInit, runDoctor, runAlerts, runRetro, runMcp, runUi, runExport } = require('../lib/cli/commands/ops');

function showHelp() {
  console.log(`JobHunt Crew CLI (v${VERSION})
Deterministic multi-agent job search and honest CV tailoring platform.

Usage:
  crew <command> [subcommand] [options]

Commands:
  init [--workspace <dir>]
      Initialize local .crew ledger workspace and .pii-denylist

  doctor [--fix] [--workspace <dir>]
      Inspect system health, locks, ledger integrity, and PII denylist

  ledger append --event <type> --payload <json> [--actor <actor>] [--workspace <dir>]
      Append typed domain event to the ledger under concurrency lock

  ledger replay [--rebuild] [--workspace <dir>]
      Replay events to verify cryptographic chain and rebuild snapshot

  discover sweep [--ats <name>] [--channel <name>] [--offline] [--limit <n>]
      Run multi-channel job discovery sweep across ATS and job boards

  discover smoke [--ats <name>] [--board <name>] [--all] [--offline] [--json]
      Execute live (or offline) schema smoke test on public ATS boards

  job add --url <u> --title <t> --company <c> --location <l> --source <s> [--workspace <dir>]
      Ingest discovered vacancy with canonical URL deduplication

  job triage [--all] [--id <i>] [--score <s>] [--status <st>] [--rationale <r>] [--workspace <dir>]
      Record multi-dimensional preference score and status verdict

  job inspect --id <id> [--json] [--workspace <dir>]
      Inspect detailed vacancy lifecycle, age invariant, and triage breakdown

  job close --id <i> --reason <r> --evidence <e> [--proof <p>] [--workspace <dir>]
      Close vacancy with mandatory verifiable evidence (age alone rejected)

  job submit --id <i> --token <t> [--actor <human>] [--workspace <dir>]
      Record human-authorized application submission (agents blocked)

  backup [--out <file>] [--workspace <dir>]
      Create consistent, timestamped JSON archive of .crew/

  restore --file <file> [--workspace <dir>]
      Restore ledger and snapshot from backup archive with integrity check

  alerts closing-soon [--window <hours>] [--json] [--workspace <dir>]
      List open vacancies whose deadlines fall inside the alert window

  retro [--days <n>] [--out <file>] [--json] [--workspace <dir>]
      Generate weekly funnel retrospective and scoring proposals

  editorial list [--active] [--category <c>] [--json] [--workspace <dir>]
      List learned editorial rules

  editorial learn --id <id> --pattern <text> [--replacement <text>] [--rationale <text>] [--workspace <dir>]
      Learn an editorial rule from a candidate correction

  editorial undo --id <id> [--workspace <dir>]
      Deactivate a learned editorial rule (history preserved)

  editorial apply --draft <path|text> [--dossier <path>] [--out <file>] [--workspace <dir>]
      Apply active editorial rules to draft text

  migrate legacy [--from <dir>] [--workspace <dir>]
      Migrate a legacy plugin workspace into the local .crew ledger

  apply-pack (--job-id <id> | --company <c> --title <t>) [--dossier <path>] [--json] [--workspace <dir>]
      Write a ready-to-submit apply pack (human still clicks Submit)

  blind-review --jd <path|text> --draft <path|text> [--dossier <path>] [--job-id <id> --record]
      Run the blind dual-persona review panel on a draft

  outreach [--persona <HIRING_MANAGER|RECRUITER|PEER>] [--job-id <id>] [--json]
      Draft a <=300 character outreach message (draft only, never sent)

  interview-story [--job-id <id>] [--dossier <path>] [--out <file>] [--json]
      Compile a STAR+R interview preparation pack from verified stories

  ksa-offer (--gross <sar> | --basic <n> --housing <n> --transport <n>) [--tenure <years>] [--saudi]
      Compute Saudi salary structure, GOSI, and end-of-service benefits

  cadence [--submitted <iso-date>] [--json] [--workspace <dir>]
      Evaluate 7/14-day follow-up cadence for submitted applications

  mcp [--workspace <dir>]
      Start native Model Context Protocol (MCP) JSON-RPC 2.0 stdio server

  claim verify --dossier <d> --draft <p> [--json]
      Run deterministic AST claim verification (Milestone M3)

  review record --job-id <i> --verdict <v> --notes <n>
      Record blind review panel evaluation (Milestone M3)

  review-record --job-id <i> --verdict <v> --notes <n>
      Alias for review record

  ui [--port <port>] [--token <tok>] [--workspace <dir>] [--no-open]
      Launch local token-authenticated web Command Center (127.0.0.1)

  export [--out <file>] [--workspace <dir>] [--json]
      Generate standalone offline single-file HTML dashboard snapshot

  companion ingest [--dir <path>] [--watch] [--workspace <dir>]
      Scan and ingest proposals from inbox/proposals/ into ledger

  companion sweep [--dir <path>] [--workspace <dir>]
      Alias for companion ingest (one-off ingestion sweep)

  companion watch [--dir <path>] [--workspace <dir>]
      Alias for companion ingest --watch (continuous monitoring mode)

  companion status [--dir <path>] [--workspace <dir>] [--json]
      Report queue counts for pending, processed, and errored companion proposals

  contact add --name <n> [--company <c>] [--persona <p>] [--role <r>] [--email <e>] [--linkedin <url>] [--job-id <id>] [--notes <text>] [--json] [--workspace <dir>]
      Add a local recruiter contact to .crew/contacts.jsonl

  contact list [--company <c>] [--persona <p>] [--job-id <id>] [--json] [--workspace <dir>]
      List local contacts, optionally filtered

  contact get (--id <id> | --name <n> | <id>) [--json] [--workspace <dir>]
      Show one local contact by id or name

  tool list | tool <name> [--args <json> | --args-file <path>] [--workspace <dir>]
      Run any crew_* MCP tool from the shell (for hosts without the MCP server)

  help
      Show this help message

Flags:
  -v, --version                       Print current CLI version
  -h, --help                          Show this help message
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('-v') || args.includes('--version')) {
    console.log(VERSION);
    process.exit(0);
  }

  const command = args[0];
  const restArgs = args.slice(1);

  try {
    switch (command) {
      case 'help':
        showHelp();
        process.exit(0);
        break;

      case 'init':
        process.exit(runInit(restArgs));
        break;

      case 'doctor':
        process.exit(await runDoctor(restArgs));
        break;

      case 'alerts':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing alerts subcommand (closing-soon)');
          process.exit(1);
        }
        process.exit(await runAlerts(restArgs[0], restArgs.slice(1)));
        break;

      case 'retro':
        process.exit(await runRetro(restArgs));
        break;

      case 'editorial':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing editorial subcommand (list|learn|undo|apply)');
          process.exit(1);
        }
        process.exit(await runEditorial(restArgs[0], restArgs.slice(1)));
        break;

      case 'migrate':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing migrate subcommand (legacy)');
          process.exit(1);
        }
        process.exit(await runMigrate(restArgs[0], restArgs.slice(1)));
        break;

      case 'ledger':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing ledger subcommand (append|replay)');
          process.exit(1);
        }
        process.exit(await runLedger(restArgs[0], restArgs.slice(1)));
        break;

      case 'job':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing job subcommand (add|triage|close|submit)');
          process.exit(1);
        }
        process.exit(await runJob(restArgs[0], restArgs.slice(1)));
        break;

      case 'backup':
        process.exit(await runBackup(restArgs));
        break;

      case 'restore':
        process.exit(await runRestore(restArgs));
        break;

      case 'mcp':
        runMcp(restArgs);
        break;

      case 'claim':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing claim subcommand (verify)');
          process.exit(1);
        }
        process.exit(await runClaim(restArgs[0], restArgs.slice(1)));
        break;

      case 'review':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing review subcommand (record)');
          process.exit(1);
        }
        process.exit(await runReview(restArgs[0], restArgs.slice(1)));
        break;

      case 'review-record':
        process.exit(await runReview('record', restArgs));
        break;

      case 'apply-pack':
        process.exit(await runApplyPack(restArgs));
        break;

      case 'blind-review':
        process.exit(await runBlindReview(restArgs));
        break;

      case 'outreach':
        process.exit(await runOutreach(restArgs));
        break;

      case 'interview-story':
        process.exit(await runInterviewStory(restArgs));
        break;

      case 'ksa-offer':
        process.exit(await runKsaOffer(restArgs));
        break;

      case 'cadence':
        process.exit(await runCadence(restArgs));
        break;

      case 'discover':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing discover subcommand (sweep|smoke)');
          process.exit(1);
        }
        process.exit(await runDiscover(restArgs[0], restArgs.slice(1)));
        break;

      case 'ui': {
        const rc = await runUi(restArgs);
        if (rc) process.exit(rc); // e.g. port in use; success keeps the server running
        break;
      }

      case 'export':
        process.exit(await runExport(restArgs));
        break;

      case 'companion':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing companion subcommand (ingest|status|sweep|watch)');
          process.exit(1);
        }
        process.exit(await runCompanion(restArgs[0], restArgs.slice(1)));
        break;

      case 'contact':
        if (restArgs.length === 0) {
          console.error('[ERROR] Missing contact subcommand (add|list|get)');
          process.exit(1);
        }
        process.exit(await runContact(restArgs[0], restArgs.slice(1)));
        break;

      case 'tool':
        // exitCode, not exit(): large JSON on a Windows pipe is written async and would be cut off.
        process.exitCode = await runTool(restArgs);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`[UNHANDLED ERROR] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  VERSION,
  parseArgs,
  resolveWorkspace,
  showHelp,
  runInit,
  runDoctor,
  runLedger,
  runJob,
  runDiscover,
  runAlerts,
  runRetro,
  runEditorial,
  runMigrate,
  runApplyPack,
  runBlindReview,
  runOutreach,
  runInterviewStory,
  runKsaOffer,
  runCadence,
  runBackup,
  runRestore,
  runMcp,
  runClaim,
  runReview,
  runUi,
  runExport,
  runCompanion,
  runContact,
  runTool
};
