'use strict';

/**
 * `crew tool` — runs any crew_* MCP tool from the shell with the exact same
 * handler, for hosts where the MCP server is not registered (Cowork, Codex or
 * Kimi without MCP, plain terminals).
 *
 *   crew tool list
 *   crew tool <name> [--args '<json>' | --args-file <path>] [--workspace <dir>]
 */

const fs = require('fs');
const { parseArgs, resolveWorkspace } = require('../shared');

async function runTool(rawArgs = []) {
  const { positional, flags } = parseArgs(rawArgs);
  const name = positional[0];
  if (!name) {
    console.error('[ERROR] Usage: crew tool <name|list> [--args <json> | --args-file <path>] [--workspace <dir>]');
    return 1;
  }

  const { McpServer } = require('../../mcp/server');
  const server = new McpServer({ workspace: resolveWorkspace(flags) });

  if (name === 'list') {
    for (const t of server.tools.values()) {
      const required = (t.inputSchema && t.inputSchema.required) || [];
      const props = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
      console.log(`${t.name}  args: ${props.map(p => (required.includes(p) ? p + '*' : p)).join(', ') || '(none)'}`);
    }
    return 0;
  }

  let args = {};
  try {
    // --args-file avoids shell-quoting JSON (PowerShell/cmd mangle inline quotes).
    const raw = typeof flags.argsFile === 'string' ? fs.readFileSync(flags.argsFile, 'utf8')
      : (typeof flags.args === 'string' ? flags.args : '{}');
    args = JSON.parse(raw);
  } catch (err) {
    console.error(`[ERROR] Invalid tool arguments JSON: ${err.message}`);
    return 1;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    console.error('[ERROR] Tool arguments must be a JSON object');
    return 1;
  }

  try {
    const result = await server.callTool(name, args);
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    console.error(`[ERROR] ${err.message || String(err)}`);
    return 1;
  }
}

module.exports = { runTool };
