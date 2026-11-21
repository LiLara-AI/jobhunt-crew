'use strict';

/**
 * JobHunt Crew — Shared CLI Parsing Utilities
 *
 * Zero external dependencies. Uses Node.js built-in runtime and core modules.
 *
 * @module lib/cli/shared
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '0.2.10';

function parseArgs(rawArgs) {
  const flags = {};
  const positional = [];

  const setFlag = (key, val) => {
    const camelKey = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    flags[key] = val;
    flags[camelKey] = val;
  };

  // Only "-x"/"--xyz" start a new flag, so values like "-", "-5" or "- led team" stay values.
  const isFlag = (tok) => /^--?[A-Za-z]/.test(tok);

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key.includes('=')) {
        const eq = key.indexOf('=');
        setFlag(key.slice(0, eq), key.slice(eq + 1)); // keep later '=' (URLs, JSON)
      } else if (i + 1 < rawArgs.length && !isFlag(rawArgs[i + 1])) {
        setFlag(key, rawArgs[++i]);
      } else {
        setFlag(key, true);
      }
    } else if (isFlag(arg)) {
      const key = arg.slice(1);
      if (i + 1 < rawArgs.length && !isFlag(rawArgs[i + 1])) {
        setFlag(key, rawArgs[++i]);
      } else {
        setFlag(key, true);
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

// The folder holding this package (bin/, lib/, package.json): never a job-hunt workspace.
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function samePath(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
  const [x, y] = [real(a), real(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Hosts launch the CLI and MCP server from an arbitrary cwd (often the plugin
 * folder or the home directory), where .crew/ must never be created.
 * Returns the refusal message for such a folder, or null when it is usable.
 * CREW_ALLOW_PLUGIN_WORKSPACE=1 lets this repo's own tests and scripts use the plugin root.
 */
function workspaceRefusal(dir) {
  const isPlugin = samePath(dir, PLUGIN_ROOT) && process.env.CREW_ALLOW_PLUGIN_WORKSPACE !== '1';
  const isHome = samePath(dir, os.homedir());
  if (!isPlugin && !isHome) return null;
  return `WORKSPACE_REFUSED: "${dir}" is ${isPlugin ? 'the JobHunt Crew plugin folder' : 'your home directory'}, not a job-hunt workspace. ` +
    'Pass --workspace <folder> or set CREW_WORKSPACE to the folder that holds (or should hold) your job hunt.';
}

// An MCP server must still start in a refused folder: McpServer re-checks and
// returns the refusal from every tool call instead of dying before the host connects.
function isMcpLaunch() {
  const main = require.main ? path.basename(require.main.filename || '') : '';
  return main === 'crew-mcp.js' || (main === 'crew.js' && process.argv[2] === 'mcp');
}

function resolveWorkspace(flags = {}, { guard = !isMcpLaunch() } = {}) {
  // Precedence: flag, then CREW_WORKSPACE (host MCP configs pin it regardless of launch cwd), then cwd.
  const ws = flags.workspace || flags.w || process.env.CREW_WORKSPACE;
  const dir = typeof ws === 'string' && ws ? path.resolve(ws) : process.cwd();
  const refusal = guard ? workspaceRefusal(dir) : null;
  if (refusal) throw new Error(refusal);
  return dir;
}

module.exports = {
  VERSION,
  parseArgs,
  resolveWorkspace,
  workspaceRefusal,
  PLUGIN_ROOT
};
