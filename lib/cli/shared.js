'use strict';

/**
 * JobHunt Crew — Shared CLI Parsing Utilities
 *
 * Zero external dependencies. Uses Node.js built-in runtime and core modules.
 *
 * @module lib/cli/shared
 */

const path = require('path');

const VERSION = '0.2.1';

function parseArgs(rawArgs) {
  const flags = {};
  const positional = [];

  const setFlag = (key, val) => {
    const camelKey = key.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    flags[key] = val;
    flags[camelKey] = val;
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key.includes('=')) {
        const [k, v] = key.split('=', 2);
        setFlag(k, v);
      } else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
        setFlag(key, rawArgs[++i]);
      } else {
        setFlag(key, true);
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
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
  const ws = flags.workspace || flags.w;
  return ws ? path.resolve(ws) : process.cwd();
}

module.exports = {
  VERSION,
  parseArgs,
  resolveWorkspace
};
