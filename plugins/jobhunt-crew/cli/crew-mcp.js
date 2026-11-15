#!/usr/bin/env node
'use strict';

/**
 * JobHunt Crew — Native MCP Server Executable
 *
 * Runs the JobHunt Crew Model Context Protocol (MCP) server.
 * Usage:
 *   node bin/crew-mcp.js [--workspace <dir>]                     stdio (Claude, Codex, Kimi, Gemini)
 *   node bin/crew-mcp.js --http [--port 8787] [--token <secret>] [--workspace <dir>]
 *                                                                 HTTP for remote-only hosts (ChatGPT)
 * The workspace defaults to $CREW_WORKSPACE, then the current directory.
 */

const crypto = require('crypto');
const { McpServer } = require('../lib/mcp/server');
const { parseArgs, resolveWorkspace } = require('../lib/cli/shared');

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const server = new McpServer({ workspace: resolveWorkspace(flags) });

  if (!flags.http) {
    server.start();
    return;
  }

  const token = typeof flags.token === 'string' ? flags.token : (process.env.CREW_MCP_TOKEN || crypto.randomBytes(24).toString('hex'));
  const port = flags.port === undefined ? 8787 : Number(flags.port);
  server.startHttp({ port, token }).then((srv) => {
    const url = `http://127.0.0.1:${srv.address().port}/mcp/${token}`;
    process.stderr.write(`[MCP] Workspace: ${server.workspace}\n[MCP] Local URL (keep the token secret): ${url}\n`);
  }).catch((err) => {
    process.stderr.write(`[MCP] Failed to start HTTP transport: ${err.message}\n`);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = { main };
