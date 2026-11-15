'use strict';

/**
 * JobHunt Crew — Shared CLI Parsing Utilities
 *
 * Zero external dependencies. Uses Node.js built-in runtime and core modules.
 *
 * @module lib/cli/shared
 */

const path = require('path');

const VERSION = '0.2.3';

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

function resolveWorkspace(flags) {
  // CREW_WORKSPACE lets host MCP configs pin the workspace regardless of the launch cwd.
  const ws = flags.workspace || flags.w || process.env.CREW_WORKSPACE;
  return typeof ws === 'string' && ws ? path.resolve(ws) : process.cwd();
}

module.exports = {
  VERSION,
  parseArgs,
  resolveWorkspace
};
