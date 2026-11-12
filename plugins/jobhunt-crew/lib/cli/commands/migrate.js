'use strict';

/**
 * JobHunt Crew — CLI Legacy Migration Command
 *
 * Wires `crew migrate legacy` to lib/operational/migrate-legacy (owned by
 * Workstream D). The module is lazy-required so the CLI keeps working while
 * the migration engine is still in flight.
 *
 * @module lib/cli/commands/migrate
 */

const path = require('path');
const { parseArgs, resolveWorkspace } = require('../shared');

function loadMigrator() {
  const mod = require('../../operational/migrate-legacy');
  if (typeof mod.migrateLegacy === 'function') return mod.migrateLegacy;
  if (typeof mod.migrate === 'function') return mod.migrate;
  if (typeof mod.runMigration === 'function') return mod.runMigration;
  if (typeof mod === 'function') return mod;
  throw new Error('lib/operational/migrate-legacy does not export a migration function');
}

async function runMigrate(subcommand, rawArgs = []) {
  if (subcommand !== 'legacy') {
    console.error(`[ERROR] Unknown migrate subcommand: ${subcommand || ''}. Usage: crew migrate legacy [--from <dir>] [--workspace <dir>]`);
    return 1;
  }
  const { flags } = parseArgs(rawArgs);
  const targetDir = resolveWorkspace(flags);
  const fromDir = flags.from ? path.resolve(flags.from) : undefined;

  let migrateLegacy;
  try {
    migrateLegacy = loadMigrator();
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      console.error('[MIGRATE] Legacy migration engine not available yet (lib/operational/migrate-legacy missing).');
    } else {
      console.error(`[MIGRATE] Failed to load migration engine: ${err.message}`);
    }
    return 1;
  }

  try {
    const result = await migrateLegacy({
      from: fromDir,
      fromDir,
      legacyDir: fromDir,
      workspaceDir: targetDir,
      workspace: targetDir,
      force: flags.force === true,
      dryRun: flags.dryRun === true || flags['dry-run'] === true
    });
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('[MIGRATE] Legacy migration complete.');
      if (result && typeof result === 'object') {
        console.log(JSON.stringify(result, null, 2));
      }
    }
    return 0;
  } catch (err) {
    console.error(`[MIGRATE] Failed: ${err.message}`);
    return 1;
  }
}

module.exports = {
  runMigrate
};
